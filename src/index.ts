import { createApply } from './apply.ts'

export { CommandCodeAdapter, DEFAULT_STREAM_IDLE_TIMEOUT_MS, PROVIDER } from './adapter.ts'
export type { CommandCodeAdapterOptions, CommandCodeCatalogModel, CommandCodeConnectionOptions } from './adapter.ts'
export type { RequestDefaults } from './types.ts'
export type * from './types.ts'

export { Config, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, PUBLIC_BASE_URL, resolveAdapterOptions } from './config.ts'

export const name = 'llm-commandcode'
export const inject = ['llm'] as const

/** Register the configurable provider, request-time credentials seam, and reversible adapter route. */
export const apply = createApply()
