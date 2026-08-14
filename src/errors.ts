import { CONTEXT_WINDOW_EXCEEDED_CODE, INVALID_CREDENTIAL_CODE, LlmError, QUOTA_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError } from '@deepseek-ai/dsh-llm'

const AUTHORIZATION = /\bauthorization\s*([:=])\s*(?:Bearer\s+)?[^\s,;)}\]]+/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const NAMED_SECRET = /\b(api[-_ ]?key|apikey|access[-_ ]?token|refresh[-_ ]?token|token|secret|password)\s*([:=])\s*[^\s,;)}\]]+/gi
const QUERY_SECRET = /([?&](?:api[-_ ]?key|apikey|access_token|refresh_token|token|secret|password)=)[^&#\s]+/gi
const STANDALONE_SECRET = /\b(?:sk|rk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{16,}\b|\b(?:user|cc)_[A-Za-z0-9_-]{8,}\b|\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g

/** Remove credentials from every provider-controlled diagnostic string. */
export function redactCommandCodeErrorText(value: string): string {
  return value
    .replace(AUTHORIZATION, (_match, separator: string) => `Authorization${separator} Bearer [redacted]`)
    .replace(BEARER, 'Bearer [redacted]')
    .replace(NAMED_SECRET, (_match, name: string, separator: string) => `${name}${separator}[redacted]`)
    .replace(QUERY_SECRET, '$1[redacted]')
    .replace(STANDALONE_SECRET, '[redacted]')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract only documented/error-shaped fields, never arbitrary response data. */
export function extractCommandCodeErrorText(value: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  const visit = (current: unknown): void => {
    if (typeof current === 'string' || typeof current === 'number') {
      const part = String(current)
      if (!parts.includes(part)) parts.push(part)
      return
    }
    if (!isRecord(current) || seen.has(current)) return
    seen.add(current)
    for (const key of ['message', 'errorMessage', 'error', 'detail', 'details', 'code', 'type', 'reason']) {
      visit(current[key])
    }
    for (const key of ['status', 'statusCode', 'httpStatus']) {
      const status = current[key]
      if (typeof status === 'string' || typeof status === 'number') visit(`status: ${status}`)
    }
  }
  visit(value)
  return redactCommandCodeErrorText(parts.join(': '))
}

function statusFrom(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const candidate = value[key]
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate
    if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate)
  }
  for (const key of ['error', 'details']) {
    const nested = statusFrom(value[key])
    if (nested !== undefined) return nested
  }
  return undefined
}

/** Map HTTP and in-stream provider facts to stable DSH error codes. */
export function commandCodeErrorCode(status: number | undefined, error?: unknown): string {
  const effectiveStatus = status ?? statusFrom(error)
  const detail = extractCommandCodeErrorText(error)
  if (effectiveStatus === 401 || effectiveStatus === 403 || /\b(?:unauthori[sz]ed|forbidden|invalid[_ -]?(?:api )?key)\b/i.test(detail)) return 'AUTH'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (effectiveStatus === 429 || /\b(?:rate[_ -]?limit|too many requests)\b/i.test(detail)) return 'RATE_LIMIT'
  if (isContextWindowExceededError(detail) || /\bcontext_length_exceeded\b/i.test(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (effectiveStatus !== undefined && effectiveStatus >= 500 && effectiveStatus <= 599) return 'SERVER'
  if (effectiveStatus === 400) return 'INVALID_REQUEST'
  return effectiveStatus === undefined ? 'PROVIDER_ERROR' : `HTTP_${effectiveStatus}`
}

/** Build an already-redacted provider error suitable for HTTP or stream boundaries. */
export function commandCodeError(status: number | undefined, error?: unknown): LlmError {
  const detail = extractCommandCodeErrorText(error) || 'Command Code provider error'
  return new LlmError(detail, commandCodeErrorCode(status, error),
    status === undefined ? undefined : { status })
}

/** Missing credential failures name the reference, never the credential value. */
export function missingCredentialError(reference: string): LlmError {
  return new LlmError(`Command Code credential "${reference}" is missing.`, 'MISSING_CREDENTIAL')
}

/** Invalid credential failures name the reference, never the credential value. */
export function invalidCredentialError(reference: string): LlmError {
  return new LlmError(`Command Code credential "${reference}" is invalid.`, INVALID_CREDENTIAL_CODE)
}

/** Stable code for a nonempty finish reason not recognized by the protocol. */
export function unknownFinishReasonCode(reason: string): string {
  const code = reason.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  return code || 'UNKNOWN_FINISH_REASON'
}
