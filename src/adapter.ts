import {
  attributionHeaders,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'

import { commandCodeError } from './errors.ts'
import { MODEL_EFFORTS, MODEL_INPUT_MODALITIES, reasoningEffortsForModel } from './models.ts'
import type { CommandCodeCatalogModel } from './catalog.ts'
import { commandCodeHeaders, serializeRequest } from './serialize.ts'
import { parseCommandCodeLines } from './stream.ts'
import { translate } from './translate.ts'

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
export const PROVIDER = 'commandcode'
const STREAM_IDLE_TIMEOUT_CODE = 'COMMANDCODE_STREAM_IDLE_TIMEOUT'

export type { CommandCodeCatalogModel } from './catalog.ts'

/** Immutable connection facts resolved once for each adapter operation. */
export interface CommandCodeConnectionOptions {
  baseURL: string
  apiKeyEnv: string
  workingDir: string
  maxTokens: number
  defaultContextWindow: number
  streamIdleTimeoutMs: number
  /** A non-empty settings list overrides discovered and static catalogs. */
  models?: readonly CommandCodeCatalogModel[]
  /** Cache/live catalog supplied by plugin startup; settings still win. */
  catalogModels?: readonly CommandCodeCatalogModel[]
  retryPolicy?: ResolvedRetryPolicy
}

export interface CommandCodeAdapterOptions {
  options: () => CommandCodeConnectionOptions
  /** The plugin owns credential-service/environment precedence at this seam. */
  resolveApiKey: (connection: CommandCodeConnectionOptions) => Promise<string>
}

export function staticCommandCodeCatalogModels(): readonly CommandCodeCatalogModel[] {
  return [...new Set([...Object.keys(MODEL_INPUT_MODALITIES), ...Object.keys(MODEL_EFFORTS)])]
    .map(id => ({ id }))
}

function configuredModels(connection: CommandCodeConnectionOptions): readonly CommandCodeCatalogModel[] {
  // A settings section materializes an absent `models` as `[]`; treat an
  // empty list as unset so the static capability snapshot still serves.
  if (connection.models !== undefined && connection.models.length > 0) return connection.models
  if (connection.catalogModels !== undefined && connection.catalogModels.length > 0) return connection.catalogModels
  return staticCommandCodeCatalogModels()
}

function modelInfo(provider: string, model: CommandCodeCatalogModel): LlmModelInfo {
  return { provider, id: model.id, name: model.name ?? model.id, inputModalities: ['text'] }
}

function modelResolution(
  provider: string,
  model: string,
  connection: CommandCodeConnectionOptions,
): LlmResolvedModelInfo {
  const configured = configuredModels(connection).find(entry => entry.id === model)
  const efforts = reasoningEffortsForModel(model)
  return {
    provider,
    id: model,
    name: configured?.name ?? model,
    inputModalities: ['text'],
    context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
    defaultMaxTokens: Math.min(configured?.maxTokens ?? connection.maxTokens, 64_000),
    ...(efforts.length === 0 ? {} : {
      reasoning: {
        efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
      },
    }),
  }
}

/** Direct Command Code fetch adapter. */
export class CommandCodeAdapter extends LlmAdapter {
  constructor(private readonly config: CommandCodeAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Command Code' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy | undefined {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(configuredModels(this.config.options()).map(model => modelInfo(provider, model)))
  }

  override resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(modelResolution(provider, model, this.config.options()))
  }

  async * stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey(connection)
    const consumer = new AbortController()
    const signal = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    let response: Response | undefined
    let iterator: AsyncIterator<StreamChunk> | undefined
    // The watchdog only arms around next(), so creating it before fetch makes
    // its stable signal available to abort body reads without timing fetch.
    const watchdog = idleWatchdog(signal, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    let exhausted = false
    try {
      const body = serializeRequest(options, {
        workingDir: connection.workingDir,
        maxTokens: connection.maxTokens,
        attribution: attributionHeaders(),
      })
      try {
        response = await fetch(`${connection.baseURL.replace(/\/+$/, '')}/alpha/generate`, {
          method: 'POST',
          headers: {
            ...commandCodeHeaders({
              workingDir: connection.workingDir,
              maxTokens: connection.maxTokens,
              attribution: attributionHeaders(),
            }),
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: watchdog.signal,
        })
      } catch (error: unknown) {
        if (signal.aborted) throw error
        throw new LlmError(`Command Code API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
      }

      if (!response.ok) {
        let providerError: unknown
        try {
          const responseText = await response.text()
          try {
            providerError = JSON.parse(responseText)
          } catch {
            providerError = responseText
          }
        } catch {
          providerError = undefined
        }
        throw commandCodeError(response.status, providerError)
      }
      const responseBody = response.body
      if (responseBody === null) throw new LlmError('Command Code returned no response body', 'EMPTY_RESPONSE')

      iterator = translate(parseCommandCodeLines(responseBody))[Symbol.asyncIterator]()
      while (true) {
        const item = await watchdog.next(iterator)
        if (item.done) {
          exhausted = true
          return
        }
        yield item.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`Command Code stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Command Code API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      watchdog[Symbol.dispose]()
      consumer.abort('Command Code stream consumer stopped')
      if (!exhausted && iterator?.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns cancellation.
        }
      }
      const upstreamBody = response?.body
      if (upstreamBody !== null && upstreamBody !== undefined) {
        try {
          await upstreamBody.cancel()
        } catch {
          // A body may already have completed or been cancelled by fetch.
        }
      }
    }
  }
}
