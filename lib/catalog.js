/**
 * 模型目录：把 WorkBuddy 云端产品目录（`/v3/config`）或本机缓存，归一成
 * DSH 模型选择器要的模型元数据，同时保留「积分倍率」这一只读读数。
 *
 * 倍率完全来自上游字段 `credits`（"x0.79"、"x0.34 credits"、"" 都出现过），
 * 插件不写死、不猜：解析不出就是 null，UI 显示「—」。
 * 「逐模型开关图片输入」也以这里解析出的 `supportsImages` 为初值，用户勾选后
 * 由 state.modelSettings 覆盖。
 * @module dsh-workbuddy/catalog
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { PROVIDERS } from './api.js'

/**
 * 解析上游 credits 文案为倍率数值。
 * @param {unknown} raw
 * @returns {number|null} 例如 "x0.79" → 0.79；无值/无法解析 → null
 */
export function parseCreditMultiplier(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return null
  const match = /x\s*([0-9]+(?:\.[0-9]+)?)/i.exec(raw)
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/** 把 `~/...` 展开成本机绝对路径。 */
function expandHome(path) {
  return path.startsWith('~/') ? `${homedir()}/${path.slice(2)}` : path
}

/**
 * 读取本机桌面端缓存的云端产品目录（无需 token）。
 * @param {'workbuddy'|'workbuddy-global'} providerId
 * @returns {Promise<{ config: any, path: string } | null>}
 */
export async function readLocalProductConfig(providerId) {
  const provider = PROVIDERS[providerId]
  if (!provider) return null
  for (const candidate of provider.localConfigPaths ?? []) {
    const path = expandHome(candidate)
    try {
      const text = await readFile(path, 'utf8')
      const config = JSON.parse(text)
      if (config !== null && typeof config === 'object' && Array.isArray(config.models)) {
        return { config, path }
      }
    } catch {
      // 下一个候选路径。
    }
  }
  return null
}

/**
 * WorkBuddy 接受的 reasoning effort 词表（来自桌面端 CLI 的
 * `ReasoningEffortSupportRule` 与 `["off","minimal","low","medium","high","xhigh","max"]`）。
 * 上游按模型映射；插件不裁剪，只在模型声明 supportsReasoning 时开放。
 */
export const REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 解析模型的 reasoning 元数据。
 * @param {any} model
 * @returns {{ efforts: string[], defaultEffort?: string } | undefined}
 */
export function reasoningInfo(model) {
  if (model?.supportsReasoning !== true) return undefined
  const advertised = Array.isArray(model?.reasoning?.supportedEfforts)
    ? model.reasoning.supportedEfforts.filter((effort) => typeof effort === 'string' && effort !== '')
    : undefined
  let efforts = advertised !== undefined && advertised.length > 0 ? advertised : [...REASONING_EFFORTS]
  // onlyReasoning 模型无法关闭推理：不要向上层承诺一个 'off' 选项。
  if (model?.onlyReasoning === true) efforts = efforts.filter((effort) => effort !== 'off')
  if (efforts.length === 0) efforts = ['medium']
  const declared = typeof model?.reasoning?.effort === 'string' ? model.reasoning.effort : undefined
  const defaultEffort = declared !== undefined && efforts.includes(declared) ? declared : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/** 上游目录里与对话无关的模型标签（图片/视频生成等），不进入模型选择器。 */
const NON_CHAT_TAGS = new Set([
  'text-to-image',
  'image-to-image',
  'text-to-video',
  'image-to-video',
  'text-to-speech',
  'speech-to-text',
])

/** 明确不是通用对话模型的 id。 */
const NON_CHAT_IDS = new Set(['wb-lite', 'completion-gf'])

/** 补全/改写/跳转等编辑器辅助模型：不是对话模型。 */
const NON_CHAT_ID_PATTERN = /^(?:codewise|completion|nes|rewrite|jump|inline)/i

/**
 * 把云端 `models[]` 归一成插件内部模型描述。
 * @param {any[]} models
 * @returns {any[]}
 */
export function normalizeModels(models) {
  /** @type {any[]} */
  const result = []
  const seen = new Set()
  for (const model of models ?? []) {
    if (model === null || typeof model !== 'object') continue
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    const tags = Array.isArray(model.tags) ? model.tags.map(String) : []
    if (NON_CHAT_IDS.has(id) || NON_CHAT_ID_PATTERN.test(id)) continue
    if (tags.some((tag) => NON_CHAT_TAGS.has(tag))) continue
    const contextWindow = Number(model.maxInputTokens) > 0 ? Number(model.maxInputTokens) : undefined
    const maxOutputTokens = Number(model.maxOutputTokens) > 0 ? Number(model.maxOutputTokens) : undefined
    // 没有上下文窗口、输出上限又极小的条目是编辑器小模型，不是对话模型。
    if (contextWindow === undefined && (maxOutputTokens === undefined || maxOutputTokens <= 512)) continue
    const multiplier = parseCreditMultiplier(model.credits)
    const reasoning = reasoningInfo(model)
    const description = typeof model.descriptionZh === 'string' && model.descriptionZh.trim() !== ''
      ? model.descriptionZh.trim()
      : typeof model.descriptionEn === 'string' ? model.descriptionEn.trim() : ''
    seen.add(id)
    result.push({
      id,
      name: typeof model.name === 'string' && model.name.trim() !== '' ? model.name.trim() : id,
      vendor: typeof model.vendor === 'string' ? model.vendor : '',
      description,
      creditText: typeof model.credits === 'string' ? model.credits : '',
      multiplier,
      supportsImages: model.supportsImages === true && model.disabledMultimodal !== true,
      supportsToolCall: model.supportsToolCall !== false,
      supportsReasoning: model.supportsReasoning === true,
      onlyReasoning: model.onlyReasoning === true,
      temperature: typeof model.temperature === 'number' ? model.temperature : undefined,
      reasoning,
      contextWindow,
      maxOutputTokens,
      tags,
      isDefault: model.isDefault === true,
    })
  }
  return result
}

/**
 * 从产品目录里取模型数组（云端信封是 `{code,msg,data:{models}}`，缓存文件是目录本体）。
 * @param {any} config
 * @returns {any[]}
 */
export function modelsFromProductConfig(config) {
  if (config === null || typeof config !== 'object') return []
  if (Array.isArray(config.models)) return config.models
  if (config.data !== null && typeof config.data === 'object' && Array.isArray(config.data.models)) return config.data.models
  return []
}

/**
 * 计算某个 provider 的可见模型列表：目录 × 用户勾选。
 *
 * - 目录里从未出现过的模型默认启用（新模型自动出现）；
 * - `modelSettings[id].enabled === false` 时隐藏；
 * - `modelSettings[id].image` 覆盖目录的 supportsImages；
 * - 模型按目录顺序返回。
 * @param {any[]} catalogModels 已 normalize 的目录
 * @param {Record<string, { enabled?: boolean, image?: boolean }>} modelSettings
 * @returns {any[]}
 */
export function effectiveModels(catalogModels, modelSettings = {}) {
  /** @type {any[]} */
  const models = []
  for (const model of catalogModels ?? []) {
    const setting = modelSettings[model.id] ?? {}
    if (setting.enabled === false) continue
    const image = setting.image === undefined ? model.supportsImages ?? model.image ?? false : setting.image === true
    models.push({ ...model, image })
  }
  return models
}

/**
 * 目录快照的展示用摘要。
 * @param {any[]} models
 */
export function catalogSummary(models) {
  const withMultiplier = models.filter((model) => model.multiplier !== null)
  const cheapest = withMultiplier.reduce((best, model) => (best === null || model.multiplier < best.multiplier ? model : best), null)
  return {
    count: models.length,
    withMultiplier: withMultiplier.length,
    cheapest: cheapest === null ? null : { id: cheapest.id, name: cheapest.name, multiplier: cheapest.multiplier },
  }
}
