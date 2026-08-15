/**
 * Local HTTP callback server for the Command Code browser auth flow.
 *
 * Mirrors the reference implementation in `pi-commandcode-provider`: starts a
 * one-shot server on a CLI-compatible localhost port (5959, with a small
 * fallback range), and Command Code Studio POSTs the user's API key back to
 * `/callback` after they authenticate.
 *
 * The server accepts exactly one valid POST and then closes; every other
 * request answers 404/400 so a stale tab cannot hijack a later attempt.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

const DEFAULT_PORT = 5959
const DEFAULT_PORT_RANGE = 10

export interface CommandCodeAuthCallback {
  apiKey: string
  state: string
  userId: string
  userName: string
  keyName: string
}

export interface CommandCodeAuthServer {
  server: Server
  port: number
  waitForCallback: Promise<CommandCodeAuthCallback>
}

/** CORS origins allowed to POST the callback (Command Code Studio + dev). */
const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'https://staging.commandcode.ai',
  'https://commandcode.ai',
]

function listenOnAvailablePort(server: Server, startPort = DEFAULT_PORT, range = DEFAULT_PORT_RANGE): Promise<number> {
  return new Promise((resolve, reject) => {
    let offset = 0
    const tryListen = (): void => {
      const useFallbackPort = startPort === 0 || offset >= range
      const port = useFallbackPort ? 0 : startPort + offset
      const onError = (error: NodeJS.ErrnoException): void => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE' && !useFallbackPort) {
          offset += 1
          tryListen()
          return
        }
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address() as AddressInfo
        resolve(address.port)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    }
    tryListen()
  })
}

function closeServer(server: Server): void {
  server.close((error: NodeJS.ErrnoException | undefined) => {
    // A one-shot server that already closed is not an error worth surfacing.
    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
      // Nothing to report during auth cleanup.
    }
  })
}

/** Parse a JSON POST body with a size guard. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      if (body.length > 10_000) {
        req.destroy()
        reject(new Error('callback body too large'))
        return
      }
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        if (parsed === null || typeof parsed !== 'object') {
          reject(new Error('callback body is not an object'))
          return
        }
        resolve(parsed)
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Start the one-shot local auth server.
 * @returns the server, its port, and a promise for the single valid callback.
 */
export async function startCommandCodeAuthServer(options: { startPort?: number; portRange?: number } = {}): Promise<CommandCodeAuthServer> {
  let resolveCallback!: (value: CommandCodeAuthCallback) => void
  let rejectCallback!: (error: Error) => void
  const waitForCallback = new Promise<CommandCodeAuthCallback>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin ?? ''
    const responseOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
    res.setHeader('Access-Control-Allow-Origin', responseOrigin)
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      typeof req.headers['access-control-request-headers'] === 'string'
        && req.headers['access-control-request-headers'].length > 0
        ? req.headers['access-control-request-headers']
        : 'Content-Type',
    )
    // Chrome's Private Network Access preflight may require this for an HTTPS
    // page posting to a localhost HTTP callback.
    res.setHeader('Access-Control-Allow-Private-Network', 'true')
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url !== '/callback' || req.method !== 'POST') {
      res.writeHead(404)
      res.end(JSON.stringify({ success: false, error: 'not found' }))
      return
    }

    void readJsonBody(req).then(
      (parsed) => {
        if (parsed.error !== undefined) {
          res.writeHead(200)
          res.end(JSON.stringify({ success: true }))
          const description = typeof parsed.error_description === 'string'
            ? parsed.error_description
            : String(parsed.error)
          if (parsed.error === 'access_denied') {
            rejectCallback(new Error(description || 'Authorization was denied by the user'))
          } else {
            rejectCallback(new Error(description || String(parsed.error)))
          }
          closeServer(server)
          return
        }
        const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : ''
        const state = typeof parsed.state === 'string' ? parsed.state : ''
        const userId = typeof parsed.userId === 'string' ? parsed.userId : ''
        const userName = typeof parsed.userName === 'string' ? parsed.userName : ''
        const keyName = typeof parsed.keyName === 'string' ? parsed.keyName : ''
        if (apiKey.length === 0 || state.length === 0 || userId.length === 0
          || userName.length === 0 || keyName.length === 0) {
          res.writeHead(400)
          res.end(JSON.stringify({ success: false, error: 'Missing required fields' }))
          return
        }
        res.writeHead(200)
        res.end(JSON.stringify({ success: true }))
        resolveCallback({ apiKey, state, userId, userName, keyName })
        closeServer(server)
      },
      () => {
        res.writeHead(400)
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }))
      },
    )
  })

  try {
    const port = await listenOnAvailablePort(
      server,
      options.startPort ?? DEFAULT_PORT,
      options.portRange ?? DEFAULT_PORT_RANGE,
    )
    return { server, port, waitForCallback }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    rejectCallback(new Error(`Failed to start auth server: ${message}`))
    throw error
  }
}
