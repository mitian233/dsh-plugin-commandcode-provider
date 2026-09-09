/** Strict Command Code wire-event validation and StreamChunk translation. */

import { EMPTY_RESPONSE_CODE, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

import { commandCodeError, redactCommandCodeErrorText, unknownFinishReasonCode } from './errors.ts'
import type { WireEvent, WireUsage } from './types.ts'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  id?: string
  name?: string
}

interface ValidatedToolCall {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  argumentsJson: string
}

type ValidatedEvent = Exclude<WireEvent, { type: 'tool-call' }> | ValidatedToolCall

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function malformedEvent(): LlmError {
  return new LlmError('malformed Command Code event', 'MALFORMED_RESPONSE')
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validateUsage(value: unknown): value is WireUsage {
  if (!isRecord(value)
    || !finiteNonNegative(value.inputTokens)
    || !finiteNonNegative(value.outputTokens)) return false

  if (value.inputTokenDetails === undefined) return true
  if (!isRecord(value.inputTokenDetails)) return false
  for (const key of ['noCacheTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const detail = value.inputTokenDetails[key]
    if (detail !== undefined && !finiteNonNegative(detail)) return false
  }
  return true
}

/** Convert a selected complete tool input into one canonical JSON object string. */
function normalizeToolArguments(value: unknown): string | undefined {
  let argumentRecord: Record<string, unknown>
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (!isRecord(parsed)) return undefined
      argumentRecord = parsed
    } catch {
      return undefined
    }
  } else if (isRecord(value)) {
    argumentRecord = value
  } else {
    return undefined
  }

  try {
    const normalized = JSON.stringify(argumentRecord)
    return typeof normalized === 'string' ? normalized : undefined
  } catch {
    return undefined
  }
}

/**
 * Validate a parsed JSON value as one known wire-event discriminant.  This is
 * deliberately completed before translation state is changed or a block is
 * allocated, so malformed provider data cannot leave partial state behind.
 *
 * Unknown event types (provider extensions such as `start`, `start-step`,
 * `text-start`, `text-end`, `finish-step`, and `provider-metadata`) return
 * `undefined` as a skip signal so the caller can silently ignore them.
 */
function validateWireEvent(value: unknown): ValidatedEvent | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') throw malformedEvent()

  switch (value.type) {
    case 'text-delta':
    case 'reasoning-delta':
      if (typeof value.text !== 'string') throw malformedEvent()
      return value as ValidatedEvent
    case 'reasoning-start':
    case 'reasoning-end':
    case 'tool-result':
      return value as ValidatedEvent
    case 'tool-call': {
      if (typeof value.toolCallId !== 'string' || typeof value.toolName !== 'string') throw malformedEvent()
      const selected = hasOwn(value, 'input') ? value.input
        : hasOwn(value, 'args') ? value.args
          : hasOwn(value, 'arguments') ? value.arguments
            : undefined
      const argumentsJson = normalizeToolArguments(selected)
      if (argumentsJson === undefined) throw malformedEvent()
      return { type: 'tool-call', toolCallId: value.toolCallId, toolName: value.toolName, argumentsJson }
    }
    case 'finish':
      if (typeof value.finishReason !== 'string'
        || (value.totalUsage !== undefined && !validateUsage(value.totalUsage))) throw malformedEvent()
      return value as ValidatedEvent
    case 'error': {
      const errorPresent = hasOwn(value, 'error')
      const messagePresent = hasOwn(value, 'message')
      if (!errorPresent && !messagePresent) throw malformedEvent()
      for (const key of ['error', 'message']) {
        if (!hasOwn(value, key)) continue
        const payload = value[key]
        if (typeof payload !== 'string' && !isRecord(payload)) throw malformedEvent()
      }
      return value as ValidatedEvent
    }
    default:
      return undefined
  }
}

/** Map Command Code's usage accounting to DSH's disjoint convention. */
export function mapUsage(usage: WireUsage): TokenUsage {
  const details = usage.inputTokenDetails
  const cacheReadTokens = details?.cacheReadTokens
  const cacheWriteTokens = details?.cacheWriteTokens
  return {
    inputTokens: details?.noCacheTokens ?? Math.max(0, usage.inputTokens - (cacheReadTokens ?? 0) - (cacheWriteTokens ?? 0)),
    outputTokens: usage.outputTokens,
    ...cacheReadTokens !== undefined ? { cacheReadTokens } : {},
    ...cacheWriteTokens !== undefined ? { cacheWriteTokens } : {},
  }
}

/** Map all documented terminal reasons, preserving unknown values as errors. */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool-calls': return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
    case 'max-tokens':
    case 'max_output_tokens': return { kind: 'max-tokens' }
    default: return {
      kind: 'error',
      failure: {
        message: `model stopped: ${redactCommandCodeErrorText(reason)}`,
        code: unknownFinishReasonCode(reason),
      },
    }
  }
}

function closedBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: ToolCallId(block.id ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Translate parsed Command Code events.  The wire `finish` is the sole
 * terminal marker; it flushes blocks, usage, and finish synchronously without
 * waiting for the upstream transport to close.
 */
export async function* translate(events: AsyncIterable<unknown>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const blocks: OpenBlock[] = []

  const open = (kind: OpenBlock['kind'], id?: string, name?: string): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '', id, name }
    blocks.push(block)
    return block
  }

  for await (const candidate of events) {
    // Do not move state, allocate indexes, or emit chunks until every field is valid.
    const event = validateWireEvent(candidate)
    if (event === undefined) continue

    switch (event.type) {
      case 'text-delta':
        if (event.text.length === 0) break
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += event.text
        yield { type: 'text-delta', index: textBlock.index, text: event.text }
        break
      case 'reasoning-start':
        // A boundary never emits a chunk, but a later delta starts a fresh block.
        reasoningBlock = undefined
        break
      case 'reasoning-delta':
        if (event.text.length === 0) break
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += event.text
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: event.text }
        break
      case 'reasoning-end':
        reasoningBlock = undefined
        break
      case 'tool-result':
        break
      case 'tool-call': {
        const block = open('tool-call', event.toolCallId, event.toolName)
        block.text = event.argumentsJson
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: ToolCallId(event.toolCallId),
          name: event.toolName,
          argumentsDelta: event.argumentsJson,
        }
        break
      }
      case 'error':
        throw commandCodeError(undefined, {
          ...hasOwn(event, 'error') ? { error: event.error } : {},
          ...hasOwn(event, 'message') ? { message: event.message } : {},
        })
      case 'finish': {
        const usage = event.totalUsage === undefined ? undefined : mapUsage(event.totalUsage)
        const mappedReason = mapFinishReason(event.finishReason)
        for (const block of blocks) {
          yield { type: 'block-end', index: block.index, block: closedBlock(block) }
        }
        if (usage) yield { type: 'usage', usage }
        yield {
          type: 'finish',
          reason: mappedReason.kind !== 'error' && blocks.length === 0
            ? {
              kind: 'error',
              failure: {
                message: 'model returned a completed response with no content',
                code: EMPTY_RESPONSE_CODE,
              },
            }
            : mappedReason,
        }
        return
      }
    }
  }

  throw new LlmError('Command Code event stream ended without finish', 'STREAM_CLOSED')
}
