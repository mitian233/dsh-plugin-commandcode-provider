import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

import { collect } from './assemble.ts'
import { createMockServer } from './mock-server.ts'
import { apply } from '../src/index.ts'
import { createApply } from '../src/apply.ts'
import type { ApplyDependencies } from '../src/apply.ts'
import type { CommandCodeOAuthCoordinator } from '../src/oauth.ts'

type CatalogLoader = NonNullable<ApplyDependencies['loadCatalog']>

const staticCatalogLoader: CatalogLoader = async ({ staticModels }) => ({
  initial: { models: staticModels, source: 'static' },
})

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

class TestCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly value: string | undefined) {
    super(ctx)
  }

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return Promise.resolve(this.value === undefined ? undefined : { value: this.value, source: 'test' })
  }

  override describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({ configured: this.value !== undefined && this.value.length > 0, writable: false })
  }

  override set(): Promise<void> { return Promise.reject(new Error('read-only test credentials')) }
  override unset(): Promise<void> { return Promise.reject(new Error('read-only test credentials')) }
}

class TestSettings extends SettingsProvider {
  override readonly writable = true
  private readonly document: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.document))
  }

  protected override persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.document[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

function options() {
  return { provider: 'commandcode', model: 'gpt-5.6-luna', messages: [] }
}

function finishCode(chunks: unknown[]): string | undefined {
  return (chunks.at(-1) as { reason?: { failure?: { code?: string } } } | undefined)?.reason?.failure?.code
}

async function assertNoRequest(server: Awaited<ReturnType<typeof createMockServer>>): Promise<void> {
  const requested = await Promise.race([
    server.capturedRequest.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 25)),
  ])
  assert.equal(requested, false)
}

async function boot(config: {
  baseURL: string
  credentialValue?: string
  ambientValue?: string
  settings?: boolean
  catalogFetch?: typeof fetch
  catalogLoader?: CatalogLoader
}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: config.ambientValue === undefined ? {} : { COMMANDCODE_API_KEY: config.ambientValue } },
  ]))
  if (config.credentialValue !== undefined || 'credentialValue' in config) {
    await ctx.plugin(TestCredentials, config.credentialValue)
  }
  if (config.settings === true) await ctx.plugin(TestSettings)
  createApply({
    fetchImpl: config.catalogFetch,
    loadCatalog: config.catalogLoader ?? staticCatalogLoader,
  })(ctx, { apiKeyEnv: 'COMMANDCODE_API_KEY', baseURL: config.baseURL })
  return ctx
}

test('public apply keeps the two-argument production signature without test seams', () => {
  assert.equal(typeof apply, 'function')
  assert.equal(apply.length, 2)
})

test('apply registers the configurable provider and adapter reversibly', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  createApply({ loadCatalog: staticCatalogLoader })(ctx, { apiKeyEnv: 'COMMANDCODE_API_KEY' })
  const llm = ctx.llm

  assert.deepEqual(llm.listProviders(), [{ id: 'commandcode', name: 'Command Code' }])
  assert.deepEqual(llm.listConfigurableProviders(), [{
    provider: 'commandcode', displayName: 'Command Code', settingsNs: 'llm-commandcode', settingsPath: [],
  }])
  await ctx.fiber.dispose()
  assert.deepEqual(llm.listProviders(), [])
  assert.deepEqual(llm.listConfigurableProviders(), [])
})

test('disposing the plugin coordinator closes OAuth resources', async () => {
  let disposed = false
  const coordinator: CommandCodeOAuthCoordinator = {
    session: { state: 'idle' },
    start: async () => 'https://commandcode.ai',
    status: () => ({ state: 'idle' }),
    dispose: () => { disposed = true },
    routes: {
      onStart: () => undefined,
      onStatus: () => undefined,
    },
  }
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  createApply({
    loadCatalog: staticCatalogLoader,
    createOAuthCoordinator: () => coordinator,
  })(ctx, { apiKeyEnv: 'COMMANDCODE_API_KEY' })

  await ctx.fiber.dispose()
  assert.equal(disposed, true)
})

test('catalog startup uses injected fresh, stale, and missing cache outcomes without public fetches', async (t) => {
  const fresh = await boot({
    baseURL: 'http://127.0.0.1:1',
    catalogLoader: async ({ signal }) => ({
      initial: { models: [{ id: 'fresh', contextWindow: 12_345 }], source: 'cache', fetchedAt: 1_000 },
    }),
  })
  t.after(() => fresh.fiber.dispose())
  await nextTurn()
  assert.deepEqual((await fresh.llm.listModels('commandcode')).map(model => model.id), ['fresh'])

  const refresh = deferred<{ models: readonly { id: string; contextWindow: number }[]; source: 'live'; fetchedAt: number }>()
  const stale = await boot({
    baseURL: 'http://127.0.0.1:1',
    catalogLoader: async () => ({
      initial: { models: [{ id: 'stale', contextWindow: 12_345 }], source: 'cache', fetchedAt: 1 },
      refresh: refresh.promise,
    }),
  })
  t.after(() => stale.fiber.dispose())
  await nextTurn()
  assert.deepEqual((await stale.llm.listModels('commandcode')).map(model => model.id), ['stale'])
  let liveUpdates = 0
  stale.on('llm/adapters-updated', () => { liveUpdates += 1 })
  refresh.resolve({ models: [{ id: 'live', contextWindow: 54_321 }], source: 'live', fetchedAt: 2_000 })
  await nextTurn()
  assert.equal(liveUpdates, 1)
  assert.deepEqual((await stale.llm.listModels('commandcode')).map(model => model.id), ['live'])

  const missing = await boot({
    baseURL: 'http://127.0.0.1:1',
    catalogLoader: async ({ staticModels }) => ({
      initial: { models: staticModels, source: 'static', warning: 'cache missing' },
      refresh: Promise.resolve({ models: staticModels, source: 'static', warning: 'offline' }),
    }),
  })
  t.after(() => missing.fiber.dispose())
  await nextTurn()
  assert.ok((await missing.llm.listModels('commandcode')).some(model => model.id === 'gpt-5.6-luna'))
})

test('disposing aborts a controlled catalog fetch without replacing the adapter route', async () => {
  const started = deferred<void>()
  let receivedSignal: AbortSignal | undefined
  const catalogFetch: typeof fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    assert.ok(signal instanceof AbortSignal)
    receivedSignal = signal
    started.resolve()
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const ctx = await boot({
    baseURL: 'http://127.0.0.1:1',
    catalogFetch,
    catalogLoader: async ({ fetchImpl, signal }) => {
      assert.equal(fetchImpl, catalogFetch)
      try {
        await fetchImpl?.('http://catalog.test/models', { signal })
      } catch {
        // The loader returns after cancellation so apply can prove it publishes nothing.
      }
      return { initial: { models: [{ id: 'late', contextWindow: 12_345 }], source: 'cache', fetchedAt: 1 } }
    },
  })
  await started.promise
  let topologyUpdates = 0
  ctx.on('llm/adapters-updated', () => { topologyUpdates += 1 })

  await ctx.fiber.dispose()
  await nextTurn()

  assert.equal(receivedSignal?.aborted, true)
  assert.equal(topologyUpdates, 0)
})

test('credentials service misses do not fall back to launch environment', async (t) => {
  const server = await createMockServer()
  t.after(() => server.close())
  const ctx = await boot({ baseURL: server.url, credentialValue: undefined, ambientValue: 'ambient-key' })
  t.after(() => ctx.fiber.dispose())

  assert.equal(finishCode(await collect(ctx.llm.stream(options()))), 'MISSING_CREDENTIAL')
  await assertNoRequest(server)
})

test('uses launch environment only when no credentials service is mounted', async (t) => {
  const server = await createMockServer({ chunks: [new TextEncoder().encode(
    '{"type":"text-delta","text":"ok"}\n{"type":"finish","finishReason":"stop"}\n',
  )] })
  t.after(() => server.close())
  const ctx = await boot({ baseURL: server.url, ambientValue: 'ambient-key' })
  t.after(() => ctx.fiber.dispose())

  assert.equal(finishCode(await collect(ctx.llm.stream(options()))), undefined)
  assert.equal((await server.capturedRequest).headers.authorization, 'Bearer ambient-key')
})

test('rejects blank, whitespace, and header-invalid credential service values before fetch', async (t) => {
  for (const value of ['', '   ', 'bad\nkey']) {
    await t.test(JSON.stringify(value), async (t) => {
      const server = await createMockServer()
      t.after(() => server.close())
      const ctx = await boot({ baseURL: server.url, credentialValue: value })
      t.after(() => ctx.fiber.dispose())

      assert.equal(finishCode(await collect(ctx.llm.stream(options()))), 'INVALID_CREDENTIAL')
      await assertNoRequest(server)
    })
  }
})

test('retry-policy settings changes replace the route and update its captured policy', async (t) => {
  const ctx = await boot({ baseURL: 'http://127.0.0.1:1', settings: true })
  t.after(() => ctx.fiber.dispose())
  let topologyUpdates = 0
  ctx.on('llm/adapters-updated', () => { topologyUpdates += 1 })
  // A stale on-disk catalog may complete its permitted background refresh
  // immediately after boot; count only the settings-triggered replacement.
  await new Promise(resolve => setTimeout(resolve, 0))
  const updatesBeforeSettings = topologyUpdates

  await ctx.settings.update('llm-commandcode', {
    retryPolicy: { mode: 'always', backoff: { initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2 } },
  })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.ok(topologyUpdates >= updatesBeforeSettings + 1)
  assert.deepEqual(ctx.llm.listProviders(), [{ id: 'commandcode', name: 'Command Code' }])
  assert.deepEqual(ctx.llm.providerRetryPolicy('commandcode'), {
    mode: 'always', initialDelayMs: 25, maxDelayMs: 100, jitterRatio: 0.2,
  })
})
