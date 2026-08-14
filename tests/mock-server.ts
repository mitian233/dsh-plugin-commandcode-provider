import { createServer } from 'node:http'
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export interface CapturedRequest {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: string
}

export interface MockServerOptions {
  /** HTTP status returned to the client. Defaults to 200. */
  status?: number
  headers?: Record<string, string>
  /** Exact response bytes, allowing tests to split UTF-8 code points or lines. */
  chunks?: readonly Uint8Array[]
  /** Delay before reading the request body, for request-abort tests. */
  delayBeforeReadMs?: number
  /** Keep the response open after writing the final chunk. */
  hangAfterLast?: boolean
}

export interface MockServer {
  url: string
  capturedRequest: Promise<CapturedRequest>
  cancelled: Promise<void>
  readonly wasCancelled: boolean
  close(): Promise<void>
}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

/**
 * Start a one-request local HTTP server for transport tests. It records the
 * complete request, emits caller-controlled byte fragments, and exposes a
 * cancellation signal for clients which abandon an open response body.
 */
export async function createMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const requestResult = deferred<CapturedRequest>()
  const cancellation = deferred<void>()
  const sockets = new Set<Socket>()
  let wasCancelled = false

  const observeCancellation = (): void => {
    if (wasCancelled) return
    wasCancelled = true
    cancellation.resolve(undefined)
  }

  const server: Server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    request.once('aborted', observeCancellation)
    response.once('close', () => {
      if (!response.writableEnded) observeCancellation()
    })

    if (options.delayBeforeReadMs !== undefined) await delay(options.delayBeforeReadMs)

    const body: Buffer[] = []
    request.on('data', chunk => body.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    request.once('error', observeCancellation)
    request.once('end', () => {
      requestResult.resolve({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(body).toString('utf8'),
      })

      response.writeHead(options.status ?? 200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        ...options.headers,
      })
      for (const chunk of options.chunks ?? []) response.write(chunk)
      if (!options.hangAfterLast) response.end()
    })
  })

  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind to a TCP port')

  return {
    url: `http://127.0.0.1:${address.port}`,
    capturedRequest: requestResult.promise,
    cancelled: cancellation.promise,
    get wasCancelled() { return wasCancelled },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
