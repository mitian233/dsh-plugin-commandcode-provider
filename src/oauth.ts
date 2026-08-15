/**
 * Command Code OAuth coordinator (host half).
 *
 * Exposes three same-origin routes on DSH's web server that the browser half
 * calls through `fetch` — the same-origin HTTP seam is the client→host channel
 * (no cordis RPC bridge is needed):
 *
 *   GET  /commandcode-oauth/start    -> { url }  (Studio OAuth URL with a local
 *                                                callback + state token)
 *   GET  /commandcode-oauth/status   -> { state: 'idle'|'pending'|'done'|'error',
 *                                                message? }
 *   POST /commandcode-oauth/callback -> 200 (Studio POSTs the API key here)
 *
 * On a valid callback the coordinator stores the key through the credentials
 * service — the exact seam the provider route reads on every request — then
 * closes the one-shot local auth server.
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { startCommandCodeAuthServer } from './auth-server.ts'
import type { CommandCodeAuthServer } from './auth-server.ts'

export const COMMANDCODE_API_KEY_REF = 'COMMANDCODE_API_KEY'

const STUDIO_BASE_URL = 'https://commandcode.ai'
const OAUTH_PATH = '/commandcode-oauth'
const AUTH_TIMEOUT_MS = 5 * 60 * 1000

type OAuthState = 'idle' | 'pending' | 'done' | 'error'

/** Status payload returned by the /status route. */
export type CommandCodeOAuthStatus =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'done' }
  | { state: 'error'; message?: string }

interface OAuthSession {
  state: 'idle' | 'pending' | 'done' | 'error'
  message?: string
  server?: CommandCodeAuthServer
  stateToken?: string
  timer?: NodeJS.Timeout
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function generateStateToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The Command Code Studio OAuth URL for one attempt: the CLI auth page with a
 * localhost callback and a CSRF state token, exactly as the reference
 * implementation builds it.
 */
function buildOAuthUrl(callbackUrl: string, stateToken: string): string {
  return `${STUDIO_BASE_URL}/studio/auth/cli?callback=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(stateToken)}`
}

/** Read a JSON POST body with a size guard (mirrors the auth server). */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      if (body.length > 10_000) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>
        if (parsed === null || typeof parsed !== 'object') {
          reject(new Error('body is not an object'))
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

/** One OAuth session shared by the three routes (a fresh one per attempt). */
export interface CommandCodeOAuthCoordinatorOptions {
  /** Credential reference to store the retrieved key under. */
  ref?: CredentialRef
  /** Override the Studio origin (tests). */
  studioBaseUrl?: string
}

export interface CommandCodeOAuthCoordinator {
  /** The shared session (for tests). */
  session: OAuthSession
  /** Start an attempt; resolves to the Studio URL once the local server listens. */
  start(): Promise<string>
  /** Current status. */
  status(): CommandCodeOAuthStatus
  /** Cancel a pending attempt: clear the timeout and close the local server. */
  dispose(): void
  /** Same-origin route handlers to register on the web server. */
  routes: {
    onStart(req: IncomingMessage, res: ServerResponse): void
    onStatus(req: IncomingMessage, res: ServerResponse): void
  }
}

/**
 * Build the coordinator bound to one plugin context.
 * @param ctx - cordis context with the `credentials` service and `webServer`.
 * @param options - reference and origin overrides.
 * @returns the coordinator with routes.
 */
export function createCommandCodeOAuthCoordinator(
  ctx: Context,
  options: CommandCodeOAuthCoordinatorOptions = {},
): CommandCodeOAuthCoordinator {
  const session: OAuthSession = { state: 'idle' }
  const ref = options.ref ?? (COMMANDCODE_API_KEY_REF as CredentialRef)
  const studioBaseUrl = options.studioBaseUrl ?? STUDIO_BASE_URL

  const credentials = (): { set(ref: CredentialRef, value: string): Promise<void> } | undefined =>
    ctx.get('credentials')

  const fail = (message: string): void => {
    session.state = 'error'
    session.message = message
    if (session.timer !== undefined) clearTimeout(session.timer)
    session.timer = undefined
  }

  const settle = (key: string): void => {
    session.state = 'done'
    session.message = undefined
    if (session.timer !== undefined) clearTimeout(session.timer)
    session.timer = undefined
    void (async () => {
      const seam = credentials()
      if (seam === undefined) {
        fail('credentials service is not mounted')
        return
      }
      try {
        await seam.set(ref, key)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    })()
  }

  const start = async (): Promise<string> => {
    // A previous attempt still pending: refuse rather than leak a second server.
    if (session.state === 'pending') {
      throw new Error('an OAuth attempt is already in progress')
    }
    const server: CommandCodeAuthServer = await startCommandCodeAuthServer()
    session.server = server
    session.stateToken = generateStateToken()
    session.state = 'pending'
    const callbackUrl = `http://localhost:${server.port}/callback`
    const url = buildOAuthUrl(callbackUrl, session.stateToken)
    session.message = url
    // The Studio POST lands here; a timeout returns the session to idle.
    session.timer = setTimeout(() => {
      if (session.state === 'pending') {
        fail('browser authentication timed out')
        if (session.server !== undefined) session.server.server.close()
      }
    }, AUTH_TIMEOUT_MS)
    void (async () => {
      try {
        const callback = await server.waitForCallback
        if (callback.state !== session.stateToken) {
          fail('state token mismatch — authentication may have been tampered with')
          return
        }
        settle(callback.apiKey)
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error))
      }
    })()
    return url
  }

  const status = (): CommandCodeOAuthStatus => {
    const state: OAuthState = session.state
    if (state === 'pending') return { state: 'pending' }
    if (state === 'error') return { state: 'error', message: session.message }
    if (state === 'done') return { state: 'done' }
    return { state: 'idle' }
  }

  /** GET /commandcode-oauth/start */
  const onStart = (_req: IncomingMessage, res: ServerResponse): void => {
    void start().then(
      (url) => sendJson(res, 200, { url }),
      (error: unknown) => sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) }),
    )
  }

  /** GET /commandcode-oauth/status */
  const onStatus = (_req: IncomingMessage, res: ServerResponse): void => {
    sendJson(res, 200, status())
  }

  const dispose = (): void => {
    if (session.timer !== undefined) clearTimeout(session.timer)
    session.timer = undefined
    if (session.server !== undefined) session.server.server.close()
    session.server = undefined
  }

  return { session, start, status, dispose, routes: { onStart, onStatus } }
}
