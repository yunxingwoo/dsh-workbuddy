import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCreditMultiplier, normalizeModels, effectiveModels, reasoningInfo } from '../lib/catalog.js'
import { parseSse } from '../lib/api.js'
import { classifyFailure, sanitizeSystemText, llmError } from '../lib/adapter.js'
import { providerState, emptyState } from '../lib/state.js'
import { accountFromAuth, accountView } from '../lib/pool.js'

test('parseCreditMultiplier reads only upstream xN text', () => {
  assert.equal(parseCreditMultiplier('x0.79'), 0.79)
  assert.equal(parseCreditMultiplier('x0.34 credits'), 0.34)
  assert.equal(parseCreditMultiplier('x0.00'), 0)
  assert.equal(parseCreditMultiplier(''), null)
  assert.equal(parseCreditMultiplier('0.5'), null)
  assert.equal(parseCreditMultiplier('xabc'), null)
  assert.equal(parseCreditMultiplier(1.2), 1.2)
})

test('normalizeModels drops editor helpers and media generators', () => {
  const models = normalizeModels([
    { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79', maxInputTokens: 1000000, maxOutputTokens: 64000, supportsImages: true, supportsReasoning: true, reasoning: { effort: 'medium' } },
    { id: 'codewise-completions', name: 'completions', maxOutputTokens: 256 },
    { id: 'hunyuan-image-alpha', name: 'Image', tags: ['text-to-image'] },
    { id: 'deepseek-v4-flash', name: 'Flash', credits: 'x0.17', maxInputTokens: 1000000, maxOutputTokens: 50000 },
    { id: 'glm-5.3', name: 'dup', credits: 'x9.99' },
  ])
  assert.deepEqual(models.map((model) => model.id), ['glm-5.3', 'deepseek-v4-flash'])
  assert.equal(models[0].multiplier, 0.79)
  assert.equal(models[0].image ?? models[0].supportsImages, true)
  assert.equal(models[1].reasoning, undefined)
})

test('reasoningInfo advertises upstream efforts and default', () => {
  assert.deepEqual(reasoningInfo({ supportsReasoning: true, reasoning: { effort: 'medium' } }).efforts, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(reasoningInfo({ supportsReasoning: true, reasoning: { effort: 'medium' } }).defaultEffort, 'medium')
  assert.deepEqual(reasoningInfo({ supportsReasoning: true, reasoning: { effort: 'turbo', supportedEfforts: ['low', 'high'] } }), { efforts: ['low', 'high'] })
  assert.equal(reasoningInfo({ supportsReasoning: false }), undefined)
})

test('effectiveModels applies per-model enabled and image overrides', () => {
  const catalog = [
    { id: 'a', image: true },
    { id: 'b', image: false },
    { id: 'c', image: true },
  ]
  const models = effectiveModels(catalog, { a: { enabled: false }, b: { image: true } })
  assert.deepEqual(models.map((model) => [model.id, model.image]), [['b', true], ['c', true]])
})

test('parseSse tolerates chunk splits, comments and DONE', async () => {
  const encoder = new TextEncoder()
  const parts = [': heartbeat\ndata: {"a":1}\n\ndata: {"b":2}\n', '\ndata: [DONE]\n\n']
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseSse(stream)) events.push(event)
  assert.deepEqual(events, [{ a: 1 }, { b: 2 }])
})

test('classifyFailure routes auth, quota and rate-limit', () => {
  assert.equal(classifyFailure({ status: 401 }), 'auth')
  assert.equal(classifyFailure({ code: 14001 }), 'quota')
  assert.equal(classifyFailure({ status: 429 }), 'quota')
  assert.equal(classifyFailure({ code: 6020 }), 'queue')
  assert.equal(classifyFailure({ code: 11128 }), 'other')
  assert.equal(classifyFailure({ message: '额度已用完' }), 'quota')
})

test('sanitizeSystemText only rewrites the blocked product name', () => {
  assert.equal(sanitizeSystemText('You are an AI agent powered by DeepSeek Harness.'), 'You are an AI agent powered by DSH.')
  assert.equal(sanitizeSystemText('plain text'), 'plain text')
})

test('llmError keeps a routable code for the host normalizer', () => {
  const error = llmError('no account', 'MISSING_CREDENTIAL')
  assert.equal(error.code, 'MISSING_CREDENTIAL')
  assert.equal(error.failure.code, 'MISSING_CREDENTIAL')
  assert.ok(error instanceof Error)
})

test('providerState creates the slice shape', () => {
  const state = emptyState()
  const slice = providerState(state, 'workbuddy')
  assert.deepEqual(slice.accounts, [])
  assert.deepEqual(slice.modelSettings, {})
  assert.equal(providerState(state, 'workbuddy'), slice)
})

test('accountFromAuth/accountView never expose tokens', () => {
  const record = accountFromAuth(
    { uid: 'u1', nickname: 'tester', type: 'personal', enterpriseId: 'e1' },
    { accessToken: 'a'.repeat(20), refreshToken: 'r'.repeat(20), expiresIn: 3600 },
  )
  assert.equal(record.id, 'u1')
  assert.ok(record.expiresAt > Date.now())
  const view = accountView(record, 'u1')
  assert.equal(view.active, true)
  assert.equal('accessToken' in view, false)
  assert.equal('refreshToken' in view, false)
})

// ---------------------------------------------------------------------------
// token 迁移到 credentials
// ---------------------------------------------------------------------------

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountPool } from '../lib/pool.js'
import { tokenKey, TokenStore } from '../lib/tokens.js'
import { saveState } from '../lib/state.js'
import { toLlmError } from '../lib/adapter.js'

class FakeCredentials {
  records = new Map()
  async readRecord(key) { return this.records.get(key) }
  async modifyRecord(key, mutate) {
    const next = await mutate(this.records.get(key))
    if (next === undefined) this.records.delete(key)
    else this.records.set(key, next)
  }
  async deleteRecord(key) { this.records.delete(key) }
}

test('classifyFailure treats queue codes separately from rate limits', () => {
  assert.equal(classifyFailure({ code: 6020 }), 'queue')
  assert.equal(classifyFailure({ code: 6022 }), 'queue')
  assert.equal(classifyFailure({ code: 6003 }), 'rate-limit')
  assert.equal(classifyFailure({ code: 14003 }), 'rate-limit')
  assert.equal(classifyFailure({ code: 14001 }), 'quota')
})

test('toLlmError maps upstream failures to Harness codes', () => {
  assert.equal(toLlmError({ status: 401, message: 'x' }).code, 'AUTH')
  assert.equal(toLlmError({ status: 429, message: 'x' }).code, 'QUOTA')
  assert.equal(toLlmError({ code: 14001, message: 'x' }).code, 'QUOTA')
  assert.equal(toLlmError({ code: 6020, message: 'queued' }).code, 'RATE_LIMIT')
  assert.equal(toLlmError({ code: 11128, message: 'channel' }).code, 'PROVIDER')
  assert.equal(toLlmError({ status: 400, message: 'maximum context length exceeded' }).code, 'CONTEXT_WINDOW_EXCEEDED')
  const original = toLlmError({ status: 500, message: 'boom' })
  assert.equal(toLlmError(original), original)
})

test('TokenStore writes/list records and never leaks into state', async () => {
  const credentials = new FakeCredentials()
  const state = emptyState()
  const tokens = new TokenStore({ credentials, state, persist: async () => {} })
  const pool = new AccountPool(state, async () => {}, { tokens })
  const record = accountFromAuth({ uid: 'u1', nickname: 'n1' }, { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresIn: 3600 })
  const stored = await pool.upsert('workbuddy', record)
  assert.equal('accessToken' in stored, false)
  assert.equal('accessToken' in state.providers.workbuddy.accounts[0], false)
  const recordKey = tokenKey('workbuddy', 'u1')
  const raw = credentials.records.get(recordKey)
  assert.equal(raw.kind, 'grant')
  assert.equal(raw.payload.accessToken, 'a'.repeat(24))
  const { credentials: creds } = await pool.credentialsFor('workbuddy', state.providers.workbuddy.accounts[0])
  assert.equal(creds.accessToken, 'a'.repeat(24))
  assert.equal(creds.refreshToken, 'r'.repeat(24))
  await pool.remove('workbuddy', 'u1')
  assert.equal(credentials.records.has(recordKey), false)
  assert.equal(state.providers.workbuddy.accounts.length, 0)
})

test('AccountPool.migrate moves legacy plaintext tokens into credentials', async () => {
  const credentials = new FakeCredentials()
  const state = emptyState()
  state.providers.workbuddy = {
    accounts: [{ id: 'legacy', uid: 'legacy', accessToken: 'old'.repeat(8), refreshToken: 'r'.repeat(16), expiresAt: Date.now() + 3_600_000, needsLogin: false, cooldownUntil: 0 }],
    activeAccountId: 'legacy',
    modelSettings: {},
  }
  const tokens = new TokenStore({ credentials, state, persist: async () => {} })
  const pool = new AccountPool(state, async () => {}, { tokens })
  await pool.migrate()
  assert.equal('accessToken' in state.providers.workbuddy.accounts[0], false)
  assert.equal(credentials.records.get(tokenKey('workbuddy', 'legacy')).payload.accessToken, 'old'.repeat(8))
})

test('TokenStore falls back to state when credentials are absent', async () => {
  const state = emptyState()
  state.providers.workbuddy = {
    accounts: [{ id: 'u1', accessToken: 'plain'.repeat(6), expiresAt: Date.now() + 60_000, needsLogin: false, cooldownUntil: 0 }],
    activeAccountId: 'u1',
    modelSettings: {},
  }
  const tokens = new TokenStore({ credentials: null, state, persist: async () => {} })
  assert.equal(tokens.secure, false)
  const hit = await tokens.read('workbuddy', 'u1')
  assert.equal(hit.accessToken, 'plain'.repeat(6))
})

test('saveState(stripSecrets) never writes token fields', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dshwb-state-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const state = emptyState()
    state.providers.workbuddy = {
      accounts: [{ id: 'u1', accessToken: 'secret-access', refreshToken: 'secret-refresh', needsLogin: false, cooldownUntil: 0 }],
      activeAccountId: 'u1',
      modelSettings: {},
    }
    await saveState(state, { stripSecrets: true })
    const text = await readFile(join(home, 'workbuddy/state.json'), 'utf8')
    assert.equal(text.includes('secret-access'), false)
    assert.equal(text.includes('secret-refresh'), false)
    const parsed = JSON.parse(text)
    assert.equal(parsed.providers.workbuddy.accounts[0].id, 'u1')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
})
