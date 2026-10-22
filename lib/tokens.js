/**
 * token 存储：优先使用 DSH 的 credentials 记录，把密文从插件状态文件里移走。
 *
 * 记录地址是 `dsh-workbuddy/<provider>-<account>`，kind=`grant`，payload 只放
 * `{ accessToken, refreshToken, expiresAt }`。DSH 把它写在 `~/.dsh/.credentials.yaml`
 * （0600，其他用户不可读），并在配置 UI 里以“已配置/不可见值”的方式呈现；
 * 插件状态文件只保留账号元数据。
 *
 * 兼容路径：如果当前 composition 没有 `credentials` 服务，退回到旧的
 * state 内明文 token（仍由 state.js 以 0600 写入），并在日志里提示一次。
 * @module dsh-workbuddy/tokens
 */

/** 凭据 key 的 scope。 */
const SCOPE = 'dsh-workbuddy'

/** 把任意片段净化成 `[a-z0-9-]+`（credentials key 的段格式）。 */
function safeSegment(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/**
 * 凭据记录 key。
 * @param {string} providerId
 * @param {string} accountId
 */
export function tokenKey(providerId, accountId) {
  return `${SCOPE}/${safeSegment(providerId)}-${safeSegment(accountId)}`
}

/** 从账号记录里取出 token 三元组（旧格式）。 */
export function tokensOf(account) {
  if (typeof account?.accessToken !== 'string' || account.accessToken === '') return null
  return {
    accessToken: account.accessToken,
    ...typeof account.refreshToken === 'string' && account.refreshToken !== '' ? { refreshToken: account.refreshToken } : {},
    ...typeof account.expiresAt === 'number' ? { expiresAt: account.expiresAt } : {},
  }
}

/** 去掉账号记录里的 token 字段。 */
export function stripTokens(account) {
  if (account === null || typeof account !== 'object') return account
  const { accessToken: _accessToken, refreshToken: _refreshToken, ...rest } = account
  return rest
}

/** token 存储。 */
export class TokenStore {
  /**
   * @param {object} deps
   * @param {any} [deps.credentials] - DSH credentials 服务（可空）
   * @param {() => any} [deps.credentialsSource] - 延迟解析 credentials 的 getter
   * @param {any} deps.state - 插件状态（回退存储）
   * @param {(state: any) => Promise<void>} deps.persist
   * @param {any} [deps.logger]
   */
  constructor(deps) {
    this.credentialsSource = deps.credentialsSource ?? (() => deps.credentials ?? null)
    this.state = deps.state
    this.persist = deps.persist
    this.logger = deps.logger
    this.warned = false
  }

  /** 当前可用的 credentials 服务（cordis 的服务可能在插件之后才挂好）。 */
  get credentials() {
    try {
      const value = this.credentialsSource()
      return value !== null && value !== undefined && typeof value.modifyRecord === 'function' ? value : null
    } catch {
      return null
    }
  }

  /** 是否走 credentials（而非 state 明文）。 */
  get secure() {
    return this.credentials !== null
  }

  /** 只提示一次回退。 */
  warnFallback() {
    if (this.warned || this.secure) return
    this.warned = true
    this.logger?.warn?.('WorkBuddy: 当前 composition 没有 credentials 服务，token 回退到 state.json（0600）')
  }

  /**
   * 读 token。
   * @param {string} providerId
   * @param {string} accountId
   * @returns {Promise<{ accessToken: string, refreshToken?: string, expiresAt?: number } | null>}
   */
  async read(providerId, accountId) {
    const credentials = this.credentials
    if (credentials !== null) {
      try {
        const record = await credentials.readRecord(tokenKey(providerId, accountId))
        const payload = record?.payload
        if (payload !== null && typeof payload === 'object' && typeof payload.accessToken === 'string' && payload.accessToken !== '') {
          return {
            accessToken: payload.accessToken,
            ...typeof payload.refreshToken === 'string' && payload.refreshToken !== '' ? { refreshToken: payload.refreshToken } : {},
            ...typeof payload.expiresAt === 'number' ? { expiresAt: payload.expiresAt } : {},
          }
        }
      } catch (error) {
        this.logger?.warn?.(`WorkBuddy: 读取 credentials 记录失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.warnFallback()
    return tokensOf(findAccount(this.state, providerId, accountId))
  }

  /**
   * 写 token。
   * @param {string} providerId
   * @param {string} accountId
   * @param {{ accessToken: string, refreshToken?: string, expiresAt?: number }} tokens
   */
  async write(providerId, accountId, tokens) {
    if (tokens === null || typeof tokens.accessToken !== 'string' || tokens.accessToken === '') {
      throw new Error('写入凭据失败：accessToken 为空')
    }
    const credentials = this.credentials
    if (credentials !== null) {
      const payload = {
        accessToken: tokens.accessToken,
        ...typeof tokens.refreshToken === 'string' && tokens.refreshToken !== '' ? { refreshToken: tokens.refreshToken } : {},
        ...typeof tokens.expiresAt === 'number' ? { expiresAt: tokens.expiresAt } : {},
      }
      await credentials.modifyRecord(tokenKey(providerId, accountId), () => ({ kind: 'grant', payload }))
      return
    }
    this.warnFallback()
    const account = findAccount(this.state, providerId, accountId)
    if (account === null) throw new Error('写入凭据失败：账号不存在')
    account.accessToken = tokens.accessToken
    if (typeof tokens.refreshToken === 'string') account.refreshToken = tokens.refreshToken
    account.expiresAt = typeof tokens.expiresAt === 'number' ? tokens.expiresAt : undefined
    await this.persist(this.state)
  }

  /**
   * 删除 token（移除账号时）。
   * @param {string} providerId
   * @param {string} accountId
   */
  async remove(providerId, accountId) {
    const credentials = this.credentials
    if (credentials !== null) {
      try {
        await credentials.deleteRecord(tokenKey(providerId, accountId))
      } catch (error) {
        this.logger?.warn?.(`WorkBuddy: 删除 credentials 记录失败：${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    const account = findAccount(this.state, providerId, accountId)
    if (account !== null) {
      delete account.accessToken
      delete account.refreshToken
      await this.persist(this.state)
    }
  }

  /**
   * 把旧 state 里的明文 token 迁移到 credentials，并从 state 删除。
   * @param {string} providerId
   * @param {any} account
   * @returns {Promise<boolean>} 是否发生了迁移
   */
  async migrateLegacy(providerId, account) {
    const legacy = tokensOf(account)
    if (legacy === null) return false
    if (this.secure) {
      await this.write(providerId, account.id, legacy)
      delete account.accessToken
      delete account.refreshToken
      return true
    }
    return false
  }
}

/** 在 state 里找账号。 */
function findAccount(state, providerId, accountId) {
  const accounts = state?.providers?.[providerId]?.accounts
  if (!Array.isArray(accounts)) return null
  return accounts.find((account) => account.id === accountId) ?? null
}
