import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inputModalitiesForModel,
  modelDefaultsFor,
  MODEL_EFFORTS,
  MODEL_INPUT_MODALITIES,
  reasoningEffortsForModel,
} from '../src/models.ts'

test('static model capabilities preserve the approved catalog snapshot', () => {
  assert.deepEqual(MODEL_INPUT_MODALITIES['gpt-5.6-luna'], ['text', 'image'])
  assert.deepEqual(MODEL_INPUT_MODALITIES['deepseek/deepseek-v4-pro'], undefined)
  assert.deepEqual(inputModalitiesForModel('deepseek/deepseek-v4-pro'), ['text'])
  assert.deepEqual(MODEL_EFFORTS['gpt-5.6-luna'], ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(reasoningEffortsForModel('deepseek/deepseek-v4-pro'), ['high', 'max'])
  assert.deepEqual(reasoningEffortsForModel('future-model'), [])
  assert.deepEqual(modelDefaultsFor('future-model'), {
    inputModalities: ['text'], reasoningEfforts: [], defaultMaxTokens: 64_000,
  })
})
