import assert from 'node:assert/strict'
import test from 'node:test'

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { commandCodeHeaders, serializeRequest } from '../src/serialize.ts'
import type { WireEvent } from '../src/types.ts'

const defaults = {
  workingDir: 'C:\\Work Space\\My_Project!',
  now: () => new Date('2026-08-14T23:59:59.999-08:00'),
  uuid: () => '00000000-0000-4000-8000-000000000000',
  maxTokens: 100_000,
  commandCodeVersion: '1.15.1',
  attribution: { 'user-agent': 'dsh-test' },
}

const request: GenerateOptions = {
  provider: 'commandcode',
  model: 'gpt-5.6-luna',
  system: 'Be concise.',
  temperature: 0.7,
  maxTokens: 100_000,
  reasoningEffort: 'high' as never,
  messages: [
    { id: 'message_1' as never, role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
    {
      id: 'message_2' as never,
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling tool' },
        { type: 'tool-call', id: 'call_1' as never, name: 'weather', arguments: '{"city":"Paris"}' },
      ],
      source: { kind: 'model', provider: 'commandcode', model: 'gpt-5.6-luna' },
    },
    {
      id: 'message_3' as never,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'call_1' as never, content: [{ type: 'text', text: 'sunny' }], isError: false }],
      source: { kind: 'tool', callId: 'call_1' as never },
    },
  ],
  tools: [{ name: 'weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
}

test('serializes the complete Command Code envelope and header inputs', () => {
  const serialized = serializeRequest(request, defaults)
  assert.deepEqual(serialized, {
    config: {
      workingDir: 'C:\\Work Space\\My_Project!',
      date: '2026-08-15',
      environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
      structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [],
    },
    memory: null, taste: null, skills: null,
    params: {
      model: 'gpt-5.6-luna',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'calling tool' }, { type: 'tool-call', toolCallId: 'call_1', toolName: 'weather', input: { city: 'Paris' } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'weather', output: { type: 'text', value: 'sunny' } }] },
      ],
      tools: [{ type: 'function', name: 'weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      system: 'Be concise.', stream: true, max_tokens: 64_000, temperature: 0.7, reasoning_effort: 'high',
    },
    threadId: '00000000-0000-4000-8000-000000000000',
  })
  assert.deepEqual(commandCodeHeaders(defaults), {
    'content-type': 'application/json',
    ...defaults.attribution,
    'x-command-code-version': '1.15.1', 'x-cli-environment': 'production',
    'x-project-slug': 'work-space-my-project', 'x-taste-learning': 'true', 'x-co-flag': 'false',
  })
})

test('uses temperature 0.3 and omits unsupported or absent reasoning', () => {
  const body = serializeRequest({ ...request, temperature: undefined, reasoningEffort: undefined }, defaults)
  assert.equal(body.params.temperature, 0.3)
  assert.equal('reasoning_effort' in body.params, false)
})

test('rejects stop, image blocks, and unsupported model efforts before dispatch', () => {
  assert.throws(() => serializeRequest({ ...request, stop: ['END'] }, defaults), (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED')
  assert.throws(() => serializeRequest({ ...request, messages: [{ ...request.messages[0], content: [{ type: 'image', attachment: {} as never }] }] }, defaults), (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED')
  assert.throws(() => serializeRequest({ ...request, model: 'future-model', reasoningEffort: 'high' as never }, defaults), (error: unknown) => error instanceof LlmError && error.code === 'UNSUPPORTED_REASONING_EFFORT')
})

test('wire tool calls retain required identity while translator validation owns argument presence', () => {
  const event: WireEvent = { type: 'tool-call', toolCallId: 'call_1', toolName: 'weather' }
  assert.deepEqual(event, { type: 'tool-call', toolCallId: 'call_1', toolName: 'weather' })
})

test('tool results recover their call name from the paired assistant tool-call', () => {
  const body = serializeRequest(request, defaults)
  const toolResult = body.params.messages[2]
  assert.deepEqual(toolResult, {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'call_1', toolName: 'weather', output: { type: 'text', value: 'sunny' } }],
  })
})

test('tool results without a paired assistant call fall back to unknown tool name', () => {
  const orphan = {
    ...request,
    messages: [
      { id: 'message_1' as never, role: 'user', content: [{ type: 'tool-result', toolCallId: 'orphan_1' as never, content: [{ type: 'text', text: 'no caller' }], isError: false }], source: { kind: 'tool', callId: 'orphan_1' as never } },
    ],
  }
  const body = serializeRequest(orphan, defaults)
  assert.deepEqual(body.params.messages, [
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'orphan_1', toolName: 'unknown', output: { type: 'text', value: 'no caller' } }] },
  ])
})

test('parallel tool calls each recover their own name by id', () => {
  const parallel = {
    ...request,
    messages: [
      {
        id: 'a' as never, role: 'assistant',
        content: [
          { type: 'tool-call', id: 'c1' as never, name: 'weather', arguments: '{}' },
          { type: 'tool-call', id: 'c2' as never, name: 'time', arguments: '{}' },
        ],
        source: { kind: 'model', provider: 'commandcode', model: 'gpt-5.6-luna' },
      },
      {
        id: 'b1' as never, role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c2' as never, content: [{ type: 'text', text: '12:00' }], isError: false }],
        source: { kind: 'tool', callId: 'c2' as never },
      },
      {
        id: 'b2' as never, role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1' as never, content: [{ type: 'text', text: 'sunny' }], isError: false }],
        source: { kind: 'tool', callId: 'c1' as never },
      },
    ],
  }
  const body = serializeRequest(parallel, defaults)
  assert.deepEqual(body.params.messages, [
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: {} },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'time', input: {} },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'c2', toolName: 'time', output: { type: 'text', value: '12:00' } },
      ],
    },
    {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'weather', output: { type: 'text', value: 'sunny' } },
      ],
    },
  ])
})
