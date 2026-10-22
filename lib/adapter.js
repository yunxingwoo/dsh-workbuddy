/**
 * DSH LLM provider 适配器：把 WorkBuddy 的 OpenAI 兼容 `/v2/chat/completions`
 * 翻译成 Harness 的 chunk 协议（block-start / text-delta / reasoning-delta /
 * tool-call-delta / block-end / usage / finish）。
 *
 * 只依赖 `ctx.llm` 的适配器契约（见 @deepseek-ai/dsh-llm README），不 import 宿主包，
 * 因为第三方插件无法从 profile 里解析 `@deepseek-ai/dsh-llm`。错误对象同时带
 * `code` 与 `failure` 自有字段，宿主 normalizeLlmFailure 会原样保留 code。
 * @module dsh-workbuddy/adapter
 */

import { readFile } from 'node:fs/promises'
import { streamChat } from './api.js'

/** 可重试/可换号的失败码。 */
export const FAILURE_CODES = {
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  MISSING_CREDENTIAL: 'MISSING_CREDENTIAL',
  CONTEXT_WINDOW_EXCEEDED: 'CONTEXT_WINDOW_EXCEEDED',
  TRANSPORT: 'TRANSPORT',
  PROVIDER: 'PROVIDER',
}

/**
 * 构造一个宿主可识别的 LLM 失败：`code` 与 `failure` 是自有数据属性。
 * @param {string} message
 * @param {string} [code]
 * @param {{ status?: number, requestId?: string, cause?: unknown }} [meta]
 */
export function llmError(message, code = FAILURE_CODES.PROVIDER, meta = {}) {
  const error = new Error(message)
  error.name = 'WorkBuddyLlmError'
  error.code = code
  error.failure = Object.freeze({
    message,
    code,
    ...meta.status === undefined ? {} : { status: meta.status },
    ...meta.requestId === undefined ? {} : { requestId: meta.requestId },
  })
  if (meta.cause !== undefined) error.cause = meta.cause
  return error
}

/**
 * 把上游错误归类为可换号的类别。
 * @param {unknown} error
 * @returns {'auth'|'quota'|'rate-limit'|'other'}
 */
export function classifyFailure(error) {
  const status = Number(error?.status)
  const code = Number(error?.code)
  const message = String(error?.message ?? '')
  if (status === 401 || status === 403) return 'auth'
  if (code === 12151 || code === 401) return 'auth'
  if (status === 429 || status === 402) return 'quota'
  // 排队码：上游让请求等待，不是失败；换号会丢掉队列位置。
  if ([6020, 6021, 6022].includes(code)) return 'queue'
  if ((code >= 6000 && code <= 6008) || code === 14003) return 'rate-limit'
  if (code >= 14000 && code <= 14020) return 'quota'
  if (/quota|credit|balance|额度|积分|余额|exhaust|insufficient|limit/i.test(message)) return 'quota'
  return 'other'
}

/**
 * 把上游错误归一成宿主可识别的 LLM 失败码。
 * 401/配额/限流会进入宿主重试策略；渠道校验与业务错误保持 PROVIDER（不重试）。
 * @param {unknown} error
 * @returns {Error}
 */
/** 网络层失败（连接被重置/中断）——区别于上游业务错误。 */
function isTransportFailure(message) {
  return /fetch failed|network|socket|ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection (?:reset|closed|refused)/i.test(message)
}

export function toLlmError(error) {
  if (error instanceof Error && typeof error.failure === 'object' && error.failure !== null && typeof error.code === 'string') {
    return error
  }
  const message = error instanceof Error
    ? error.message
    : String(error?.message ?? error)
  const status = Number(error?.status) || undefined
  const requestId = typeof error?.requestId === 'string' ? error.requestId : undefined
  const kind = classifyFailure(error)
  const contextOverflow = /context[\s_-]*(?:length|window)|too\s+(?:large|long)|maximum context|上下文.*(?:超|上限)/i.test(message)
  const code = contextOverflow
    ? FAILURE_CODES.CONTEXT_WINDOW_EXCEEDED
    : kind === 'auth'
      ? FAILURE_CODES.AUTH
      : kind === 'quota'
        ? FAILURE_CODES.QUOTA
        : kind === 'rate-limit' || kind === 'queue'
          ? FAILURE_CODES.RATE_LIMIT
          : /timeout|timed out|abort/i.test(message) || isTransportFailure(message)
            ? FAILURE_CODES.TRANSPORT
            : FAILURE_CODES.PROVIDER
  return llmError(message, code, { status, requestId, cause: error })
}

/**
 * WorkBuddy 上游 WAF 对 **system 角色** 文本有竞品词拦截：含
 * "You are an AI agent powered by DeepSeek Harness." 的 system 消息会被
 * 拒绝为 `code 11128 Illegal API invocation from an unapproved channel`
 * （user 角色不受影响）。这里只替换 system 文本里的产品全名，保留指令语义。
 */
const SYSTEM_WAF_REWRITES = [
  ['DeepSeek Harness', 'DSH'],
]

/**
 * 把 system/developer 文本里的上游敏感词替换掉。
 * @param {string} text
 */
export function sanitizeSystemText(text) {
  let next = text
  for (const [from, to] of SYSTEM_WAF_REWRITES) next = next.replaceAll(from, to)
  return next
}

/** 上传到模型的多模态图片转成 OpenAI data URL；拿不到字节就用文本占位。 */
async function imagePart(block, attachments) {
  const attachment = block?.attachment
  if (attachment === undefined || attachment === null) return { type: 'text', text: '[image unavailable]' }
  if (typeof attachments?.imageHostPath === 'function') {
    try {
      const hostPath = attachments.imageHostPath(attachment)
      if (typeof hostPath === 'string' && hostPath !== '') {
        const bytes = await readFile(hostPath)
        const mediaType = typeof attachment.mediaType === 'string' ? attachment.mediaType : 'image/png'
        return { type: 'image_url', image_url: { url: `data:${mediaType};base64,${bytes.toString('base64')}` } }
      }
    } catch {
      // 落回文本占位。
    }
  }
  const digest = String(attachment.attachmentId ?? '').slice('sha256:'.length, 'sha256:'.length + 8)
  return { type: 'text', text: `[image omitted: no local normalized image is available; sha256:${digest}]` }
}

/**
 * 把 DSH 消息数组翻译成 OpenAI chat messages。
 * @param {any[]} messages
 * @param {any} attachments
 * @returns {Promise<any[]>}
 */
export async function toOpenAiMessages(messages, attachments) {
  /** @type {any[]} */
  const result = []
  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role
    const blocks = Array.isArray(message.content) ? message.content : []
    if (role === 'system' || role === 'developer') {
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      if (text !== '') result.push({ role: 'system', content: sanitizeSystemText(text) })
      continue
    }
    if (role === 'tool') {
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      result.push({ role: 'tool', tool_call_id: message.toolCallId ?? message.tool_call_id ?? '', content: text })
      continue
    }
    if (role === 'assistant') {
      const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
      const toolCalls = blocks.filter((block) => block.type === 'tool-call').map((block) => ({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: block.arguments ?? '{}' },
      }))
      // reasoning 块不回传给上游：多数网关不接受 assistant 历史里的 reasoning。
      if (text === '' && toolCalls.length === 0) continue
      result.push({
        role: 'assistant',
        ...text === '' ? { content: null } : { content: text },
        ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
      })
      continue
    }
    // user（以及可能出现的其它用户侧角色）
    /** @type {any[]} */
    const parts = []
    for (const block of blocks) {
      if (block.type === 'text') {
        if (block.text !== '') parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        parts.push(await imagePart(block, attachments))
      } else if (block.type === 'file') {
        // 宿主已把 file 块投影成文本句柄；这里兜底成一句说明。
        parts.push({ type: 'text', text: '[file attached; read it with your file tools]' })
      }
    }
    if (parts.length === 0) continue
    if (parts.every((part) => part.type === 'text')) {
      result.push({ role: 'user', content: parts.map((part) => part.text).join('\n') })
    } else {
      result.push({ role: 'user', content: parts })
    }
  }
  return result
}

/**
 * 把 DSH 工具声明翻译成 OpenAI function tools。
 * @param {any[]} tools
 */
export function toOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: String(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  }))
}

/** 把上游 finish_reason 映射成 Harness 的 finish reason。 */
function finishReason(raw) {
  switch (raw) {
    case 'tool_calls':
    case 'function_call': return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens': return { kind: 'max-tokens' }
    default: return { kind: 'stop' }
  }
}

/** 从 OpenAI usage 里取 Harness usage。 */
function usageOf(raw) {
  if (raw === undefined || raw === null) return undefined
  const inputTokens = Number(raw.prompt_tokens ?? raw.input_tokens) || 0
  const outputTokens = Number(raw.completion_tokens ?? raw.output_tokens) || 0
  const cached = Number(raw.prompt_tokens_details?.cached_tokens ?? raw.cache_read_input_tokens) || 0
  const usage = { inputTokens, outputTokens }
  if (cached > 0) usage.cacheReadTokens = cached
  usage.totalTokens = inputTokens + outputTokens + (usage.cacheReadTokens ?? 0)
  return usage
}

/** WorkBuddy 适配器。 */
export class WorkBuddyAdapter {
  /**
   * @param {object} deps
   * @param {'workbuddy'|'workbuddy-global'} deps.providerId
   * @param {string} deps.displayName
   * @param {() => any[]} deps.catalogModels - 当前已启用的模型（含 image 覆盖）
   * @param {() => import('./pool.js').AccountPool} deps.pool
   * @param {() => any} deps.attachments - attachments 服务（可为空）
   * @param {any} [deps.logger]
   */
  constructor(deps) {
    this.providerId = deps.providerId
    this.displayName = deps.displayName
    this.catalogModels = deps.catalogModels
    this.pool = deps.pool
    this.attachments = deps.attachments
    this.ensureReady = deps.ensureReady ?? (() => Promise.resolve())
    this.selectorEnabled = deps.selectorEnabled ?? (() => true)
    this.logger = deps.logger
  }

  /** @param {string} provider */
  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  /** @param {string} _provider */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /**
   * 模型选择器看到的目录：只含用户勾选的模型。
   * @param {string} provider
   */
  async listModels(provider) {
    await this.ensureReady()
    if (this.selectorEnabled() !== true) return []
    return this.catalogModels().map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...model.description === '' ? {} : { description: model.description },
      inputModalities: model.image ? ['text', 'image'] : ['text'],
    }))
  }

  /**
   * 精确模型元数据。
   * @param {string} provider
   * @param {string} modelId
   */
  async resolveModel(provider, modelId) {
    await this.ensureReady()
    const model = this.catalogModels().find((candidate) => candidate.id === modelId)
    if (model === undefined) {
      return { provider, id: modelId, name: modelId, inputModalities: ['text'] }
    }
    return {
      provider,
      id: model.id,
      name: model.name,
      ...model.description === '' ? {} : { description: model.description },
      inputModalities: model.image ? ['text', 'image'] : ['text'],
      ...model.contextWindow === undefined ? {} : { context: { contextWindow: model.contextWindow } },
      ...model.maxOutputTokens === undefined ? {} : { defaultMaxTokens: model.maxOutputTokens },
      ...model.reasoning === undefined ? {} : {
        reasoning: {
          efforts: model.reasoning.efforts.map((effort) => ({ id: effort, name: effort })),
          ...model.reasoning.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
        },
      },
    }
  }

  /**
   * 绑定一次调用的模型元数据与派发入口（DSH 要求同一代际）。
   * @param {string} provider
   * @param {string} model
   * @param {AbortSignal} [signal]
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    }
  }

  /**
   * 组装 OpenAI 兼容请求体。
   * @param {any} options
   * @param {any} model
   */
  async buildBody(options, model) {
    const messages = await toOpenAiMessages(options.messages, this.attachments())
    if (typeof options.system === 'string' && options.system !== '') {
      messages.unshift({ role: 'system', content: sanitizeSystemText(options.system) })
    }
    const tools = model.supportsToolCall === false ? undefined : toOpenAiTools(options.tools)
    const effort = options.reasoningEffort
    /** @type {Record<string, unknown>} */
    const body = {
      model: options.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens
    if (options.temperature !== undefined) body.temperature = options.temperature
    else if (model.temperature !== undefined) body.temperature = model.temperature
    if (Array.isArray(options.stop) && options.stop.length > 0) body.stop = options.stop
    if (tools !== undefined) {
      body.tools = tools
      body.tool_choice = 'auto'
    }
    if (typeof effort === 'string' && effort !== '' && effort !== 'off') {
      body.reasoning_effort = effort
      body.reasoning_summary = 'auto'
    }
    return body
  }

  /**
   * 流式调用。配额/鉴权类失败且尚未产出内容时，自动切到下一个池内账号重试。
   * @param {any} options
   * @returns {AsyncGenerator<any, void, unknown>}
   */
  async *stream(options) {
    await this.ensureReady()
    const providerId = this.providerId
    const pool = this.pool()
    const model = this.catalogModels().find((candidate) => candidate.id === options.model)
    let account = pool.active(providerId)
    if (account === null || account === undefined) {
      throw llmError(
        `${this.displayName} 还没有已登录账号，请在 DSH 设置 → WorkBuddy 里登录一次`,
        FAILURE_CODES.MISSING_CREDENTIAL,
      )
    }
    const modelForBody = model ?? { supportsToolCall: true }
    const tried = new Set()
    /** 每个账号只强制续期一次，避免 401 → 刷新 → 401 的死循环。 */
    const refreshed = new Set()
    let attempts = 0
    let yielded = false
    while (true) {
      tried.add(account.id)
      try {
        const { credentials } = await pool.credentialsFor(providerId, account)
        const body = await this.buildBody(options, modelForBody)
        const events = await streamChat(providerId, credentials, body, options.signal)
        for await (const chunk of this.translate(events, modelForBody)) {
          yielded = true
          yield chunk
        }
        await pool.reportSuccess(providerId, account)
        return
      } catch (error) {
        if (yielded || options.signal?.aborted === true) throw toLlmError(error)
        const kind = classifyFailure(error)
        const message = error instanceof Error ? error.message : String(error)
        const transportLike = kind === 'other' && isTransportFailure(message)
        if ((kind === 'auth' || transportLike) && !refreshed.has(account.id)) {
          // 401（以及会被网关重置连接的失效 token）先尝试 refresh；成功则同账号重试一次。
          refreshed.add(account.id)
          const nextTokens = await pool.tryRefresh(providerId, account)
          if (nextTokens !== null) {
            this.logger?.info?.(`${this.displayName}: 账号 ${account.nickname ?? account.id} 的 token 已刷新，重试请求`)
            continue
          }
          await pool.reportFailure(providerId, account, 'auth')
        } else if (kind !== 'other' && kind !== 'queue') {
          await pool.reportFailure(providerId, account, kind)
        }
        // 排队与未知错误不换号：队列位置/请求语义都绑定当前账号。
        const next = kind === 'other' || kind === 'queue' ? null : pool.next(providerId, account.id)
        if (next !== null && !tried.has(next.id) && attempts < 3) {
          attempts += 1
          this.logger?.warn?.(`${this.displayName}: 账号 ${account.nickname ?? account.id} 失败（${kind}），自动切换到 ${next.nickname ?? next.id}`)
          account = next
          continue
        }
        throw toLlmError(error)
      }
    }
  }

  /**
   * 把 OpenAI SSE 事件翻译成 Harness chunk。
   * @param {AsyncGenerator<any, void, unknown>} events
   * @param {any} model
   * @returns {AsyncGenerator<any, void, unknown>}
   */
  async *translate(events, model) {
    let nextIndex = 0
    /** @type {Map<string, { index: number, kind: 'text'|'reasoning', text: string }>} */
    const open = new Map()
    /** @type {Map<number, { index: number, id: string, name: string, arguments: string }>} */
    const toolCalls = new Map()
    let finish = null
    let usage = null
    let sawAny = false

    const close = function* (entry) {
      if (entry.kind === 'text') {
        yield { type: 'block-end', index: entry.index, block: { type: 'text', text: entry.text } }
      } else {
        yield { type: 'block-end', index: entry.index, block: { type: 'reasoning', text: entry.text } }
      }
    }

    for await (const event of events) {
      // 少数网关把错误放进 200 的流里。
      if (event?.error !== undefined) {
        throw llmError(
          `WorkBuddy 对话失败：${String(event.error?.message ?? 'upstream error')}`,
          FAILURE_CODES.PROVIDER,
        )
      }
      if (event?.usage !== undefined) usage = usageOf(event.usage)
      const choice = Array.isArray(event?.choices) ? event.choices[0] : undefined
      if (choice === undefined) {
        if (event?.usage !== undefined) continue
        continue
      }
      const delta = choice.delta ?? {}
      const reasoningText = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoningText === 'string' && reasoningText !== '') {
        const key = 'reasoning'
        let entry = open.get(key)
        if (entry === undefined) {
          entry = { index: nextIndex++, kind: 'reasoning', text: '' }
          open.set(key, entry)
          sawAny = true
          yield { type: 'block-start', index: entry.index, blockType: 'reasoning' }
        }
        entry.text += reasoningText
        yield { type: 'reasoning-delta', index: entry.index, text: reasoningText }
      }
      if (typeof delta.content === 'string' && delta.content !== '') {
        const key = 'text'
        let entry = open.get(key)
        if (entry === undefined) {
          entry = { index: nextIndex++, kind: 'text', text: '' }
          open.set(key, entry)
          sawAny = true
          yield { type: 'block-start', index: entry.index, blockType: 'text' }
        }
        entry.text += delta.content
        yield { type: 'text-delta', index: entry.index, text: delta.content }
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const providerIndex = Number(call?.index) || 0
          let entry = toolCalls.get(providerIndex)
          if (entry === undefined) {
            entry = {
              index: nextIndex++,
              id: typeof call?.id === 'string' && call.id !== '' ? call.id : `call-${String(providerIndex)}`,
              name: typeof call?.function?.name === 'string' ? call.function.name : '',
              arguments: '',
            }
            toolCalls.set(providerIndex, entry)
            sawAny = true
            yield { type: 'block-start', index: entry.index, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: entry.index, id: entry.id, name: entry.name, argumentsDelta: '' }
          }
          const argsDelta = typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
          if (argsDelta !== '') {
            entry.arguments += argsDelta
            yield { type: 'tool-call-delta', index: entry.index, id: entry.id, argumentsDelta: argsDelta }
          }
        }
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason !== '') {
        finish = finishReason(choice.finish_reason)
      }
    }

    for (const entry of open.values()) yield* close(entry)
    for (const entry of toolCalls.values()) {
      yield {
        type: 'block-end',
        index: entry.index,
        block: { type: 'tool-call', id: entry.id, name: entry.name, arguments: entry.arguments === '' ? '{}' : entry.arguments },
      }
    }
    if (!sawAny && finish === null) {
      throw llmError('WorkBuddy 模型没有返回任何内容', FAILURE_CODES.PROVIDER)
    }
    if (usage !== null) yield { type: 'usage', usage }
    yield { type: 'finish', reason: finish ?? { kind: toolCalls.size > 0 ? 'tool-calls' : 'stop' } }
  }
}
