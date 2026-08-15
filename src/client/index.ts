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
 * through cordis services (`slots`, `locale`, `connection`).
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (`ctx.locale`).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { CommandCodeSection, type CommandCodeSectionInjected } from './CommandCodeSection.tsx'
import { en, zh } from './locales.ts'

/** The section's locale namespace (also the `locale` on the slot entry). */
const NS = 'settings.commandcode'

/** Same-origin OAuth endpoints served by the plugin host half. */
const OAUTH_START_URL = '/commandcode-oauth/start'
const OAUTH_STATUS_URL = '/commandcode-oauth/status'

/** Required client services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection']

/**
 * Mount the Command Code settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'commandcode-provider-ui: settings dictionaries')

  const injected = (): CommandCodeSectionInjected => {
    const { api } = ctx.get('connection') as ConnectionHandle
    return {
      credentials: api.credentials,
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
