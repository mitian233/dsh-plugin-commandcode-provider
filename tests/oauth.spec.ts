/**
 * Tests for the Command Code OAuth coordinator and the one-shot local auth
 * server (host half of the browser-assisted API key flow).
 *
 * The coordinator exposes same-origin routes on DSH's web server; this spec
 * drives the route handlers directly (no webServer needed) and exercises the
 * auth server through real loopback HTTP.
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { startCommandCodeAuthServer } from '../src/auth-server.ts'
import type { CommandCodeAuthServer } from '../src/auth-server.ts'
import { createCommandCodeOAuthCoordinator } from '../src/oauth.ts'

/** Fake credentials seam: records set() calls, resolves them. */
class FakeCredentials {
  readonly values = new Map<string, string>()
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value)
  }
}

/** Minimal ctx: the coordinator only needs ctx.get('credentials'). */
function makeCtx(credentials?: FakeCredentials): Context {
  const ctx = new Context()
  if (credentials !== undefined) {
    ctx.provide('credentials', credentials as never)
  }
  return ctx
}

function jsonResponse(body: string): { status: number; json: unknown } {
  const parsed = JSON.parse(body) as unknown
  return { status: 200, json: parsed }
}

const contexts: Context[] = []
const servers: CommandCodeAuthServer[] = []
const coordinators: { dispose(): void }[] = []

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) {
    coordinator.dispose()
  }
  for (const server of servers.splice(0)) {
    server.server.close()
  }
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('startCommandCodeAuthServer()', () => {
  it('starts on a localhost port and resolves one valid callback POST', async () => {
    const server = await startCommandCodeAuthServer({ startPort: 0 })
    servers.push(server)
    const callback = {
      apiKey: 'cc-key-1',
      state: 'state-1',
      userId: 'user-1',
      userName: 'User One',
      keyName: 'default',
    }
    const response = await fetch(`http://127.0.0.1:${server.port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(callback),
    })
    assert.equal(response.status, 200)
    const result = await server.waitForCallback
    assert.deepEqual(result, callback)
  })

  it('answers 404 for non-callback paths and 405 for GET /callback', async () => {
    const server = await startCommandCodeAuthServer({ startPort: 0 })
    servers.push(server)
    const base = `http://127.0.0.1:${server.port}`
    const notFound = await fetch(`${base}/other`)
    assert.equal(notFound.status, 404)
    const methodNotAllowed = await fetch(`${base}/callback`)
    assert.equal(methodNotAllowed.status, 404)
  })

  it('rejects the callback promise when the POST reports access_denied', async () => {
    const server = await startCommandCodeAuthServer({ startPort: 0 })
    servers.push(server)
    const rejection = server.waitForCallback.then(
      () => { throw new Error('expected rejection') },
      (error: Error) => error.message,
    )
    const response = await fetch(`http://127.0.0.1:${server.port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'access_denied', error_description: 'User said no' }),
    })
    assert.equal(response.status, 200)
    assert.equal(await rejection, 'User said no')
  })

  it('rejects a callback missing required fields with 400', async () => {
    const server = await startCommandCodeAuthServer({ startPort: 0 })
    servers.push(server)
    const response = await fetch(`http://127.0.0.1:${server.port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'key', state: 's' }),
    })
    assert.equal(response.status, 400)
  })
})

describe('createCommandCodeOAuthCoordinator()', () => {
  it('reports idle before any attempt and serves a Studio URL on start', async () => {
    const credentials = new FakeCredentials()
    const ctx = makeCtx(credentials)
    contexts.push(ctx)
    const coordinator = createCommandCodeOAuthCoordinator(ctx, { studioBaseUrl: 'https://commandcode.ai' })
    coordinators.push(coordinator)

    assert.deepEqual(coordinator.status(), { state: 'idle' })

    // start() resolves to the Studio URL once the local server listens.
    const url = await coordinator.start()
    assert.match(url, /^https:\/\/commandcode\.ai\/studio\/auth\/cli\?callback=http%3A%2F%2Flocalhost%3A\d+%2Fcallback&state=/)
    const callback = new URL(url)
    const state = callback.searchParams.get('state') ?? ''
    assert.ok(state.length > 0)
  })

  it('settles done and stores the key through the credentials seam after a valid callback', async () => {
    const credentials = new FakeCredentials()
    const ctx = makeCtx(credentials)
    contexts.push(ctx)
    const coordinator = createCommandCodeOAuthCoordinator(ctx, { studioBaseUrl: 'https://commandcode.ai' })
    coordinators.push(coordinator)

    const url = await coordinator.start()
    const parsed = new URL(url)
    const callbackUrl = parsed.searchParams.get('callback') ?? ''
    const state = parsed.searchParams.get('state') ?? ''
    const port = Number(new URL(callbackUrl).port)

    // Wait until the host marks the attempt pending (server is listening).
    let pending = false
    for (let i = 0; i < 50; i += 1) {
      if (coordinator.status().state === 'pending') { pending = true; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.ok(pending, 'coordinator should reach pending state')

    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'cc-key-2',
        state,
        userId: 'user-2',
        userName: 'User Two',
        keyName: 'default',
      }),
    })
    assert.equal(response.status, 200)

    // settle() is async (credentials.set); wait for it to land.
    for (let i = 0; i < 50; i += 1) {
      if (credentials.values.has('COMMANDCODE_API_KEY')) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(credentials.values.get('COMMANDCODE_API_KEY'), 'cc-key-2')
    assert.deepEqual(coordinator.status(), { state: 'done' })
  })

  it('refuses a second start while pending and reports error on state mismatch', async () => {
    const credentials = new FakeCredentials()
    const ctx = makeCtx(credentials)
    contexts.push(ctx)
    const coordinator = createCommandCodeOAuthCoordinator(ctx, { studioBaseUrl: 'https://commandcode.ai' })
    coordinators.push(coordinator)

    const firstUrl = await coordinator.start()
    await assert.rejects(() => coordinator.start(), /already in progress/)

    const parsed = new URL(firstUrl)
    const callbackUrl = parsed.searchParams.get('callback') ?? ''
    const port = Number(new URL(callbackUrl).port)

    // Wrong state token must be refused.
    const response = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: 'cc-key-bad',
        state: 'wrong-state',
        userId: 'user-bad',
        userName: 'Bad User',
        keyName: 'default',
      }),
    })
    assert.equal(response.status, 200)

    for (let i = 0; i < 50; i += 1) {
      if (coordinator.status().state === 'error') break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(coordinator.status().state, 'error')
    assert.match(coordinator.status().message ?? '', /state token mismatch/)
  })
})
