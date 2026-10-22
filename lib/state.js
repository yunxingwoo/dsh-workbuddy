/**
 * 插件持久状态：账号池、目录缓存、逐模型开关、积分快照。
 *
 * 文件放在 `$DSH_HOME/workbuddy/state.json`（权限 0600），与 DSH 的 profile
 * 配置分开：token 属于本地凭据，不进 YAML；目录与勾选状态是可重建缓存。
 * 写入用「临时文件 + rename」保证崩溃时不会留下半截 JSON。
 * @module dsh-workbuddy/state
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 解析 DSH 主目录：优先 DSH_HOME，否则 ~/.dsh。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 插件状态文件路径。 */
export function statePath() {
  return join(dshHome(), 'workbuddy', 'state.json')
}

/** 新建一个空状态。 */
export function emptyState() {
  return { version: 1, providers: {} }
}

/**
 * 取某个 provider 的状态切片，缺失时补空。
 * @param {any} state
 * @param {string} providerId
 */
export function providerState(state, providerId) {
  const providers = state.providers ?? (state.providers = {})
  const existing = providers[providerId]
  if (existing !== undefined && existing !== null) {
    existing.accounts ??= []
    existing.modelSettings ??= {}
    return existing
  }
  const created = { accounts: [], activeAccountId: null, modelSettings: {}, catalog: null, credits: null, checkin: null }
  providers[providerId] = created
  return created
}

/** @returns {Promise<any>} */
export async function loadState() {
  try {
    const text = await readFile(statePath(), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return emptyState()
    parsed.version ??= 1
    parsed.providers ??= {}
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw error
  }
}

/** 复制状态并移除账号 token 字段（持久化前的最后一道防线）。 */
function stripSecretFields(state) {
  const providers = state?.providers
  if (providers === null || typeof providers !== 'object') return state
  const copy = { ...state, providers: {} }
  for (const [providerId, slice] of Object.entries(providers)) {
    const accounts = Array.isArray(slice?.accounts)
      ? slice.accounts.map((account) => {
        if (account === null || typeof account !== 'object') return account
        const { accessToken: _accessToken, refreshToken: _refreshToken, ...rest } = account
        return rest
      })
      : slice?.accounts
    copy.providers[providerId] = { ...slice, accounts }
  }
  return copy
}

/**
 * 原子写入状态（0600）。
 * `stripSecrets` 为 true 时移除账号里的 token 字段（token 已在 credentials）。
 * @param {any} state
 * @param {{ stripSecrets?: boolean }} [options]
 */
export async function saveState(state, options = {}) {
  const path = statePath()
  await mkdir(dirname(path), { recursive: true })
  const payload = options.stripSecrets === true ? stripSecretFields(state) : state
  const temp = `${path}.${String(process.pid)}.${Date.now().toString(36)}.tmp`
  await writeFile(temp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(temp, 0o600)
  } catch {
    // Windows / 特殊文件系统不强制 chmod；忽略。
  }
  await rename(temp, path)
}
