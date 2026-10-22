/**
 * dsh-workbuddy 的 Host 半边。
 *
 * 职责：
 * 1. 为 `workbuddy` 与 `workbuddy-global` 各注册一个 LLM provider adapter，
 *    模型目录来自上游 `/v3/config`（带 credits 倍率），并叠加用户勾选；
 * 2. 提供 `/workbuddy/*` HTTP 路由给 Web 客户端（登录、账号池、额度、签到、开关）；
 * 3. 定时刷新目录/额度，可选自动签到。
 *
 * 插件不 import 宿主包：provider 契约用鸭子类型满足（见 adapter.js）。
 * @module dsh-workbuddy/host
 */

import { PROVIDERS } from './api.js'
import { WorkBuddyAdapter } from './adapter.js'
import { registerWorkBuddyRoutes } from './routes.js'
import { WorkBuddyService } from './service.js'

/** 插件名。 */
export const name = 'dsh-workbuddy'

/** 依赖的宿主服务。 */
export const inject = ['llm', 'webServer']

/**
 * 插件入口。
 * @param {any} ctx - cordis host context
 * @param {object} [config] - profile 配置（refreshMinutes / autoCheckin / requestTimeoutSeconds）
 */
export function apply(ctx, config = {}) {
  const logger = ctx.logger
  const service = new WorkBuddyService({ ctx, config, logger })

  /** 初始化只做一次；adapter 的每次调用都会等待它。 */
  let readyPromise
  const ensureReady = () => {
    readyPromise ??= (async () => {
      await service.init()
      // 首屏先把本机缓存目录挂上，再按需刷新（不阻塞模型选择器）。
      for (const providerId of Object.keys(PROVIDERS)) {
        try {
          await service.refreshCatalog(providerId, { force: false })
        } catch (error) {
          logger?.warn?.(`WorkBuddy 初始目录加载失败（${providerId}）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const providerId of Object.keys(PROVIDERS)) {
        void service.refreshCredits(providerId).catch(() => {})
        void service.refreshCheckinStatus(providerId).catch(() => {})
      }
    })()
    return readyPromise
  }

  // --- provider 注册 ---------------------------------------------------------
  /** @type {Array<() => void>} */
  const disposers = []
  for (const providerId of Object.keys(PROVIDERS)) {
    const provider = PROVIDERS[providerId]
    const adapter = new WorkBuddyAdapter({
      providerId,
      displayName: provider.displayName,
      catalogModels: () => service.catalog(providerId),
      pool: () => service.pool,
      attachments: () => {
        try {
          return ctx.get('attachments')
        } catch {
          return undefined
        }
      },
      ensureReady,
      // 国际版生成受上游官方客户端渠道校验限制；默认不把它的模型放进选择器，
      // 但仍保留账号/目录/积分/签到。需要试验时可配置 globalModels: true。
      selectorEnabled: providerId === 'workbuddy-global' ? () => config?.globalModels === true : () => true,
      logger,
    })
    try {
      const registration = ctx.llm.registerAdapter([providerId], adapter)
      disposers.push(registration)
      const advertised = providerId === 'workbuddy-global' && config?.globalModels !== true ? '（不进模型选择器）' : ''
      logger?.info?.(`WorkBuddy: 已注册模型 provider "${providerId}"（${provider.displayName}）${advertised}`)
    } catch (error) {
      // 同一 provider 已被其它插件占用时不要拖垮整个 profile。
      logger?.warn?.(`WorkBuddy: 注册 provider "${providerId}" 失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // --- HTTP 路由 -------------------------------------------------------------
  ctx.inject(['webServer'], (child) => {
    child.effect(() => registerWorkBuddyRoutes(child, service, { logger }), 'dsh-workbuddy: /workbuddy routes')
  })

  // --- 定时刷新 + 自动签到 ----------------------------------------------------
  const refreshMinutes = Math.max(1, Number(config?.refreshMinutes) || 30)
  ctx.effect(() => {
    const timer = setInterval(async () => {
      await ensureReady().catch(() => {})
      for (const providerId of Object.keys(PROVIDERS)) {
        try {
          await service.refreshCatalog(providerId, { force: false })
          await service.refreshCredits(providerId)
          await service.refreshCheckinStatus(providerId)
          if (config?.autoCheckin === true) {
            const checkin = service.snapshot().providers.find((provider) => provider.id === providerId)?.checkin
            if (checkin?.status?.active === true && checkin.status.todayCheckedIn !== true) {
              await service.checkin(providerId).catch((error) => {
                logger?.warn?.(`WorkBuddy 自动签到失败（${providerId}）：${error instanceof Error ? error.message : String(error)}`)
              })
            }
          }
        } catch (error) {
          logger?.warn?.(`WorkBuddy 定时刷新失败（${providerId}）：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }, refreshMinutes * 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-workbuddy: refresh timer')

  // --- 首屏初始化（失败只记录，不阻止插件挂载） -------------------------------
  ctx.effect(() => {
    ensureReady().catch((error) => {
      logger?.warn?.(`WorkBuddy 初始化失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 注册已释放。
        }
      }
      service.dispose()
    }
  }, 'dsh-workbuddy: lifecycle')
}
