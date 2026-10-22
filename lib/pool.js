/**
 * 账号池：多个 WorkBuddy 账号的增删、主账号切换、token 续期、失败冷却与自动换号。
 *
 * 设计约束：
 * - token 存在 DSH credentials 记录里（`dsh-workbuddy/<provider>-<id>`，见 tokens.js），
 *   插件状态文件只保留账号元数据；没有 credentials 服务时才回退 state 明文。
 * - 「自动换号」只发生在请求尚未向模型产出任何内容之前；401 先尝试 refresh，
 *   刷新失败才冷却并换号；排队码（6020/6021/6022）不换号。
 * - 主动切换（用户在设置卡片里选主账号）与被动换号（冷却）分开记录。
 * @module dsh-workbuddy/pool
 */

import {
  checkin as apiCheckin,
  checkinStatus as apiCheckinStatus,
  enterpriseSummary as apiEnterpriseSummary,
  listAccounts as apiListAccounts,
  refreshAccessToken,
  resourceSummary as apiResourceSummary,
  switchAccount as apiSwitchAccount,
} from './api.js'
import { providerState } from './state.js'
import { stripTokens, tokensOf } from './tokens.js'

/** 配额类失败后的冷却时长。 */
const QUOTA_COOLDOWN_MS = 5 * 60_000
/** 鉴权失败后的冷却时长（等用户重新登录）。 */
const AUTH_COOLDOWN_MS = 30 * 60_000
/** access token 提前续期窗口。 */
const REFRESH_WINDOW_MS = 60_000

/**
 * 生成账号指纹：同一 uid 在同一 provider 下只保留一条。
 * @param {any} account
 * @param {any} auth
 */
function accountId(account, auth) {
  const uid = typeof account?.uid === 'string' && account.uid !== '' ? account.uid : undefined
  if (uid !== undefined) return uid
  const fromAuth = typeof auth?.uid === 'string' && auth.uid !== '' ? auth.uid : undefined
  return fromAuth ?? `account-${Date.now().toString(36)}`
}

/**
 * 把登录返回的 auth 快照归一成账号记录。token 字段是临时的：
 * `AccountPool.upsert()` 会把它们写进 credentials，并从 state 里移除。
 * @param {any} account
 * @param {any} auth
 * @param {{ source?: string }} [meta]
 */
export function accountFromAuth(account, auth, meta = {}) {
  const expiresAt = typeof auth?.expiresAt === 'number'
    ? auth.expiresAt
    : typeof auth?.expiresIn === 'number'
      ? Date.now() + auth.expiresIn * 1000
      : undefined
  return {
    id: accountId(account, auth),
    uid: typeof account?.uid === 'string' ? account.uid : undefined,
    nickname: typeof account?.nickname === 'string' ? account.nickname : undefined,
    uin: typeof account?.uin === 'string' ? account.uin : undefined,
    accountType: typeof account?.type === 'string' ? account.type : undefined,
    enterpriseId: typeof account?.enterpriseId === 'string' && account.enterpriseId !== '' ? account.enterpriseId : undefined,
    enterpriseName: typeof account?.enterpriseName === 'string' ? account.enterpriseName : undefined,
    editionType: typeof account?.editionType === 'string' ? account.editionType : undefined,
    accessToken: String(auth?.accessToken ?? ''),
    refreshToken: typeof auth?.refreshToken === 'string' ? auth.refreshToken : undefined,
    expiresAt,
    addedAt: Date.now(),
    source: meta.source ?? 'browser-login',
    cooldownUntil: 0,
    needsLogin: false,
  }
}

/**
 * 对外可见的账号快照（不含 token）。
 * @param {any} account
 * @param {string|null} activeAccountId
 */
export function accountView(account, activeAccountId) {
  return {
    id: account.id,
    uid: account.uid,
    nickname: account.nickname,
    uin: account.uin,
    accountType: account.accountType,
    enterpriseId: account.enterpriseId,
    enterpriseName: account.enterpriseName,
    editionType: account.editionType,
    active: account.id === activeAccountId,
    cooling: (account.cooldownUntil ?? 0) > Date.now(),
    cooldownUntil: account.cooldownUntil ?? 0,
    needsLogin: account.needsLogin === true,
    expiresAt: account.expiresAt ?? null,
    source: account.source,
  }
}

/** 账号池。 */
export class AccountPool {
  /**
   * @param {any} state - 插件状态（会被原地修改并由调用方持久化）
   * @param {(state: any) => Promise<void>} persist
   * @param {{ logger?: any, tokens?: import('./tokens.js').TokenStore }} [deps]
   */
  constructor(state, persist, deps = {}) {
    this.state = state
    this.persist = persist
    this.logger = deps.logger
    this.tokens = deps.tokens ?? null
    /** @type {Map<string, Promise<any>>} 每个账号同一时刻只跑一次续期 */
    this.refreshing = new Map()
  }

  /** @param {string} providerId */
  slice(providerId) {
    return providerState(this.state, providerId)
  }

  /** @param {string} providerId */
  list(providerId) {
    return this.slice(providerId).accounts
  }

  /**
   * 主账号：显式选择优先；否则第一个不在冷却、不需要重登的账号；再否则第一个账号。
   * @param {string} providerId
   * @returns {any|null}
   */
  active(providerId) {
    const slice = this.slice(providerId)
    const accounts = slice.accounts
    if (accounts.length === 0) return null
    const explicit = accounts.find((account) => account.id === slice.activeAccountId)
    if (explicit !== undefined && explicit.needsLogin !== true) return explicit
    const healthy = accounts.find((account) => account.needsLogin !== true && (account.cooldownUntil ?? 0) <= Date.now())
    if (healthy !== undefined) return healthy
    return explicit ?? accounts[0]
  }

  /**
   * 下一次可用的账号（自动换号）：跳过当前账号与冷却中/需重登的账号。
   * @param {string} providerId
   * @param {string} [excludeId]
   * @returns {any|null}
   */
  next(providerId, excludeId) {
    return this.slice(providerId).accounts.find((account) => (
      account.id !== excludeId
      && account.needsLogin !== true
      && (account.cooldownUntil ?? 0) <= Date.now()
    )) ?? null
  }

  /**
   * 把旧 state 内的明文 token 迁进 credentials，并从 state 删除。
   * @returns {Promise<void>}
   */
  async migrate() {
    if (this.tokens === null || this.tokens.secure !== true) return
    let migrated = 0
    for (const providerId of Object.keys(this.state.providers ?? {})) {
      for (const account of this.slice(providerId).accounts) {
        if (tokensOf(account) === null) continue
        try {
          if (await this.tokens.migrateLegacy(providerId, account)) migrated += 1
        } catch (error) {
          this.logger?.warn?.(`WorkBuddy: 迁移 ${account.id} 的 token 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (migrated > 0) {
      await this.persist(this.state)
      this.logger?.info?.(`WorkBuddy: 已把 ${String(migrated)} 个账号的 token 迁入 credentials`)
    }
  }

  /**
   * 新增或更新账号：token 写入 credentials，state 只保留元数据。
   * @param {string} providerId
   * @param {any} record
   * @returns {Promise<any>} 合并后的账号（无 token 字段）
   */
  async upsert(providerId, record) {
    const slice = this.slice(providerId)
    const tokens = tokensOf(record)
    let clean = stripTokens(record)
    const index = slice.accounts.findIndex((account) => account.id === record.id)
    if (index >= 0) {
      const previous = slice.accounts[index]
      clean = {
        ...previous,
        ...clean,
        addedAt: previous.addedAt ?? clean.addedAt,
        expiresAt: tokens?.expiresAt ?? clean.expiresAt,
        cooldownUntil: 0,
        needsLogin: false,
      }
      slice.accounts[index] = clean
    } else {
      clean = { ...clean, cooldownUntil: 0, needsLogin: false }
      slice.accounts.push(clean)
    }
    if (slice.activeAccountId === null || slice.activeAccountId === undefined) slice.activeAccountId = record.id
    // 账号元数据先落位：credentials 不可用时的回退写需要能找到这条账号。
    if (tokens !== null) {
      if (this.tokens !== null) {
        await this.tokens.write(providerId, record.id, tokens)
      } else {
        const stored = slice.accounts.find((account) => account.id === record.id)
        if (stored !== undefined) {
          stored.accessToken = tokens.accessToken
          if (typeof tokens.refreshToken === 'string') stored.refreshToken = tokens.refreshToken
          if (typeof tokens.expiresAt === 'number') stored.expiresAt = tokens.expiresAt
        }
      }
    }
    await this.persist(this.state)
    return clean
  }

  /**
   * 删除账号及其 credentials 记录。
   * @param {string} providerId
   * @param {string} id
   */
  async remove(providerId, id) {
    const slice = this.slice(providerId)
    slice.accounts = slice.accounts.filter((account) => account.id !== id)
    if (slice.activeAccountId === id) {
      slice.activeAccountId = slice.accounts[0]?.id ?? null
    }
    if (this.tokens !== null) await this.tokens.remove(providerId, id)
    await this.persist(this.state)
  }

  /**
   * 显式切换主账号。
   * @param {string} providerId
   * @param {string} id
   */
  select(providerId, id) {
    const slice = this.slice(providerId)
    if (!slice.accounts.some((account) => account.id === id)) {
      throw new Error(`账号 ${id} 不存在`)
    }
    slice.activeAccountId = id
  }

  /**
   * 读 token：credentials 优先，旧 state 字段兜底并顺手迁移。
   * @param {string} providerId
   * @param {any} account
   * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt?: number } | null>}
   */
  async readTokens(providerId, account) {
    if (this.tokens !== null) {
      const stored = await this.tokens.read(providerId, account.id)
      if (stored !== null) return stored
      if (this.tokens.secure === true) {
        try {
          await this.tokens.migrateLegacy(providerId, account)
        } catch {
          // 迁移失败不影响后续 401 分支。
        }
      }
    }
    return tokensOf(account)
  }

  /**
   * 取一个可用凭据，必要时先续期。
   * @param {string} providerId
   * @param {any} account
   * @returns {Promise<{ account: any, credentials: { accessToken: string, refreshToken?: string, uid?: string, enterpriseId?: string } }>}
   */
  async credentialsFor(providerId, account) {
    const tokens = await this.readTokens(providerId, account)
    if (tokens === null) {
      account.needsLogin = true
      await this.persist(this.state)
      throw new Error(`账号 ${account.nickname ?? account.id} 没有可用的 token，请重新登录`)
    }
    const fresh = await this.ensureFreshTokens(providerId, account, tokens)
    return {
      account,
      credentials: {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        uid: account.uid,
        enterpriseId: account.enterpriseId,
      },
    }
  }

  /**
   * 401 后强制刷新一次；失败返回 null 并标记 needsLogin。
   * @param {string} providerId
   * @param {any} account
   * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt?: number } | null>}
   */
  async tryRefresh(providerId, account) {
    const tokens = await this.readTokens(providerId, account)
    if (tokens === null || typeof tokens.refreshToken !== 'string' || tokens.refreshToken === '') return null
    try {
      return await this.refreshTokens(providerId, account, tokens)
    } catch (error) {
      this.logger?.warn?.(`WorkBuddy: 账号 ${account.nickname ?? account.id} 强制续期失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * 续期到有效 access token（提前窗口内才刷新）。
   * @param {string} providerId
   * @param {any} account
   * @param {{ accessToken: string, refreshToken?: string, expiresAt?: number }} tokens
   */
  async ensureFreshTokens(providerId, account, tokens) {
    const valid = typeof tokens.expiresAt !== 'number' || tokens.expiresAt - Date.now() > REFRESH_WINDOW_MS
    if (valid) return tokens
    if (typeof tokens.refreshToken !== 'string' || tokens.refreshToken === '') {
      account.needsLogin = true
      await this.persist(this.state)
      throw new Error(`账号 ${account.nickname ?? account.id} 的登录已过期，请重新登录`)
    }
    return this.refreshTokens(providerId, account, tokens)
  }

  /**
   * 用 refresh token 换新 token 并写回 credentials。
   * @param {string} providerId
   * @param {any} account
   * @param {{ accessToken: string, refreshToken?: string, expiresAt?: number }} tokens
   */
  async refreshTokens(providerId, account, tokens) {
    const key = `${providerId}:${account.id}`
    const running = this.refreshing.get(key)
    if (running !== undefined) return running
    const task = (async () => {
      const auth = await refreshAccessToken(providerId, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        uid: account.uid,
        enterpriseId: account.enterpriseId,
      })
      if (typeof auth?.accessToken !== 'string' || auth.accessToken === '') {
        account.needsLogin = true
        await this.persist(this.state)
        throw new Error(`账号 ${account.nickname ?? account.id} 续期失败，请重新登录`)
      }
      const next = {
        accessToken: auth.accessToken,
        ...typeof auth.refreshToken === 'string' && auth.refreshToken !== ''
          ? { refreshToken: auth.refreshToken }
          : tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken },
        ...typeof auth.expiresAt === 'number'
          ? { expiresAt: auth.expiresAt }
          : typeof auth.expiresIn === 'number'
            ? { expiresAt: Date.now() + auth.expiresIn * 1000 }
            : tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt },
      }
      if (this.tokens !== null) {
        await this.tokens.write(providerId, account.id, next)
      } else {
        account.accessToken = next.accessToken
        if (typeof next.refreshToken === 'string') account.refreshToken = next.refreshToken
      }
      if (typeof next.expiresAt === 'number') account.expiresAt = next.expiresAt
      account.needsLogin = false
      await this.persist(this.state)
      return next
    })()
    this.refreshing.set(key, task)
    try {
      return await task
    } finally {
      this.refreshing.delete(key)
    }
  }

  /**
   * 记录一次失败并按类别冷却。
   * @param {string} providerId
   * @param {any} account
   * @param {'auth'|'quota'|'rate-limit'|'queue'|'other'} kind
   */
  async reportFailure(providerId, account, kind) {
    if (kind === 'auth') {
      account.needsLogin = true
      account.cooldownUntil = Date.now() + AUTH_COOLDOWN_MS
    } else if (kind === 'quota') {
      account.cooldownUntil = Date.now() + QUOTA_COOLDOWN_MS
    } else if (kind === 'rate-limit') {
      account.cooldownUntil = Date.now() + 60_000
    } else {
      return
    }
    await this.persist(this.state)
  }

  /**
   * 账号成功响应后清冷却。
   * @param {string} providerId
   * @param {any} account
   */
  async reportSuccess(providerId, account) {
    if ((account.cooldownUntil ?? 0) === 0) return
    account.cooldownUntil = 0
    await this.persist(this.state)
  }

  /**
   * 从上游刷新「这个 token 可见的账号列表」。
   * @param {string} providerId
   * @param {any} account
   * @returns {Promise<any[]>}
   */
  async syncAccounts(providerId, account) {
    const { credentials } = await this.credentialsFor(providerId, account)
    return apiListAccounts(providerId, credentials)
  }

  /**
   * 通过上游切换企业/个人身份，写回账号凭据。
   * @param {string} providerId
   * @param {any} account
   * @param {any} target
   */
  async switchIdentity(providerId, account, target) {
    const { credentials } = await this.credentialsFor(providerId, account)
    const auth = await apiSwitchAccount(providerId, credentials, target)
    if (typeof auth?.accessToken === 'string' && auth.accessToken !== '') {
      const tokens = {
        accessToken: auth.accessToken,
        ...typeof auth.refreshToken === 'string' && auth.refreshToken !== ''
          ? { refreshToken: auth.refreshToken }
          : typeof credentials.refreshToken === 'string' ? { refreshToken: credentials.refreshToken } : {},
        ...typeof auth.expiresAt === 'number'
          ? { expiresAt: auth.expiresAt }
          : typeof auth.expiresIn === 'number'
            ? { expiresAt: Date.now() + auth.expiresIn * 1000 }
            : {},
      }
      if (this.tokens !== null) await this.tokens.write(providerId, account.id, tokens)
      if (typeof tokens.expiresAt === 'number') account.expiresAt = tokens.expiresAt
      await this.persist(this.state)
    }
    return auth
  }

  /**
   * 查额度：个人走资源汇总，企业走企业用量。
   * @param {string} providerId
   * @param {any} account
   */
  async fetchCredits(providerId, account) {
    const { credentials } = await this.credentialsFor(providerId, account)
    if (account.enterpriseId) {
      const enterprise = await apiEnterpriseSummary(providerId, credentials)
      return { kind: 'enterprise', ...enterprise }
    }
    const personal = await apiResourceSummary(providerId, credentials)
    return { kind: 'personal', ...personal }
  }

  /**
   * 查签到状态。
   * @param {string} providerId
   * @param {any} account
   */
  async fetchCheckinStatus(providerId, account) {
    const { credentials } = await this.credentialsFor(providerId, account)
    return apiCheckinStatus(providerId, credentials)
  }

  /**
   * 签到。
   * @param {string} providerId
   * @param {any} account
   */
  async doCheckin(providerId, account) {
    const { credentials } = await this.credentialsFor(providerId, account)
    return apiCheckin(providerId, credentials)
  }
}
