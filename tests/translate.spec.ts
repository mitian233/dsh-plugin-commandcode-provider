import assert from 'node:assert/strict'
import test from 'node:test'

import { EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'

import { collect } from './assemble.ts'
import { mapFinishReason, mapUsage, translate } from '../src/translate.ts'

async function* events(...values: unknown[]): AsyncGenerator<unknown> {
  yield* values
}

async function assertLlmError(stream: AsyncIterable<unknown>, code: string): Promise<LlmError> {
  try {
    await collect(stream as AsyncIterable<never>)
  } catch (error) {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, code)
    return error
  }
  assert.fail(`expected ${code}`)
}

test('translates every non-terminal event, assigning lazy monotonic blocks', async () => {
  const chunks = await collect(translate(events(
    { type: 'reasoning-start' },
    { type: 'reasoning-delta', text: '' },
    { type: 'tool-result' },
    { type: 'reasoning-delta', text: 'consider' },
    { type: 'reasoning-end' },
    { type: 'text-delta', text: '' },
    { type: 'text-delta', text: 'answer' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: { city: 'Paris' } },
    { type: 'finish', finishReason: 'tool-calls' },
  )))

  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'consider' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'block-start', index: 2, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'lookup', argumentsDelta: '{"city":"Paris"}' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'consider' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"city":"Paris"}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
})

test('normalizes tool arguments once, selecting input before args before arguments', async () => {
  const chunks = await collect(translate(events(
    { type: 'tool-call', toolCallId: 'input', toolName: 'one', input: '{"a":1}', args: { ignored: true }, arguments: { ignored: true } },
    { type: 'tool-call', toolCallId: 'args', toolName: 'two', args: { b: 2 }, arguments: { ignored: true } },
    { type: 'tool-call', toolCallId: 'arguments', toolName: 'three', arguments: '{"c":3}' },
    { type: 'finish', finishReason: 'stop' },
  )))

  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.argumentsDelta),
    ['{"a":1}', '{"b":2}', '{"c":3}'],
  )
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})

test('defers block ends, usage, and exactly one finish without consuming events after finish', async () => {
  let advancedAfterFinish = false
  async function* openUpstream(): AsyncGenerator<unknown> {
    yield { type: 'text-delta', text: 'ok' }
    yield {
      type: 'finish',
      finishReason: 'stop',
      totalUsage: {
        inputTokens: 10,
        outputTokens: 3,
        inputTokenDetails: { cacheReadTokens: 4, cacheWriteTokens: 2 },
      },
    }
    advancedAfterFinish = true
    yield { type: 'text-delta', text: 'ignored' }
  }

  const chunks = await collect(translate(openUpstream()))
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'ok' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } },
    { type: 'usage', usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(advancedAfterFinish, false)
})

test('uses noCacheTokens when supplied and maps all known finish reasons', () => {
  assert.deepEqual(mapUsage({
    inputTokens: 100,
    outputTokens: 5,
    inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 80, cacheWriteTokens: 13 },
  }), { inputTokens: 7, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 13 })

  assert.deepEqual(mapFinishReason('stop'), { kind: 'stop' })
  assert.deepEqual(mapFinishReason('tool-calls'), { kind: 'tool-calls' })
  for (const reason of ['length', 'max_tokens', 'max-tokens', 'max_output_tokens']) {
    assert.deepEqual(mapFinishReason(reason), { kind: 'max-tokens' })
  }
})

test('uses an EMPTY_RESPONSE error finish for successful completion without blocks', async () => {
  const chunks = await collect(translate(events({
    type: 'finish',
    finishReason: 'stop',
    totalUsage: { inputTokens: 1, outputTokens: 0 },
  })))
  assert.deepEqual(chunks, [
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 0 } },
    {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
      },
    },
  ])
})

test('maps unknown finish reasons deterministically and redacts their messages', () => {
  assert.deepEqual(mapFinishReason('content filter!'), {
    kind: 'error',
    failure: { message: 'model stopped: content filter!', code: 'CONTENT_FILTER' },
  })
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
  const result = mapFinishReason(`Bearer ${secret}`)
  assert.equal(result.kind, 'error')
  if (result.kind === 'error') {
    assert.equal(result.failure.code, 'BEARER_SK_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456')
    assert.equal(result.failure.message.includes(secret), false)
  }
  assert.deepEqual(mapFinishReason('---'), {
    kind: 'error',
    failure: { message: 'model stopped: ---', code: 'UNKNOWN_FINISH_REASON' },
  })
})

test('rejects all invalid event schema before allocating a block', async (t) => {
  const invalid = [
    null,
    [],
    1,
    'event',
    {},
    { type: 'unknown' },
    { type: 'text-delta' },
    { type: 'text-delta', text: 1 },
    { type: 'reasoning-delta' },
    { type: 'reasoning-delta', text: null },
    { type: 'tool-call', toolCallId: 1, toolName: 'x', input: {} },
    { type: 'tool-call', toolCallId: 'x', toolName: 1, input: {} },
    { type: 'tool-call', toolCallId: 'x', toolName: 'x' },
    { type: 'tool-call', toolCallId: 'x', toolName: 'x', input: [] },
    { type: 'tool-call', toolCallId: 'x', toolName: 'x', input: '{"a":' },
    { type: 'tool-call', toolCallId: 'x', toolName: 'x', input: '[]' },
    { type: 'finish' },
    { type: 'finish', finishReason: 1 },
    { type: 'finish', finishReason: 'stop', totalUsage: [] },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: -1, outputTokens: 0 } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: Number.NaN } },
    { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 0, inputTokenDetails: { cacheReadTokens: -1 } } },
    { type: 'error' },
    { type: 'error', error: 1 },
    { type: 'error', message: [] },
  ]

  for (const value of invalid) {
    await t.test(JSON.stringify(value), async () => {
      const error = await assertLlmError(translate(events(value)), 'MALFORMED_RESPONSE')
      assert.match(error.message, /malformed Command Code event/i)
    })
  }
})

test('classifies and redacts in-stream provider errors rather than converting them to STREAM_CLOSED', async () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
  const error = await assertLlmError(translate(events({
    type: 'error',
    error: { status: 429, message: `rate limit: Bearer ${secret}` },
  })), 'RATE_LIMIT')
  assert.equal(error.message.includes(secret), false)
})

test('throws STREAM_CLOSED when the parsed event source ends without finish', async () => {
  await assertLlmError(translate(events({ type: 'text-delta', text: 'partial' })), 'STREAM_CLOSED')
})
