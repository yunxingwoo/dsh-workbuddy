/**
 * WorkBuddy 上游 HTTP 客户端（国内版 workbuddy.cn / 国际版 workbuddy.ai）。
 *
 * 这里只做三件事：拼请求头、把 `{code,msg,data}` 信封解开、把 SSE 拆成事件。
 * 不缓存、不重试、不碰账号池 —— 那些属于 pool.js / catalog.js。
 *
 * 端点与请求头按 WorkBuddy 客户端行为对齐（上游版本变化时以实际返回为准）：
 * - 登录：`POST /v2/plugin/auth/state?platform=<platform>` 拿 state + authUrl；
 *   轮询 `GET /v2/plugin/auth/token?state=<state>`，未登录时返回 code=11217。
 * - 续期：`POST /v2/plugin/auth/token/refresh` + `X-Refresh-Token`。
 * - 账号：`GET /v2/plugin/accounts`、`GET /v2/plugin/account`、
 *   `POST /v2/plugin/account/switch`。
 * - 额度：`POST /v2/billing/meter/get-user-resource-summary`（个人）；
 *   企业账号用 `POST /v2/billing/meter/get-enterprise-user-usage` + X-Enterprise-Id。
 * - 签到：`POST /v2/billing/meter/checkin-activity-status`、`POST .../daily-checkin`。
 * - 模型目录：`GET /v3/config`（Bearer）。
 * - 对话：`POST /v2/chat/completions`，OpenAI 兼容 SSE。
 * @module dsh-workbuddy/api
 */

/** 两个并行供应商的静态描述。 */
export const PROVIDERS = {
  workbuddy: {
    id: 'workbuddy',
    platform: 'workbuddy',
    endpoint: 'https://www.workbuddy.cn',
    displayName: 'WorkBuddy 国内版',
    website: 'https://www.workbuddy.cn',
    /** 本机桌面端缓存的产品目录（无 token 时的兜底目录）。 */
    localConfigPaths: [
      '~/.workbuddy/cache/acc-product-config-v3.json',
      '~/Library/Application Support/CodeBuddyExtension/Data/Public/cache/acc-product-config-v3.json',
    ],
    userAgent: 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.147.0',
    loginPlatform: 'workbuddy',
  },
  'workbuddy-global': {
    id: 'workbuddy-global',
    platform: 'workbuddy-ai',
    endpoint: 'https://www.workbuddy.ai',
    displayName: 'WorkBuddy 国际版',
    website: 'https://www.workbuddy.ai',
    localConfigPaths: [
      '~/.workbuddy-ai/cache/acc-product-config-v3.json',
    ],
    userAgent: 'WorkBuddy/5.5.2 WorkBuddy/5.5.2 CLI/2.147.0',
    loginPlatform: 'workbuddy-ai',
  },
}

/** 上游返回了非 0 业务码。 */
export class WorkBuddyApiError extends Error {
  /**
   * @param {string} message - 可读错误。
   * @param {{ status?: number, code?: number|string, requestId?: string, endpoint?: string }} [meta]
   */
  constructor(message, meta = {}) {
    super(message)
    this.name = 'WorkBuddyApiError'
    this.status = meta.status
    this.code = meta.code
    this.requestId = meta.requestId
    this.endpoint = meta.endpoint
  }
}

/** 生成 32 位十六进制请求 ID（上游要求无连字符）。 */
export function requestId() {
  return crypto.randomUUID().replaceAll('-', '')
}

/**
 * 一个账号在某一时刻的凭据快照。
 * @typedef {object} Credentials
 * @property {string} accessToken
 * @property {string} [refreshToken]
 * @property {string} [uid]
 * @property {string} [enterpriseId]
 * @property {string} [domain]
 */

/**
 * 构造发往 WorkBuddy 的请求头。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials|null} credentials
 * @param {{ noAuth?: boolean, extra?: Record<string,string> }} [options]
 * @returns {Record<string,string>}
 */
export function buildHeaders(providerId, credentials, options = {}) {
  const provider = PROVIDERS[providerId]
  if (!provider) throw new Error(`unknown WorkBuddy provider: ${providerId}`)
  const host = new URL(provider.endpoint).hostname
  /** @type {Record<string,string>} */
  const headers = {
    'accept-encoding': 'identity',
    'content-type': 'application/json',
    'user-agent': provider.userAgent,
    'x-domain': host,
    'x-product': 'SaaS',
    'x-request-id': requestId(),
    'x-requested-with': 'XMLHttpRequest',
    'x-codebuddy-request': '1',
    'x-ide-type': 'WorkBuddy',
    'x-ide-name': 'WorkBuddy',
    'x-ide-version': provider.userAgent.split('/')[1]?.split(' ')[0] ?? '0.0.0',
  }
  if (options.noAuth === true) {
    headers['x-no-authorization'] = 'true'
    headers['x-no-user-id'] = 'true'
    headers['x-no-enterprise-id'] = 'true'
    headers['x-no-department-info'] = 'true'
  } else if (credentials?.accessToken) {
    headers.authorization = `Bearer ${credentials.accessToken}`
    if (credentials.uid) headers['x-user-id'] = credentials.uid
    if (credentials.enterpriseId) {
      headers['x-enterprise-id'] = credentials.enterpriseId
      headers['x-tenant-id'] = credentials.enterpriseId
    }
    if (credentials.domain) headers['x-domain'] = credentials.domain
  }
  return { ...headers, ...options.extra }
}

/**
 * 解上游信封：`{code,msg,data}`，code 省略或 0 视为成功。
 * @template T
 * @param {unknown} payload
 * @param {string} path
 * @returns {T}
 */
function unwrap(payload, path) {
  if (payload === null || typeof payload !== 'object') {
    throw new WorkBuddyApiError(`WorkBuddy ${path}: 响应不是 JSON 对象`, { endpoint: path })
  }
  const envelope = /** @type {Record<string, any>} */ (payload)
  if (envelope.code !== undefined && envelope.code !== 0) {
    throw new WorkBuddyApiError(
      `WorkBuddy ${path}: ${String(envelope.msg ?? envelope.message ?? `业务码 ${String(envelope.code)}`)}`,
      { code: envelope.code, requestId: envelope.requestId, endpoint: path },
    )
  }
  return /** @type {T} */ (envelope.data ?? envelope)
}

/**
 * JSON 请求。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {string} path
 * @param {object} [options]
 * @param {Credentials|null} [options.credentials]
 * @param {boolean} [options.noAuth]
 * @param {'GET'|'POST'} [options.method]
 * @param {unknown} [options.body]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @param {Record<string,string>} [options.extraHeaders]
 * @returns {Promise<any>}
 */
export async function request(providerId, path, options = {}) {
  const provider = PROVIDERS[providerId]
  if (!provider) throw new Error(`unknown WorkBuddy provider: ${providerId}`)
  const method = options.method ?? 'GET'
  const timeoutMs = options.timeoutMs ?? 30_000
  const signal = options.signal ?? AbortSignal.timeout(timeoutMs)
  const headers = buildHeaders(providerId, options.credentials ?? null, {
    noAuth: options.noAuth,
    extra: options.extraHeaders,
  })
  const init = { method, headers, signal }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)
  let response
  try {
    response = await fetch(`${provider.endpoint}${path}`, /** @type {RequestInit} */ (init))
  } catch (error) {
    throw new WorkBuddyApiError(
      `WorkBuddy ${path}: 网络请求失败（${error instanceof Error ? error.message : String(error)}）`,
      { endpoint: path },
    )
  }
  const text = await response.text()
  let payload
  try {
    payload = text === '' ? undefined : JSON.parse(text)
  } catch {
    throw new WorkBuddyApiError(`WorkBuddy ${path}: HTTP ${String(response.status)} 非 JSON 响应`, {
      status: response.status,
      endpoint: path,
    })
  }
  if (!response.ok) {
    const msg = payload?.msg ?? payload?.message ?? `HTTP ${String(response.status)}`
    throw new WorkBuddyApiError(`WorkBuddy ${path}: ${String(msg)}`, {
      status: response.status,
      code: payload?.code,
      requestId: payload?.requestId,
      endpoint: path,
    })
  }
  return unwrap(payload, path)
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/**
 * 创建一次浏览器登录：返回 state 与用户要在浏览器打开的 authUrl。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @returns {Promise<{ state: string, authUrl: string }>}
 */
export async function startBrowserLogin(providerId) {
  const provider = PROVIDERS[providerId]
  const data = await request(providerId, `/v2/plugin/auth/state?platform=${encodeURIComponent(provider.loginPlatform)}`, {
    noAuth: true,
    method: 'POST',
    body: {},
    timeoutMs: 15_000,
  })
  if (typeof data?.state !== 'string' || typeof data?.authUrl !== 'string') {
    throw new WorkBuddyApiError('WorkBuddy 登录：auth/state 未返回 state/authUrl', { endpoint: '/v2/plugin/auth/state' })
  }
  return { state: data.state, authUrl: data.authUrl }
}

/** 轮询登录时上游表示“仍在等待”的业务码。 */
const LOGIN_PENDING_CODES = new Set([11217, 12151])

/**
 * 查询一次登录状态。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {string} state
 * @returns {Promise<{ pending: true } | { pending: false, auth: any }>}
 */
export async function pollBrowserLogin(providerId, state) {
  try {
    const data = await request(providerId, `/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, {
      noAuth: true,
      timeoutMs: 15_000,
    })
    if (data === undefined || data === null) return { pending: true }
    if (typeof data.accessToken !== 'string' || data.accessToken === '') return { pending: true }
    return { pending: false, auth: data }
  } catch (error) {
    if (error instanceof WorkBuddyApiError && LOGIN_PENDING_CODES.has(Number(error.code))) return { pending: true }
    throw error
  }
}

/**
 * 用 refresh token 换新 access token。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<any>}
 */
export async function refreshAccessToken(providerId, credentials) {
  if (!credentials.refreshToken) throw new WorkBuddyApiError('WorkBuddy 续期：缺少 refresh token')
  return request(providerId, '/v2/plugin/auth/token/refresh', {
    credentials,
    method: 'POST',
    body: {},
    extraHeaders: {
      'x-refresh-token': credentials.refreshToken,
      'x-auth-refresh-source': 'plugin',
    },
    timeoutMs: 20_000,
  })
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

/**
 * 当前 token 能看到的账号列表。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<any[]>}
 */
export async function listAccounts(providerId, credentials) {
  const data = await request(providerId, '/v2/plugin/accounts', { credentials })
  const accounts = data?.accounts
  return Array.isArray(accounts) ? accounts : []
}

/**
 * 当前主账号。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<any>}
 */
export async function currentAccount(providerId, credentials) {
  return request(providerId, '/v2/plugin/account', { credentials })
}

/**
 * 在企业/个人账号之间切换，返回新的 auth 快照。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @param {{ type: string, enterpriseId?: string }} target
 * @returns {Promise<any>}
 */
export async function switchAccount(providerId, credentials, target) {
  if (!credentials.refreshToken) throw new WorkBuddyApiError('WorkBuddy 换号：缺少 refresh token')
  /** @type {Record<string, unknown>} */
  const body = {}
  if (target.type !== 'personal' && target.enterpriseId) body.target_enterprise_id = target.enterpriseId
  return request(providerId, '/v2/plugin/account/switch', {
    credentials,
    method: 'POST',
    body,
    extraHeaders: { 'x-refresh-token': credentials.refreshToken },
    timeoutMs: 20_000,
  })
}

// ---------------------------------------------------------------------------
// 积分 / 签到
// ---------------------------------------------------------------------------

/**
 * 个人额度汇总。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<{ total: number, left: number, used: number, isPaidUser: boolean, packages: any[] }>}
 */
export async function resourceSummary(providerId, credentials) {
  const data = await request(providerId, '/billing/meter/get-user-resource-summary', {
    credentials,
    method: 'POST',
    body: {},
    timeoutMs: 20_000,
  })
  const packages = Array.isArray(data?.Packages) ? data.Packages : []
  let total = 0
  let left = 0
  let used = 0
  for (const item of packages) {
    total += Number(item?.CycleTotalCapacity) > 0 ? Number(item.CycleTotalCapacity) : 0
    left += Number(item?.CycleRemainCapacity) > 0 ? Number(item.CycleRemainCapacity) : 0
    used += Number(item?.CycleUsedCapacity) > 0 ? Number(item.CycleUsedCapacity) : 0
  }
  return {
    total,
    left,
    used,
    isPaidUser: data?.IsPaidUser === true,
    packages: packages.map((item) => ({
      packageCode: item?.PackageCode ?? '',
      total: Number(item?.CycleTotalCapacity) || 0,
      left: Number(item?.CycleRemainCapacity) || 0,
      used: Number(item?.CycleUsedCapacity) || 0,
    })),
  }
}

/**
 * 企业额度汇总。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<{ unlimited: boolean, total: number, left: number }>}
 */
export async function enterpriseSummary(providerId, credentials) {
  const data = await request(providerId, '/v2/billing/meter/get-enterprise-user-usage', {
    credentials,
    method: 'POST',
    body: {},
    extraHeaders: credentials.enterpriseId ? { 'x-enterprise-id': credentials.enterpriseId } : {},
    timeoutMs: 20_000,
  })
  const unlimited = Number(data?.limit_num) === -1
  const total = unlimited ? -1 : Number(data?.limit_num) || 0
  const used = Number(data?.used_num) || 0
  return { unlimited, total, left: unlimited ? -1 : Math.max(0, total - used) }
}

/**
 * 签到活动状态。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<{ active: boolean, todayCheckedIn: boolean, streakDays: number, dailyCredit: number, todayCredit: number, totalCredits?: number } | null>}
 */
export async function checkinStatus(providerId, credentials) {
  const data = await request(providerId, '/v2/billing/meter/checkin-activity-status', {
    credentials,
    method: 'POST',
    body: {},
    timeoutMs: 20_000,
  })
  if (!data) return null
  return {
    active: data.active === true,
    todayCheckedIn: data.today_checked_in === true,
    streakDays: Number(data.streak_days) || 0,
    dailyCredit: Number(data.daily_credit) || 0,
    todayCredit: Number(data.today_credit) || 0,
    totalCredits: data.total_credits === undefined ? undefined : Number(data.total_credits),
    activityName: typeof data.activity_name === 'string' ? data.activity_name : undefined,
    claimButtonText: typeof data.claim_button_text === 'string' ? data.claim_button_text : undefined,
  }
}

/**
 * 执行每日签到。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<{ credit: number, streakDays: number, isStreakDay: boolean }>}
 */
export async function checkin(providerId, credentials) {
  const raw = await request(providerId, '/v2/billing/meter/daily-checkin', {
    credentials,
    method: 'POST',
    body: {},
    timeoutMs: 20_000,
  })
  return {
    credit: Number(raw?.credit) || 0,
    streakDays: Number(raw?.streak_days) || 0,
    isStreakDay: raw?.is_streak_day === true,
  }
}

// ---------------------------------------------------------------------------
// 模型目录
// ---------------------------------------------------------------------------

/**
 * 拉取云端产品目录（含模型 credits 倍率）。无 token 时抛错，由 catalog.js 兜底本地缓存。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @returns {Promise<any>}
 */
export async function productConfig(providerId, credentials) {
  return request(providerId, '/v3/config', { credentials, timeoutMs: 30_000 })
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

/**
 * 发起一次流式对话，返回已解析的 SSE 事件异步迭代器。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @param {Credentials} credentials
 * @param {Record<string, unknown>} body - OpenAI 兼容请求体（stream 由本函数强制打开）。
 * @param {AbortSignal} [signal]
 * @returns {Promise<AsyncGenerator<any, void, unknown>>}
 */
export async function streamChat(providerId, credentials, body, signal) {
  const provider = PROVIDERS[providerId]
  const headers = buildHeaders(providerId, credentials, {
    extra: {
      accept: 'text/event-stream',
      'x-conversation-request-id': requestId(),
    },
  })
  const response = await fetch(`${provider.endpoint}/v2/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let envelope
    try {
      envelope = text === '' ? undefined : JSON.parse(text)
    } catch {
      envelope = undefined
    }
    const upstreamMessage = String(envelope?.msg ?? text.slice(0, 300))
    const channelBlocked = Number(envelope?.code) === 11128 || /channel verification|安全校验|渠道校验/i.test(upstreamMessage)
    throw new WorkBuddyApiError(
      channelBlocked
        ? `WorkBuddy 对话失败：上游要求官方客户端渠道校验（${upstreamMessage}）。国内版通常不受影响；国际版请先在官方 WorkBuddy AI 客户端里发一次消息，或把该账号切到国内版再试`
        : `WorkBuddy 对话失败：HTTP ${String(response.status)} ${upstreamMessage}`,
      { status: response.status, code: envelope?.code, endpoint: '/v2/chat/completions' },
    )
  }
  if (!response.body) throw new WorkBuddyApiError('WorkBuddy 对话失败：响应没有 body')
  return parseSse(response.body)
}

/**
 * 把 `text/event-stream` 字节流拆成 JSON 事件。
 * 兼容 `data: [DONE]`、多行 data、注释行与 CRLF。
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<any, void, unknown>}
 */
export async function* parseSse(stream) {
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  const flush = function* () {
    if (dataLines.length === 0) return
    const raw = dataLines.join('\n').trim()
    dataLines = []
    if (raw === '' || raw === '[DONE]') return
    try {
      yield JSON.parse(raw)
    } catch {
      // 上游偶发非 JSON 心跳/调试行；跳过而不是让整条流失败。
    }
  }
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') {
        yield* flush()
        continue
      }
      if (line.startsWith(':')) continue
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
  }
  buffer += decoder.decode()
  if (buffer !== '') {
    if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart())
    else if (!buffer.startsWith('event:') && !buffer.startsWith(':')) dataLines.push(buffer)
  }
  yield* flush()
}
