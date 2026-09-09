import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Type-only: activates dsh-settings' `declare module '@deepseek-ai/cordis'`
// augmentation that merges `ctx.settings` (SettingsProvider) into Context.
import type {} from '@deepseek-ai/dsh-settings'

import { CommandCodeAdapter, PROVIDER, staticCommandCodeCatalogModels } from './adapter.ts'
import type { CommandCodeCatalogModel, CommandCodeConnectionOptions } from './adapter.ts'
import { DEFAULT_MODELS_CACHE_TTL_MS, loadCommandCodeCatalog } from './catalog.ts'
import type { LoadedCommandCodeCatalog } from './catalog.ts'
import { Config, resolveAdapterOptions } from './config.ts'
// Type-only: carries the `webServer` Context merge for the OAuth route registration below.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createCommandCodeOAuthCoordinator } from './oauth.ts'
import type { CommandCodeOAuthCoordinator } from './oauth.ts'

const NS = 'llm-commandcode' as const

/**
 * Structural equality over JSON-compatible values. dsh-settings ≥ 0.1.2-rc.1
 * removed its exported `deepEqualJson`; the retry-policy snapshot it used to
 * feed is plain JSON, so this local equivalent keeps the scope identical.
 */
function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => deepEqualJson(entry, b[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => key in right && deepEqualJson(left[key], right[key]))
}

/**
 * Internal catalog dependencies for deterministic startup tests. This module is
 * intentionally not re-exported from the public plugin entry (`src/index.ts`).
 */
export interface ApplyDependencies {
  fetchImpl?: typeof fetch
  loadCatalog?: (options: Parameters<typeof loadCommandCodeCatalog>[0]) => Promise<LoadedCommandCodeCatalog>
  createOAuthCoordinator?: (ctx: Context) => CommandCodeOAuthCoordinator
}

/**
 * Build the provider registration entry with explicit catalog dependencies.
 * The public plugin entry (`src/index.ts`) wraps this with default dependencies
 * so the production API remains `apply(ctx, config)`.
 */
export function createApply(dependencies: ApplyDependencies = {}): (ctx: Context, config: Config) => void {
  const { fetchImpl, loadCatalog, createOAuthCoordinator = createCommandCodeOAuthCoordinator } = dependencies
  return (ctx, config) => {
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

    const coordinator = createOAuthCoordinator(ctx)
    ctx.effect(() => () => coordinator.dispose(), 'llm-commandcode.oauth-coordinator')
    // Web-only route registration: the webServer service may be absent in
    // headless compositions, so the routes mount through a delayed injection
    // instead of a hard `inject` (which would fail headless boots).
    ctx.inject(['webServer'], (sctx) => {
      sctx.effect(() => {
        const disposeStart = sctx.webServer.register({ kind: 'exact', path: '/commandcode-oauth/start', handler: coordinator.routes.onStart })
        const disposeStatus = sctx.webServer.register({ kind: 'exact', path: '/commandcode-oauth/status', handler: coordinator.routes.onStatus })
        return () => {
          disposeStart()
          disposeStatus()
        }
      }, 'llm-commandcode.oauth-routes')
    })

    const adapter = new CommandCodeAdapter({ options, resolveApiKey })
    ctx.llm.registerConfigurableProviders([
      { provider: PROVIDER, displayName: 'Command Code', settingsNs: NS, settingsPath: [] },
    ])
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
    let registeredPolicy = options().retryPolicy
    let catalogRefreshActive = true
    const catalogRefreshAbort = new AbortController()
    ctx.effect(() => () => {
      catalogRefreshActive = false
      catalogRefreshAbort.abort()
    }, 'llm-commandcode.catalog-refresh')
    const catalogRefreshUsable = (): boolean => catalogRefreshActive && !catalogRefreshAbort.signal.aborted
    const publishCatalog = (models: readonly CommandCodeCatalogModel[]): void => {
      if (!catalogRefreshUsable()) return
      catalogModels = models
      lastRaw = undefined
      registration.replace([PROVIDER])
    }
    const refreshCatalog = async (): Promise<void> => {
      const catalog = await (loadCatalog ?? loadCommandCodeCatalog)({
        cachePath: dshHomePath('commandcode', 'models.json'),
        staticModels: staticCommandCodeCatalogModels(),
        ttlMs: current().modelsCacheTtlMs ?? DEFAULT_MODELS_CACHE_TTL_MS,
        fetchImpl,
        signal: catalogRefreshAbort.signal,
      })
      if (!catalogRefreshUsable()) return
      if (catalog.initial.source === 'cache') publishCatalog(catalog.initial.models)
      if (catalog.initial.warning !== undefined && catalogRefreshUsable()) ctx.logger.debug(`llm-commandcode: ${catalog.initial.warning}`)
      const refreshed = await catalog.refresh
      if (refreshed === undefined || !catalogRefreshUsable()) return
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
    // Bridge the plugin's configuration into the settings service. dsh-settings
    // ≥ 0.1.2-rc.1 owns the section through `ctx.settings.installSection` (the
    // old free-function `installSettingsSection` was removed). Attaching via the
    // `settings` service keeps headless compositions working when no provider
    // is mounted: the section simply stays dormant and `current` keeps the entry
    // defaults until a provider attaches.
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, NS, Config, config, {
        setSource: source => { current = source },
        onChange: ensureRegistrationFacts,
      })
    })
  }
}
