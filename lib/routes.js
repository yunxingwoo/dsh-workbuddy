/**
 * Host HTTP 路由：Web 客户端（设置卡片 / 积分胶囊）与 Host 服务之间的唯一通道。
 *
 * 路由挂在 DSH 自带 webserver 的 `/workbuddy` 前缀下，响应统一
 * `{ ok: true, value }` / `{ ok: false, error: { message, code } }`。
 * 只接受本机回环请求：这些接口能读取额度、切换账号、发起登录，不该暴露给
 * 远程 Web UI。需要远程访问时再补 paired-device 信任。
 * @module dsh-workbuddy/routes
 */

import { PROVIDERS } from './api.js'

/** 允许的回环地址。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * 是否为可信任的本机请求。
 * @param {import('node:http').IncomingMessage} req
 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK.has(address)
}

/**
 * 读 JSON body（上限 256 KiB）。
 * @param {import('node:http').IncomingMessage} req
 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  const parsed = JSON.parse(text)
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/**
 * 写 JSON 响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/**
 * 注册 `/workbuddy/*` 路由。
 * @param {any} ctx - 带 webServer 的 host context
 * @param {import('./service.js').WorkBuddyService} service
 * @param {{ logger?: any }} [deps]
 * @returns {() => void} disposer
 */
export function registerWorkBuddyRoutes(ctx, service, deps = {}) {
  const logger = deps.logger

  /**
   * 统一处理一个动作：校验 providerId、捕获异常、套信封。
   * @param {import('node:http').ServerResponse} res
   * @param {string|undefined} providerId
   * @param {(providerId: string) => Promise<unknown>} action
   */
  const run = async (res, providerId, action) => {
    try {
      if (typeof providerId !== 'string' || PROVIDERS[providerId] === undefined) {
        writeJson(res, 400, { ok: false, error: { message: `未知 provider：${String(providerId)}`, code: 'BAD_PROVIDER' } })
        return
      }
      const value = await action(providerId)
      writeJson(res, 200, { ok: true, value })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger?.warn?.(`WorkBuddy 路由失败：${message}`)
      writeJson(res, 200, { ok: false, error: { message, code: error?.code ?? 'INTERNAL' } })
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  const handler = async (req, res) => {
    if (!isLoopback(req)) {
      writeJson(res, 403, { ok: false, error: { message: 'WorkBuddy 接口只接受本机回环请求', code: 'FORBIDDEN' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/workbuddy/, '')
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { message: '只支持 POST', code: 'METHOD' } })
      return
    }
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, error: { message: error instanceof Error ? error.message : String(error), code: 'BAD_BODY' } })
      return
    }
    const providerId = typeof body.providerId === 'string' ? body.providerId : undefined
    switch (path) {
      case '/snapshot':
        writeJson(res, 200, { ok: true, value: service.snapshot() })
        return
      case '/login/start':
        await run(res, providerId, (id) => service.loginStart(id))
        return
      case '/login/poll':
        await run(res, providerId, (id) => service.loginPoll(id, String(body.state ?? '')))
        return
      case '/login/token':
        await run(res, providerId, (id) => service.loginWithToken(id, {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
        }))
        return
      case '/accounts/select':
        await run(res, providerId, (id) => service.selectAccount(id, String(body.accountId ?? '')))
        return
      case '/accounts/remove':
        await run(res, providerId, (id) => service.removeAccount(id, String(body.accountId ?? '')))
        return
      case '/accounts/upstream':
        await run(res, providerId, (id) => service.upstreamAccounts(id))
        return
      case '/models/toggle':
        await run(res, providerId, (id) => service.setModelSetting(id, String(body.modelId ?? ''), {
          enabled: body.enabled === undefined ? undefined : body.enabled === true,
          image: body.image === undefined ? undefined : body.image === true,
        }))
        return
      case '/catalog/refresh':
        await run(res, providerId, (id) => service.refreshCatalog(id, { force: body.force === true }))
        return
      case '/credits/refresh':
        await run(res, providerId, (id) => service.refreshCredits(id))
        return
      case '/checkin/status':
        await run(res, providerId, (id) => service.refreshCheckinStatus(id))
        return
      case '/checkin':
        await run(res, providerId, (id) => service.checkin(id))
        return
      case '/readout':
        await run(res, providerId, async (id) => {
          const provider = service.snapshot().providers.find((candidate) => candidate.id === id)
          return {
            credits: provider?.credits ?? null,
            model: service.activeModelReading(id, String(body.modelId ?? '')),
            account: provider?.activeAccount ?? null,
          }
        })
        return
      default:
        writeJson(res, 404, { ok: false, error: { message: `未知接口 ${path}`, code: 'NOT_FOUND' } })
    }
  }

  const dispose = ctx.webServer.register({ kind: 'prefix', path: '/workbuddy', handler })
  return typeof dispose === 'function' ? dispose : () => {}
}
