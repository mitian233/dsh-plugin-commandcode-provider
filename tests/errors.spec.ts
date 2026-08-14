import assert from 'node:assert/strict'
import test from 'node:test'

import {
  commandCodeErrorCode,
  extractCommandCodeErrorText,
  invalidCredentialError,
  missingCredentialError,
  redactCommandCodeErrorText,
  unknownFinishReasonCode,
} from '../src/errors.ts'

test('redacts bearer credentials and standalone Command Code tokens before errors escape', () => {
  const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456'
  const userToken = 'user_abcdefghijk'
  const commandCodeToken = 'cc_abcdefghijk'
  const text = redactCommandCodeErrorText(
    `Authorization: Bearer ${secret}; api_key=${secret}; token=${secret}; ${userToken}; ${commandCodeToken}`,
  )
  for (const value of [secret, userToken, commandCodeToken]) assert.equal(text.includes(value), false)
  assert.match(text, /Bearer \[redacted\]/)
})

test('extracts nested provider facts and classifies context-window errors', () => {
  const providerError = {
    error: { message: 'context_length_exceeded: Bearer secret-token', code: 'context_length_exceeded' },
    status: 400,
  }
  const detail = extractCommandCodeErrorText(providerError)
  assert.equal(detail.includes('secret-token'), false)
  assert.equal(commandCodeErrorCode(400, providerError), 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(commandCodeErrorCode(401, 'nope'), 'AUTH')
  assert.equal(commandCodeErrorCode(429, 'slow down'), 'RATE_LIMIT')
  assert.equal(commandCodeErrorCode(503, 'retry'), 'SERVER')
  assert.equal(missingCredentialError('COMMANDCODE_API_KEY').code, 'MISSING_CREDENTIAL')
  assert.equal(invalidCredentialError('COMMANDCODE_API_KEY').code, 'INVALID_CREDENTIAL')
})

test('normalizes unknown finish reasons to stable codes', () => {
  assert.equal(unknownFinishReasonCode('content filter!'), 'CONTENT_FILTER')
  assert.equal(unknownFinishReasonCode('---'), 'UNKNOWN_FINISH_REASON')
})
