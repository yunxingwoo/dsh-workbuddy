/**
 * 业务服务：把 state / api / pool / catalog 串成 Host 与客户端共用的一组动作。
 * 路由层只做 HTTP 形状，客户端只做展示；所有状态变化都经过这里统一持久化。
 * @module dsh-workbuddy/service
 */

import {
  PROVIDERS,
  WorkBuddyApiError,
  currentAccount,
  pollBrowserLogin,
  productConfig,
  startBrowserLogin,
} from './api.js'
import { effectiveModels, modelsFromProductConfig, normalizeModels, parseCreditMultiplier, readLocalProductConfig } from './catalog.js'
import { AccountPool, accountFromAuth, accountView } from './pool.js'
import { loadState, providerState, saveState } from './state.js'
import { TokenStore } from './tokens.js'

/** 目录刷新最短间隔（防止 UI 连点打爆上游）。 */
const CATALOG_MIN_INTERVAL_MS = 30_000

/** WorkBuddy 业务服务。 */
export class WorkBuddyService {
  /**
   * @param {object} deps
   * @param {any} deps.ctx - cordis host context
   * @param {any} deps.config - 插件配置（可含 refreshMinutes / autoCheckin / requestTimeoutSeconds）
   * @param {any} [deps.logger]
   */
  constructor(deps) {
    this.ctx = deps.ctx
    this.config = deps.config ?? {}
    this.logger = deps.logger
    this.state = null
    this.pool = null
    /** @type {Map<string, { providerId: string, authUrl: string, startedAt: number }>} */
    this.logins = new Map()
    /** @type {Map<string, Promise<any>>} */
    this.refreshing = new Map()
  }

  /** 初始化：读状态，建账号池。 */
  async init() {
    this.state = await loadState()
    this.tokens = new TokenStore({
      credentialsSource: () => {
        try {
          return this.ctx.get('credentials')
        } catch {
          return undefined
        }
      },
      state: this.state,
      persist: () => this.persist(),
      logger: this.logger,
    })
    this.pool = new AccountPool(this.state, () => this.persist(), { logger: this.logger, tokens: this.tokens })
    await this.pool.migrate()
  }

  /** 持久化状态；credentials 可用时确保 state 里没有 token 字段。 */
  async persist() {
    await saveState(this.state, { stripSecrets: this.tokens?.secure === true })
  }

  /** 当前启用的目录模型（未初始化时返回空数组）。 */
  catalog(providerId) {
    if (this.state === null) return []
    const slice = providerState(this.state, providerId)
    return effectiveModels(slice.catalog?.models ?? [], slice.modelSettings ?? {})
  }

  /** 客户端首屏快照（不含 token）。 */
  snapshot() {
    const providers = []
    for (const providerId of Object.keys(PROVIDERS)) {
      const slice = providerState(this.state ?? { version: 1, providers: {} }, providerId)
      const active = this.pool?.active(providerId) ?? null
      const catalogModels = slice.catalog?.models ?? []
      providers.push({
        id: providerId,
        displayName: PROVIDERS[providerId].displayName,
        endpoint: PROVIDERS[providerId].endpoint,
        accounts: slice.accounts.map((account) => accountView(account, slice.activeAccountId)),
        activeAccountId: slice.activeAccountId ?? null,
        activeAccount: active === null ? null : accountView(active, slice.activeAccountId),
        models: catalogModels.map((model) => {
          const setting = slice.modelSettings?.[model.id] ?? {}
          return {
            ...model,
            enabled: setting.enabled !== false,
            image: setting.image === undefined ? model.supportsImages : setting.image === true,
          }
        }),
        modelCount: catalogModels.length,
        catalog: slice.catalog === null || slice.catalog === undefined ? null : {
          fetchedAt: slice.catalog.fetchedAt,
          source: slice.catalog.source,
          path: slice.catalog.path,
        },
        credits: slice.credits ?? null,
        checkin: slice.checkin ?? null,
        login: this.loginStatus(providerId),
      })
    }
    return { providers, config: this.publicConfig() }
  }

  /** 公开配置（避免把任意配置项透给客户端）。 */
  publicConfig() {
    return {
      refreshMinutes: Number(this.config?.refreshMinutes) || 30,
      autoCheckin: this.config?.autoCheckin === true,
    }
  }

  /** 当前浏览器登录流程状态。 */
  loginStatus(providerId) {
    for (const [state, session] of this.logins) {
      if (session.providerId === providerId) {
        return { state, authUrl: session.authUrl, startedAt: session.startedAt, pending: true }
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------

  /**
   * 开始浏览器登录：返回 authUrl，用户在浏览器完成登录后调用 pollLogin。
   * @param {string} providerId
   */
  async loginStart(providerId) {
    const { state, authUrl } = await startBrowserLogin(providerId)
    // 同一 provider 只保留最新的登录流程。
    for (const [key, session] of this.logins) {
      if (session.providerId === providerId) this.logins.delete(key)
    }
    this.logins.set(state, { providerId, authUrl, startedAt: Date.now() })
    return { state, authUrl }
  }

  /**
   * 轮询登录结果；成功后写入账号池、拉额度与目录。
   * @param {string} providerId
   * @param {string} state
   */
  async loginPoll(providerId, state) {
    const session = this.logins.get(state)
    if (session === undefined) {
      return { pending: false, error: '登录流程已过期，请重新发起' }
    }
    let result
    try {
      result = await pollBrowserLogin(providerId, state)
    } catch (error) {
      if (session.startedAt + 5 * 60_000 < Date.now()) {
        this.logins.delete(state)
        return { pending: false, error: `登录轮询失败：${error instanceof Error ? error.message : String(error)}` }
      }
      return { pending: true }
    }
    if (result.pending) {
      if (session.startedAt + 5 * 60_000 < Date.now()) {
        this.logins.delete(state)
        return { pending: false, error: '登录超时，请重新发起' }
      }
      return { pending: true }
    }
    this.logins.delete(state)
    const auth = result.auth
    let account = null
    try {
      account = await currentAccount(providerId, {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        uid: auth.uid,
        enterpriseId: auth.enterpriseId,
      })
    } catch (error) {
      // 账号详情拉取失败不阻止登录：auth 里通常也带 uid。
      this.logger?.warn?.(`WorkBuddy 登录成功但账号详情拉取失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const merged = { ...(auth ?? {}), ...(account ?? {}), accessToken: auth.accessToken, refreshToken: auth.refreshToken ?? account?.refreshToken }
    const record = accountFromAuth(account ?? auth, merged, { source: 'browser-login' })
    await this.pool.upsert(providerId, record)
    const slice = providerState(this.state, providerId)
    slice.activeAccountId = record.id
    await this.persist()
    await this.afterLogin(providerId, record)
    return { pending: false, account: accountView(record, slice.activeAccountId) }
  }

  /**
   * 登录成功后的补数据：额度 + 目录。失败只记录，不阻断登录。
   * @param {string} providerId
   * @param {any} account
   */
  async afterLogin(providerId, account) {
    await Promise.allSettled([
      this.refreshCredits(providerId),
      this.refreshCatalog(providerId, { force: true }),
      this.refreshCheckinStatus(providerId),
    ])
  }

  /**
   * 手工粘贴 token 登录（浏览器登录不可用时的兜底）。
   * @param {string} providerId
   * @param {{ accessToken: string, refreshToken?: string }} input
   */
  async loginWithToken(providerId, input) {
    const accessToken = String(input?.accessToken ?? '').trim()
    if (accessToken === '') throw new Error('access token 不能为空')
    const credentials = {
      accessToken,
      refreshToken: typeof input?.refreshToken === 'string' && input.refreshToken.trim() !== '' ? input.refreshToken.trim() : undefined,
    }
    const account = await currentAccount(providerId, credentials)
    const record = accountFromAuth(account, {
      ...credentials,
      ...typeof input?.expiresAt === 'number' ? { expiresAt: input.expiresAt } : {},
    }, { source: input?.source === 'local' ? 'local' : 'manual-token' })
    if (record.uid === undefined && typeof account?.uid === 'string') record.uid = account.uid
    await this.pool.upsert(providerId, record)
    const slice = providerState(this.state, providerId)
    slice.activeAccountId = record.id
    await this.persist()
    await this.afterLogin(providerId, record)
    return accountView(record, slice.activeAccountId)
  }

  // -------------------------------------------------------------------------
  // 账号池
  // -------------------------------------------------------------------------

  /** @param {string} providerId @param {string} accountId */
  async selectAccount(providerId, accountId) {
    this.pool.select(providerId, accountId)
    await this.persist()
    await Promise.allSettled([this.refreshCredits(providerId), this.refreshCheckinStatus(providerId)])
    return this.snapshot()
  }

  /** @param {string} providerId @param {string} accountId */
  async removeAccount(providerId, accountId) {
    await this.pool.remove(providerId, accountId)
    return this.snapshot()
  }

  /**
   * 拉取当前 token 可见的上游账号列表（用于展示「这个登录还绑定了哪些身份」）。
   * @param {string} providerId
   */
  async upstreamAccounts(providerId) {
    const account = this.pool.active(providerId)
    if (account === null) return []
    const accounts = await this.pool.syncAccounts(providerId, account)
    return accounts
  }

  // -------------------------------------------------------------------------
  // 额度 / 签到
  // -------------------------------------------------------------------------

  /**
   * 刷新额度快照。
   * @param {string} providerId
   */
  async refreshCredits(providerId) {
    const slice = providerState(this.state, providerId)
    const account = this.pool.active(providerId)
    if (account === null) {
      slice.credits = { fetchedAt: Date.now(), error: '未登录' }
      await this.persist()
      return slice.credits
    }
    try {
      const credits = await this.pool.fetchCredits(providerId, account)
      slice.credits = {
        fetchedAt: Date.now(),
        accountId: account.id,
        nickname: account.nickname,
        ...credits,
      }
    } catch (error) {
      slice.credits = {
        fetchedAt: Date.now(),
        accountId: account.id,
        nickname: account.nickname,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    await this.persist()
    return slice.credits
  }

  /**
   * 刷新签到状态。
   * @param {string} providerId
   */
  async refreshCheckinStatus(providerId) {
    const slice = providerState(this.state, providerId)
    const account = this.pool.active(providerId)
    if (account === null) return null
    try {
      const status = await this.pool.fetchCheckinStatus(providerId, account)
      slice.checkin = { fetchedAt: Date.now(), accountId: account.id, status }
    } catch (error) {
      slice.checkin = {
        fetchedAt: Date.now(),
        accountId: account.id,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    await this.persist()
    return slice.checkin
  }

  /**
   * 执行签到并刷新额度。
   * @param {string} providerId
   */
  async checkin(providerId) {
    const account = this.pool.active(providerId)
    if (account === null) throw new Error('未登录')
    const result = await this.pool.doCheckin(providerId, account)
    await this.refreshCheckinStatus(providerId)
    await this.refreshCredits(providerId)
    return result
  }

  // -------------------------------------------------------------------------
  // 目录 / 逐模型开关
  // -------------------------------------------------------------------------

  /**
   * 刷新模型目录：有账号走云端 `/v3/config`，否则用本机桌面端缓存。
   * @param {string} providerId
   * @param {{ force?: boolean }} [options]
   */
  async refreshCatalog(providerId, options = {}) {
    const slice = providerState(this.state, providerId)
    const last = slice.catalog?.fetchedAt ?? 0
    if (options.force !== true && Date.now() - last < CATALOG_MIN_INTERVAL_MS) {
      return slice.catalog
    }
    const account = this.pool.active(providerId)
    /** @type {Array<{ models: any[], source: string, path?: string }>} */
    const candidates = []
    if (account !== null) {
      try {
        const { credentials } = await this.pool.credentialsFor(providerId, account)
        const config = await productConfig(providerId, credentials)
        const models = normalizeModels(modelsFromProductConfig(config))
        if (models.length > 0) candidates.push({ models, source: 'upstream' })
      } catch (error) {
        this.logger?.warn?.(`WorkBuddy 目录刷新失败（${providerId}）：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (candidates.length === 0) {
      const local = await readLocalProductConfig(providerId)
      if (local !== null) {
        const models = normalizeModels(modelsFromProductConfig(local.config))
        if (models.length > 0) candidates.push({ models, source: 'local-cache', path: local.path })
      }
    }
    const chosen = candidates[0]
    if (chosen === undefined) {
      slice.catalog = {
        fetchedAt: Date.now(),
        source: 'none',
        models: slice.catalog?.models ?? [],
        error: account === null ? '未登录，且本机没有可读的 WorkBuddy 目录缓存' : '上游与本机缓存都没有返回模型目录',
      }
      await this.persist()
      return slice.catalog
    }
    // 保留用户对已有模型的勾选，新模型默认启用。
    slice.catalog = {
      fetchedAt: Date.now(),
      source: chosen.source,
      ...chosen.path === undefined ? {} : { path: chosen.path },
      models: chosen.models,
    }
    await this.persist()
    return slice.catalog
  }

  /**
   * 切换某个模型的启用/图片输入。
   * @param {string} providerId
   * @param {string} modelId
   * @param {{ enabled?: boolean, image?: boolean }} patch
   */
  async setModelSetting(providerId, modelId, patch) {
    const slice = providerState(this.state, providerId)
    const current = slice.modelSettings[modelId] ?? {}
    slice.modelSettings[modelId] = {
      ...current,
      ...patch.enabled === undefined ? {} : { enabled: patch.enabled === true },
      ...patch.image === undefined ? {} : { image: patch.image === true },
    }
    await this.persist()
    return this.snapshot()
  }

  /** 当前模型的积分倍率读数（供胶囊展示）。 */
  activeModelReading(providerId, modelId) {
    const model = this.catalog(providerId).find((candidate) => candidate.id === modelId)
    if (model === undefined) return null
    return {
      id: model.id,
      name: model.name,
      multiplier: model.multiplier ?? parseCreditMultiplier(model.creditText),
      creditText: model.creditText,
    }
  }

  /** 释放资源。 */
  dispose() {
    this.logins.clear()
    this.refreshing.clear()
  }
}
