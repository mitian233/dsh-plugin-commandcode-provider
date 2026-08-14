import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'

import { apply } from '../src/index.ts'

test('apply registers the configurable provider and adapter reversibly', async () => {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  apply(ctx, { apiKeyEnv: 'COMMANDCODE_API_KEY' })
  const llm = ctx.llm

  assert.deepEqual(llm.listProviders(), [{ id: 'commandcode', name: 'Command Code' }])
  assert.deepEqual(llm.listConfigurableProviders(), [{
    provider: 'commandcode', displayName: 'Command Code', settingsNs: 'llm-commandcode', settingsPath: [],
  }])
  await ctx.fiber.dispose()
  assert.deepEqual(llm.listProviders(), [])
  assert.deepEqual(llm.listConfigurableProviders(), [])
})
