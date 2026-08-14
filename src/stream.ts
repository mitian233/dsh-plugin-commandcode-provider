/**
 * Incrementally parses Command Code's newline-delimited JSON response body.
 * Transport framing is intentionally permissive here; event validation belongs
 * to the translator so this layer can remain lossless for valid JSON values.
 */
export async function* parseCommandCodeLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  const parseLine = (line: string): unknown | undefined => {
    let payload = line.trim()
    if (
      payload.length === 0 ||
      payload.startsWith(':') ||
      payload.startsWith('event:')
    ) return undefined

    if (payload.startsWith('data:')) payload = payload.slice('data:'.length).trim()
    if (payload.length === 0 || payload === '[DONE]') return undefined

    try {
      return JSON.parse(payload) as unknown
    } catch {
      return undefined
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      pending += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const parsed = parseLine(pending.slice(0, newline))
        pending = pending.slice(newline + 1)
        if (parsed !== undefined) yield parsed
      }
    }

    pending += decoder.decode()
    const parsed = parseLine(pending)
    if (parsed !== undefined) yield parsed
  } finally {
    reader.releaseLock()
  }
}
