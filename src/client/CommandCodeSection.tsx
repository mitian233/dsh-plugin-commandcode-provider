/**
 * Command Code settings section (browser half).
 *
 * A self-contained settings page next to the Models page: shows whether the
 * `COMMANDCODE_API_KEY` credential is configured, offers a one-click jump to
 * Command Code Studio's OAuth page, and a write-only API key input that saves
 * through the DSH credentials service — the same seam the plugin's host half
 * reads on every request.
 *
 * The section is intentionally simple: no model catalog, no base-URL editing.
 * Those stay in the composition entry, and this page only manages the one
 * credential the provider route needs.
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CredentialView } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CommandCodeSettingsKey } from './locales.ts'

/** Credential reference this section manages (matches the host default). */
export const COMMANDCODE_API_KEY_REF = 'COMMANDCODE_API_KEY'

/** Registration-side business face for the section. */
export interface CommandCodeSectionInjected {
  /** Credentials-domain wire face (describe/set/unset). */
  credentials: {
    describe(payload: { refs: string[] }): Promise<{
      result: { ok: boolean; value?: { credentials?: Record<string, CredentialView> }; error?: { message: string } }
    }>
    set(payload: { ref: string; value: string }): Promise<{ result: { ok: boolean; error?: { message: string } } }>
    unset(payload: { ref: string }): Promise<{ result: { ok: boolean; error?: { message: string } } }>
  }
  /** Same-origin OAuth endpoints served by the plugin host half. */
  oauth: {
    startUrl: string
    statusUrl: string
  }
}

/** Full component props: shell (`close`), locale (`t`), injected face. */
export type CommandCodeSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.commandcode'>
  & InjectFace<CommandCodeSectionInjected>

/** A short inline status message rendered under the form. */
function Notice({ tone, children }: { tone: 'ok' | 'error'; children: ReactNode }): ReactNode {
  const color = tone === 'ok' ? '#16a34a' : '#dc2626'
  return <p style={{ color, fontSize: 12, margin: '8px 0 0' }}>{children}</p>
}

const field: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12, maxWidth: 480,
}
const label: CSSProperties = { fontSize: 12, fontWeight: 600 }
const input: CSSProperties = {
  font: 'inherit', padding: '8px 10px', borderRadius: 6, border: '1px solid #3f3f46',
  background: 'transparent', color: 'inherit',
}
const row: CSSProperties = { display: 'flex', gap: 8, marginTop: 8 }

export function CommandCodeSection(props: CommandCodeSectionProps): ReactNode {
  const { t, credentials, oauth } = props
  const [keyState, setKeyState] = useState<CredentialView | undefined>(undefined)
  const [checked, setChecked] = useState(false)
  const [loadFailure, setLoadFailure] = useState<string | undefined>(undefined)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | undefined>(undefined)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setLoadFailure(undefined)
    try {
      const response = await credentials.describe({ refs: [COMMANDCODE_API_KEY_REF] })
      if (!response.result.ok) {
        setLoadFailure(t('loadError'))
        return
      }
      setKeyState(response.result.value?.credentials?.[COMMANDCODE_API_KEY_REF])
    } catch {
      setLoadFailure(t('loadError'))
    } finally {
      setChecked(true)
    }
  }, [credentials, t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const keyValue = keyDraft.trim()
  const configured = keyState?.configured === true
  const writable = keyState?.writable !== false

  const save = async (): Promise<void> => {
    if (keyValue.length === 0) {
      setNotice({ tone: 'error', text: t('keyBlank') })
      return
    }
    setBusy(true)
    setNotice(undefined)
    try {
      const response = await credentials.set({ ref: COMMANDCODE_API_KEY_REF, value: keyValue })
      if (!response.result.ok) {
        setNotice({ tone: 'error', text: response.result.error?.message ?? t('saveError') })
        return
      }
      setKeyDraft('')
      setNotice({ tone: 'ok', text: t('saved') })
      await refresh()
    } catch {
      setNotice({ tone: 'error', text: t('saveError') })
    } finally {
      setBusy(false)
    }
  }

  const clear = async (): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    try {
      const response = await credentials.unset({ ref: COMMANDCODE_API_KEY_REF })
      if (!response.result.ok) {
        setNotice({ tone: 'error', text: response.result.error?.message ?? t('clearError') })
        return
      }
      setConfirmingClear(false)
      setNotice({ tone: 'ok', text: t('cleared') })
      await refresh()
    } catch {
      setNotice({ tone: 'error', text: t('clearError') })
    } finally {
      setBusy(false)
    }
  }

  /** Start an OAuth attempt: ask the host for a Studio URL, open it, poll. */
  const startOAuth = async (): Promise<void> => {
    setOauthBusy(true)
    setNotice(undefined)
    try {
      const response = await fetch(oauth.startUrl)
      const body = (await response.json()) as { url?: string; error?: string }
      if (!response.ok || body.url === undefined) {
        setNotice({ tone: 'error', text: body.error ?? t('saveError') })
        return
      }
      window.open(body.url, '_blank', 'noopener')
      // Poll until the host reports the callback landed (or an error/timeout).
      const deadline = Date.now() + 5 * 60 * 1000
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        const statusResponse = await fetch(oauth.statusUrl)
        const status = (await statusResponse.json()) as { state: string; message?: string }
        if (status.state === 'done') {
          await refresh()
          setNotice({ tone: 'ok', text: t('saved') })
          return
        }
        if (status.state === 'error') {
          setNotice({ tone: 'error', text: status.message ?? t('saveError') })
          return
        }
      }
      setNotice({ tone: 'error', text: t('saveError') })
    } catch {
      setNotice({ tone: 'error', text: t('saveError') })
    } finally {
      setOauthBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <h2 style={{ margin: 0, fontSize: 16 }}>{t('title')}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>{t('description')}</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
        <span style={{ width: 10, height: 10, borderRadius: 5, background: configured ? '#16a34a' : '#71717a' }} />
        <span style={{ fontSize: 13 }}>
          {checked ? (configured ? t('configured') : t('notConfigured')) : t('loading')}
        </span>
        {loadFailure === undefined ? null : (
          <span style={{ fontSize: 12, color: '#dc2626' }}>{loadFailure}</span>
        )}
      </div>

      <div style={field}>
        <label style={label} htmlFor="commandcode-api-key">{t('keyLabel')}</label>
        <input
          id="commandcode-api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          style={input}
          value={keyDraft}
          placeholder={configured ? t('keyStored') : t('keyPlaceholder')}
          disabled={busy || !writable}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        <div style={row}>
          <button type="button" onClick={() => { void save() }} disabled={busy || !writable}>
            {busy ? t('saving') : t('save')}
          </button>
          {configured && writable ? (
            <button type="button" onClick={() => setConfirmingClear(true)} disabled={busy}>
              {t('clear')}
            </button>
          ) : null}
        </div>
        {!writable ? <Notice tone="error">{t('readOnly')}</Notice> : null}
        {notice === undefined ? null : <Notice tone={notice.tone}>{notice.text}</Notice>}
      </div>

      <div style={{ marginTop: 8 }}>
        <button
          type="button"
          onClick={() => { void startOAuth() }}
          disabled={busy || oauthBusy}
        >
          {oauthBusy ? t('saving') : t('oauthButton')}
        </button>
        <p style={{ margin: '6px 0 0', fontSize: 12, opacity: 0.75 }}>{t('oauthHint')}</p>
      </div>

      {!confirmingClear ? null : (
        <div style={{ marginTop: 8, padding: 10, border: '1px solid #3f3f46', borderRadius: 6, maxWidth: 480 }}>
          <p style={{ margin: '0 0 8px', fontSize: 13 }}>{t('clearConfirm')}</p>
          <button type="button" onClick={() => { void clear() }} disabled={busy}>
            {busy ? t('clearing') : t('clear')}
          </button>
          {' '}
          <button type="button" onClick={() => setConfirmingClear(false)} disabled={busy}>
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  )
}
