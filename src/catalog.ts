import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const COMMANDCODE_MODELS_URL = 'https://api.commandcode.ai/provider/v1/models'
export const MODEL_CATALOG_CACHE_VERSION = 1
export const DEFAULT_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1_000

export interface CommandCodeCatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export type CommandCodeCatalogSource = 'live' | 'cache' | 'static'

export interface CommandCodeCatalogResult {
  models: readonly CommandCodeCatalogModel[]
  source: CommandCodeCatalogSource
  fetchedAt?: number
  warning?: string
}

export interface CachedCommandCodeCatalog {
  version: 1
  models: readonly CommandCodeCatalogModel[]
  fetchedAt: number
}

export interface FetchCommandCodeCatalogOptions {
  fetchImpl?: typeof fetch
  url?: string
  signal?: AbortSignal
}

export interface LoadCommandCodeCatalogOptions extends FetchCommandCodeCatalogOptions {
  cachePath: string
  staticModels: readonly CommandCodeCatalogModel[]
  ttlMs?: number
  now?: number
  readCache?: (cachePath: string) => Promise<CachedCommandCodeCatalog>
  writeCache?: (cachePath: string, models: readonly CommandCodeCatalogModel[], fetchedAt: number) => Promise<void>
}

export interface LoadedCommandCodeCatalog {
  /** Available immediately after cache I/O: cache when valid, otherwise static. */
  initial: CommandCodeCatalogResult
  /** Undefined only for a fresh cache; otherwise resolves to the refresh outcome. */
  refresh?: Promise<CommandCodeCatalogResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseModel(value: unknown, apiModel: boolean): CommandCodeCatalogModel {
  if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('Expected a model with a non-empty id')
  }
  const name = value.name
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) throw new Error('Expected model name to be a non-empty string')
  const contextValue = apiModel ? value.context_length : value.contextWindow
  if (!finitePositive(contextValue)) throw new Error(`Expected model ${apiModel ? 'context_length' : 'contextWindow'} to be a positive number`)
  const maxTokens = apiModel ? Math.min(contextValue, 64_000) : value.maxTokens
  if (maxTokens !== undefined && !finitePositive(maxTokens)) throw new Error('Expected model maxTokens to be a positive number')
  return { id: value.id, ...(name === undefined ? {} : { name }), contextWindow: contextValue, ...(maxTokens === undefined ? {} : { maxTokens }) }
}

/** Parse the public provider endpoint response without performing I/O. */
export function commandCodeModelsFromApiResponse(value: unknown): readonly CommandCodeCatalogModel[] {
  if (!isRecord(value) || value.object !== 'list' || !Array.isArray(value.data)) {
    throw new Error("Expected a { object: 'list', data: [] } Command Code model response")
  }
  const models = value.data.map(entry => parseModel(entry, true))
  if (models.length === 0) throw new Error('Command Code returned an empty model catalog')
  return models
}

/** Parse and validate the on-disk cache without performing I/O. */
export function commandCodeModelsFromCache(value: unknown): CachedCommandCodeCatalog {
  if (!isRecord(value) || value.version !== MODEL_CATALOG_CACHE_VERSION || !Array.isArray(value.models) || !finitePositive(value.fetchedAt)) {
    throw new Error(`Expected Command Code model cache version ${MODEL_CATALOG_CACHE_VERSION}`)
  }
  const models = value.models.map(entry => parseModel(entry, false))
  if (models.length === 0) throw new Error('Command Code model cache is empty')
  return { version: MODEL_CATALOG_CACHE_VERSION, models, fetchedAt: value.fetchedAt }
}

export function cacheIsFresh(fetchedAt: number, ttlMs = DEFAULT_MODELS_CACHE_TTL_MS, now = Date.now()): boolean {
  return Number.isFinite(fetchedAt) && Number.isFinite(ttlMs) && ttlMs >= 0 && now - fetchedAt <= ttlMs
}

export async function fetchCommandCodeCatalog(options: FetchCommandCodeCatalogOptions = {}): Promise<readonly CommandCodeCatalogModel[]> {
  const response = await (options.fetchImpl ?? fetch)(options.url ?? COMMANDCODE_MODELS_URL, {
    headers: { accept: 'application/json' }, signal: options.signal,
  })
  if (!response.ok) throw new Error(`Command Code model catalog request failed: ${response.status} ${response.statusText}`)
  return commandCodeModelsFromApiResponse(await response.json())
}

export async function readCommandCodeCatalogCache(cachePath: string): Promise<CachedCommandCodeCatalog> {
  return commandCodeModelsFromCache(JSON.parse(await readFile(cachePath, 'utf8')) as unknown)
}

/** Write a private cache atomically; callers deliberately retain live models if this fails. */
export async function writeCommandCodeCatalogCache(
  cachePath: string,
  models: readonly CommandCodeCatalogModel[],
  fetchedAt = Date.now(),
): Promise<void> {
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporaryPath, `${JSON.stringify({ version: MODEL_CATALOG_CACHE_VERSION, models, fetchedAt })}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, cachePath)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load the disk-first catalog and, only when it is absent or stale, prepare a
 * non-blocking public refresh. All I/O seams are injectable for deterministic
 * tests; callers publish `initial` before awaiting `refresh`.
 */
export async function loadCommandCodeCatalog(options: LoadCommandCodeCatalogOptions): Promise<LoadedCommandCodeCatalog> {
  const readCache = options.readCache ?? readCommandCodeCatalogCache
  const writeCache = options.writeCache ?? writeCommandCodeCatalogCache
  const ttlMs = options.ttlMs ?? DEFAULT_MODELS_CACHE_TTL_MS
  const now = options.now ?? Date.now()
  let cached: CachedCommandCodeCatalog | undefined
  let cacheWarning: string | undefined
  try {
    cached = await readCache(options.cachePath)
    if (cacheIsFresh(cached.fetchedAt, ttlMs, now)) {
      return { initial: { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt } }
    }
  } catch (error) {
    cacheWarning = `No valid Command Code model cache at ${options.cachePath}: ${errorMessage(error)}`
  }

  const fallback: CommandCodeCatalogResult = cached === undefined
    ? { models: options.staticModels, source: 'static', ...(cacheWarning === undefined ? {} : { warning: cacheWarning }) }
    : { models: cached.models, source: 'cache', fetchedAt: cached.fetchedAt }
  const refresh = (async (): Promise<CommandCodeCatalogResult> => {
    try {
      const models = await fetchCommandCodeCatalog(options)
      try {
        await writeCache(options.cachePath, models, now)
        return { models, source: 'live', fetchedAt: now }
      } catch (error) {
        return { models, source: 'live', fetchedAt: now, warning: `Loaded live Command Code models but could not update ${options.cachePath}: ${errorMessage(error)}` }
      }
    } catch (error) {
      return {
        ...fallback,
        warning: `Could not refresh Command Code models: ${errorMessage(error)}${fallback.warning === undefined ? '' : `; ${fallback.warning}`}`,
      }
    }
  })()
  return { initial: fallback, refresh }
}
