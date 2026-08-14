import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'

import {
  CommandCodeAdapter,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PROVIDER,
  staticCommandCodeCatalogModels,
} from './adapter.ts'
import type { CommandCodeCatalogModel, CommandCodeConnectionOptions } from './adapter.ts'
import {
  DEFAULT_MODELS_CACHE_TTL_MS,
  loadCommandCodeCatalog,
} from './catalog.ts'

export { CommandCodeAdapter, DEFAULT_STREAM_IDLE_TIMEOUT_MS, PROVIDER } from './adapter.ts'
export type { CommandCodeAdapterOptions, CommandCodeCatalogModel, CommandCodeConnectionOptions } from './adapter.ts'
export type { RequestDefaults } from './types.ts'
export type * from './types.ts'

export const name = 'llm-commandcode'
export const inject = ['llm'] as const
export const PUBLIC_BASE_URL = 'https://api.commandcode.ai'
export const DEFAULT_MAX_TOKENS = 64_000
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'
const NS = settingsNamespace('llm-commandcode')

export interface Config {
  apiKeyEnv?: string
  baseURL?: string
  /** Retained as a settings compatibility field; the v1 wire default is 0.3. */
  temperature?: number
  maxTokens?: number
  defaultContextWindow?: number
  /** A non-empty list overrides the discovered and static model catalogs. */
  models?: CommandCodeCatalogModel[]
  /** Cache freshness interval before a silent public catalog refresh. */
  modelsCacheTtlMs?: number
  streamIdleTimeoutMs?: number
  retryPolicy?: RetryPolicyConfig
}

const catalogModel: z<CommandCodeCatalogModel> = z.object({
  id: z.string().required(),
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
})

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel),
  modelsCacheTtlMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MODELS_CACHE_TTL_MS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
})

/** Resolve and validate all non-secret connection facts for one operation. */
export function resolveAdapterOptions(config: Config): CommandCodeConnectionOptions {
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
  const defaultContextWindow = config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const modelsCacheTtlMs = config.modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new Error('llm-commandcode: maxTokens must be a positive safe integer')
  }
  if (!Number.isSafeInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    throw new Error('llm-commandcode: defaultContextWindow must be a positive safe integer')
  }
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-commandcode: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (!Number.isSafeInteger(modelsCacheTtlMs) || modelsCacheTtlMs < 0) {
    throw new Error('llm-commandcode: modelsCacheTtlMs must be a non-negative finite safe integer')
  }
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const models = config.models?.map(model => ({ ...model }))
  if (models !== undefined) {
    const seen = new Set<string>()
    for (const model of models) {
      if (model.id.length === 0 || seen.has(model.id)) throw new Error('llm-commandcode: configured model ids must be unique and non-empty')
      seen.add(model.id)
    }
  }
  return {
    baseURL: config.baseURL ?? PUBLIC_BASE_URL,
    apiKeyEnv,
    workingDir: process.cwd(),
    maxTokens: Math.min(maxTokens, DEFAULT_MAX_TOKENS),
    defaultContextWindow,
    streamIdleTimeoutMs,
    ...models === undefined ? {} : { models },
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'llm-commandcode: retryPolicy'),
  }
}

/** Register the configurable provider, request-time credentials seam, and reversible adapter route. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: CommandCodeConnectionOptions | undefined
  let catalogModels: readonly CommandCodeCatalogModel[] | undefined
  const options = (): CommandCodeConnectionOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const resolved = resolveAdapterOptions(raw)
      const next = catalogModels === undefined ? resolved : { ...resolved, catalogModels }
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-commandcode: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const resolveApiKey = async (connection: CommandCodeConnectionOptions): Promise<string> => {
    const ref = connection.apiKeyEnv
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef(ref))
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-commandcode', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined) return assertUsableApiKey(ambient.value, 'llm-commandcode', ref)
    }
    throw new LlmError(
      `llm-commandcode: no API key for provider route "${PROVIDER}"; configure ${ref} through the credentials service or launch environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new CommandCodeAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Command Code', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  let catalogRefreshActive = true
  ctx.effect(() => () => { catalogRefreshActive = false }, 'llm-commandcode.catalog-refresh')
  const publishCatalog = (models: readonly CommandCodeCatalogModel[]): void => {
    if (!catalogRefreshActive) return
    catalogModels = models
    lastRaw = undefined
    registration.replace([PROVIDER])
  }
  const refreshCatalog = async (): Promise<void> => {
    const catalog = await loadCommandCodeCatalog({
      cachePath: dshHomePath('commandcode', 'models.json'),
      staticModels: staticCommandCodeCatalogModels(),
      ttlMs: current().modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS,
    })
    if (catalog.initial.source === 'cache') publishCatalog(catalog.initial.models)
    if (catalog.initial.warning !== undefined) ctx.logger.debug(`llm-commandcode: ${catalog.initial.warning}`)
    const refreshed = await catalog.refresh
    if (refreshed === undefined) return
    if (refreshed.warning !== undefined) ctx.logger.warn(`llm-commandcode: ${refreshed.warning}`)
    // On failure the initial cache/static fallback remains published. A live
    // result always replaces the route so the UI reloads its model directory.
    if (refreshed.source === 'live') publishCatalog(refreshed.models)
  }
  void refreshCatalog()
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }
  installSettingsSection(ctx, NS, Config, config, {
    setSource: source => { current = source },
    onChange: ensureRegistrationFacts,
  })
}
