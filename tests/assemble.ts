import assert from 'node:assert/strict'

import type { StreamChunk } from '@deepseek-ai/dsh-llm'

/** Collect a stream unchanged for exact protocol assertions. */
export async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Assert the chunk discriminants while leaving detailed chunk assertions local to each test. */
export function assertChunkTypes(
  chunks: readonly StreamChunk[],
  types: readonly StreamChunk['type'][],
): void {
  assert.deepEqual(chunks.map(chunk => chunk.type), types)
}
