import assert from 'node:assert/strict'
import test from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'

import { CommandCodeAdapter } from '../src/adapter.ts'
import { collect } from './assemble.ts'
import { createMockServer } from './mock-server.ts'

const encoder = new TextEncoder()
const key = 'test-command-code-key'
const options = (signal?: AbortSignal) => ({
  provider: 'commandcode', model: 'gpt-5.6-luna', messages: [], signal,
})

function adapter(url: string, overrides: Partial<ConstructorParameters<typeof CommandCodeAdapter>[0]> = {}): CommandCodeAdapter {
  return new CommandCodeAdapter({
    options: () => ({
      baseURL: url,
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      workingDir: '/Example Project',
      maxTokens: 64_000,
      defaultContextWindow: 1_000_000,
      streamIdleTimeoutMs: 100,
    }),
    resolveApiKey: async () => key,
    ...overrides,
  })
}

test('streams text, tool calls, and usage over Command Code transport with complete headers', async (t) => {
  const server = await createMockServer({ chunks: [encoder.encode([
    '{"type":"text-delta","text":"hi"}',
    '{"type":"tool-call","toolCallId":"call_1","toolName":"read","input":{"path":"a"}}',
    '{"type":"finish","finishReason":"tool-calls","totalUsage":{"inputTokens":10,"outputTokens":2}}',
  ].join('\n'))] })
  t.after(() => server.close())

  const chunks = await collect(adapter(server.url).stream(options()))
  assert.deepEqual(chunks.map(chunk => chunk.type), [
    'block-start', 'text-delta', 'block-start', 'tool-call-delta', 'block-end', 'block-end', 'usage', 'finish',
  ])
  const request = await server.capturedRequest
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/alpha/generate')
  assert.equal(request.headers.authorization, `Bearer ${key}`)
  assert.equal(request.headers['content-type'], 'application/json')
  assert.equal(request.headers['x-command-code-version'], '1.15.1')
  assert.equal(request.headers['x-cli-environment'], 'production')
  assert.equal(request.headers['x-project-slug'], 'example-project')
  assert.equal(request.headers['x-taste-learning'], 'true')
  assert.equal(request.headers['x-co-flag'], 'false')
  assert.match(String(request.headers['user-agent']), /deepseek-harness/)
  assert.equal(JSON.parse(request.body).params.model, 'gpt-5.6-luna')
})

test('maps provider status failures', async (t) => {
  for (const [status, body, code] of [
    [401, '{"message":"unauthorized"}', 'AUTH'],
    [403, '{"message":"forbidden"}', 'AUTH'],
    [429, '{"message":"rate limit"}', 'RATE_LIMIT'],
    [400, '{"message":"context_length_exceeded"}', 'CONTEXT_WINDOW_EXCEEDED'],
    [500, '{"message":"gateway"}', 'SERVER'],
  ] as const) {
    const server = await createMockServer({ status, chunks: [encoder.encode(body)] })
    t.after(() => server.close())
    await assert.rejects(collect(adapter(server.url).stream(options())), { code })
  }
})

test('classifies and redacts plain-text HTTP failure bodies', async (t) => {
  const secret = 'cc_abcdefghijk'
  for (const [status, body, code] of [
    [400, 'context_length_exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    [429, `rate limit: ${secret}`, 'RATE_LIMIT'],
  ] as const) {
    const server = await createMockServer({ status, chunks: [encoder.encode(body)] })
    t.after(() => server.close())
    let error: unknown
    try {
      await collect(adapter(server.url).stream(options()))
    } catch (caught: unknown) {
      error = caught
    }
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, code)
    assert.equal(error.message.includes(secret), false)
  }
})

test('cancels upstream when consumer returns before finish', async (t) => {
  const server = await createMockServer({
    hangAfterLast: true,
    chunks: [encoder.encode('{"type":"text-delta","text":"partial"}\n')],
  })
  t.after(() => server.close())

  const iterator = adapter(server.url).stream(options())[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), {
    done: false,
    value: { type: 'block-start', index: 0, blockType: 'text' },
  })
  await iterator.return()
  await server.cancelled
})

test('maps caller abort and idle watchdog, and cancels an open body after finish', async (t) => {
  const abortServer = await createMockServer({ delayBeforeReadMs: 100 })
  t.after(() => abortServer.close())
  const caller = new AbortController()
  const aborted = collect(adapter(abortServer.url).stream(options(caller.signal)))
  caller.abort()
  await assert.rejects(aborted, { code: 'ABORTED' })

  const idleServer = await createMockServer({ hangAfterLast: true, chunks: [encoder.encode('\n')] })
  t.after(() => idleServer.close())
  await assert.rejects(collect(adapter(idleServer.url, {
    options: () => ({ baseURL: idleServer.url, apiKeyEnv: 'COMMANDCODE_API_KEY', workingDir: '/', maxTokens: 1, defaultContextWindow: 1, streamIdleTimeoutMs: 10 }),
  }).stream(options())), { code: 'TIMEOUT' })

  const finishServer = await createMockServer({
    hangAfterLast: true,
    chunks: [encoder.encode('{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n')],
  })
  t.after(() => finishServer.close())
  await collect(adapter(finishServer.url).stream(options()))
  await finishServer.cancelled
})

test('lists model metadata and resolves known and unknown models as text-only', async () => {
  const instance = adapter('http://localhost')
  const models = await instance.listModels('commandcode')
  assert.ok(models.length > 0)
  assert.deepEqual(models.find(model => model.id === 'gpt-5.6-luna'), {
    provider: 'commandcode', id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', inputModalities: ['text'],
  })

  const known = await instance.resolveModel('commandcode', 'gpt-5.6-luna')
  assert.deepEqual(known.inputModalities, ['text'])
  assert.equal(known.defaultMaxTokens, 64_000)
  assert.deepEqual(known.reasoning?.efforts.map(entry => entry.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  const unknown = await instance.resolveModel('commandcode', 'unknown')
  assert.deepEqual(unknown.inputModalities, ['text'])
  assert.equal(unknown.reasoning, undefined)
})

test('an empty settings models array falls back to the static capability snapshot', async () => {
  const empty = new CommandCodeAdapter({
    options: () => ({
      baseURL: 'http://localhost',
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      workingDir: '/Example Project',
      maxTokens: 64_000,
      defaultContextWindow: 1_000_000,
      streamIdleTimeoutMs: 100,
      // A settings section materializes an absent `models` as `[]`; it must
      // not clear the catalog that a custom list would otherwise override.
      models: [],
    }),
    resolveApiKey: async () => key,
  })
  const models = await empty.listModels('commandcode')
  assert.ok(models.length > 0)
  assert.ok(models.some(model => model.id === 'gpt-5.6-luna'))
  const resolved = await empty.resolveModel('commandcode', 'gpt-5.6-luna')
  assert.equal(resolved.defaultMaxTokens, 64_000)
})
