/**
 * Command Code settings section — browser half of the plugin.
 *
 * Registers a `settings.section` entry (nav row "Command Code", placed right
 * after the Models page) that manages the `COMMANDCODE_API_KEY` credential.
 * The host half keeps reading the credential through the credentials seam, so
 * no host code changes for the value path; this half only describes, stores,
 * and clears that one reference, plus offers a jump to Command Code Studio's
 * OAuth page.
 *
 * The bundle is the dual-half client artifact (`dist/client.js`) declared via
 * `package.json` `dsh.client` and `exports["./client"]`, served by DSH's web
 * client-modules machinery at `/plugins/dsh-plugin-commandcode-provider/client.js`.
 * All `@deepseek-ai/*` imports below are type-only: collaboration happens
 * through cordis services (`slots`, `locale`, `remote`).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials'
// Type-only: activates the `ctx.remote` (ClientRemote) augmentation merged
// into Context by dsh-api-remotes' client entry.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge ('settings.section').
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: activates the `ctx.slots` (SlotRegistry) augmentation merged
// into Context by dsh-client-ui-renderer' client entry.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CommandCodeSection, type CommandCodeSectionInjected } from './CommandCodeSection.tsx'
import { en, zh } from './locales.ts'

/**
 * The credentials RPC surface this plugin consumes off `ctx.remote`. The
 * `credentials` namespace is assembled by the Host (each provider mounts its
 * remote face into `ctx.remote`), so its types are not exported by any
 * @deepseek-ai package a third-party plugin can import — define the narrow
 * contract here, exactly as the Host's own settings-models client does.
 */
export interface ClientRemoteCredentials {
  describe(refs: readonly string[]): Promise<{
    ok: boolean
    value?: Record<string, CredentialInfo>
    error?: { message: string }
  }>
  set(ref: string, value: string): Promise<{ ok: boolean; error?: { message: string } }>
  unset(ref: string): Promise<{ ok: boolean; error?: { message: string } }>
}

/** `ctx.remote` narrowed to the namespaces this plugin registers against. */
export interface CommandCodeClientRemote {
  credentials: ClientRemoteCredentials
}

/** The section's locale namespace (also the `locale` on the slot entry). */
const NS = 'settings.commandcode'

/** Same-origin OAuth endpoints served by the plugin host half. */
const OAUTH_START_URL = '/commandcode-oauth/start'
const OAUTH_STATUS_URL = '/commandcode-oauth/status'

/** Required client services (cordis fiber inject, mirroring the host settings surfaces). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials'] as const

/**
 * Mount the Command Code settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'commandcode-provider-ui: settings dictionaries')

  const injected = (): CommandCodeSectionInjected => {
    const { credentials } = ctx.remote as unknown as CommandCodeClientRemote
    return {
      credentials,
      oauth: { startUrl: OAUTH_START_URL, statusUrl: OAUTH_STATUS_URL },
    }
  }

  // Ordered right after Models: this page manages the credential behind the
  // commandcode route, the natural next stop after choosing a model.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'commandcode',
    order: 21,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: injected,
  }, CommandCodeSection))
}