import assert from 'node:assert/strict'
import test from 'node:test'

import { parseCommandCodeLines } from '../src/stream.ts'

function byteStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

async function parse(chunks: readonly Uint8Array[]): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of parseCommandCodeLines(byteStream(chunks))) values.push(value)
  return values
}

test('parses fragmented UTF-8 and newline-delimited JSON in arrival order', async () => {
  const encoder = new TextEncoder()
  const bytes = encoder.encode('{"text":"😀"}\n{"count":2}\n')
  const emojiStart = bytes.indexOf(0xf0)

  assert.deepEqual(
    await parse([
      bytes.slice(0, emojiStart + 2),
      bytes.slice(emojiStart + 2, emojiStart + 4),
      bytes.slice(emojiStart + 4),
    ]),
    [{ text: '😀' }, { count: 2 }],
  )
})

test('ignores permitted framing and non-JSON plain or data lines', async () => {
  const encoder = new TextEncoder()

  assert.deepEqual(
    await parse([
      encoder.encode('\n: keepalive\nevent: message\n[DONE]\nnot json\ndata: non-json\ndata: {"type":"text-delta","text":"ok"}\n'),
    ]),
    [{ type: 'text-delta', text: 'ok' }],
  )
})

test('flushes a final unterminated JSON line without inventing a finish event', async () => {
  const encoder = new TextEncoder()

  assert.deepEqual(
    await parse([encoder.encode('{"type":"text-delta","text":"tail"}')]),
    [{ type: 'text-delta', text: 'tail' }],
  )
})
