import { LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'

import { modelSupportsReasoningEffort } from './models.ts'
import type { RequestDefaults, WireMessage, WireRequest, WireTool } from './types.ts'

export const COMMAND_CODE_CLI_VERSION = '1.15.1'
export const COMMAND_CODE_MAX_TOKENS = 64_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Normalize a working directory to Command Code's compatibility project slug. */
export function projectSlugFromWorkingDir(workingDir: string): string {
  const slug = workingDir
    .toLowerCase()
    .replace(/^[a-z]:/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'project'
}

function textFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

function assertNoImages(blocks: readonly ContentBlock[]): void {
  if (blocks.some((block) => block.type === 'image')) {
    throw new LlmError('Command Code v1 does not support image input.', 'UNSUPPORTED')
  }
  for (const block of blocks) {
    if (block.type === 'tool-result') assertNoImages(block.content)
  }
}

function toolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsText)
    if (isRecord(parsed)) return parsed
  } catch {
    // A local history tool call must be a complete JSON object before replay.
  }
  throw new LlmError('Command Code tool-call history requires JSON object arguments.', 'INVALID_REQUEST')
}

function serializeAssistant(message: Message): WireMessage {
  const content: Array<Extract<WireMessage, { role: 'assistant' }>['content'][number]> = []
  for (const block of message.content) {
    if (block.type === 'text') content.push({ type: 'text', text: block.text })
    else if (block.type === 'reasoning') content.push({ type: 'reasoning', text: block.text })
    else if (block.type === 'tool-call') content.push({
      type: 'tool-call', toolCallId: block.id, toolName: block.name, input: toolArguments(block.arguments),
    })
  }
  return { role: 'assistant', content }
}

function serializeUser(message: Message, toolNames: ReadonlyMap<string, string>): WireMessage[] {
  const output: WireMessage[] = []
  const text = message.content.filter((block) => block.type === 'text')
  if (text.length > 0 || message.content.every((block) => block.type !== 'tool-result')) {
    output.push({ role: 'user', content: text.map((block) => ({ type: 'text', text: block.text })) })
  }
  for (const block of message.content) {
    if (block.type !== 'tool-result') continue
    output.push({
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: block.toolCallId, toolName: toolNames.get(block.toolCallId) ?? 'unknown',
        output: { type: block.isError ? 'error-text' : 'text', value: textFromBlocks(block.content) },
      }],
    })
  }
  return output
}

/**
 * Build one tool-call-id → tool-name lookup from assistant tool calls.
 * DSH's ToolResultBlock carries no name, so a tool result must recover its
 * call's name from the paired assistant tool-call block. This is a single O(N)
 * pass over all messages followed by O(1) lookups per result.
 */
function collectToolNames(messages: readonly Message[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool-call') names.set(block.id, block.name)
    }
  }
  return names
}

/** Convert all DSH history roles without dropping text, tool calls, or tool results. */
export function serializeMessages(messages: readonly Message[]): WireMessage[] {
  const toolNames = collectToolNames(messages)
  const output: WireMessage[] = []
  for (const message of messages) {
    assertNoImages(message.content)
    if (message.role === 'assistant') output.push(serializeAssistant(message))
    else if (message.role === 'system') output.push({ role: 'system', content: textFromBlocks(message.content) })
    else output.push(...serializeUser(message, toolNames))
  }
  return output
}

function serializeTools(tools: readonly ToolSchema[] | undefined): WireTool[] {
  return (tools ?? []).map((tool) => ({
    type: 'function', name: tool.name, description: tool.description, input_schema: tool.parameters,
  }))
}

function reasoningEffort(options: GenerateOptions): string | undefined {
  const effort = options.reasoningEffort
  if (effort === undefined || effort === 'off') return undefined
  if (!modelSupportsReasoningEffort(options.model, effort)) {
    throw new LlmError(
      `Command Code model "${options.model}" does not support reasoning effort "${effort}".`,
      'UNSUPPORTED_REASONING_EFFORT',
    )
  }
  return effort
}

/**
 * Build the exact JSON body for the Command Code generate endpoint.
 */
export function serializeRequest(
  options: GenerateOptions,
  defaults: RequestDefaults,
): WireRequest {
  if (options.stop !== undefined) {
    throw new LlmError('Command Code v1 does not support stop sequences.', 'UNSUPPORTED')
  }
  for (const message of options.messages) assertNoImages(message.content)

  const now = defaults.now?.() ?? new Date()
  const maxTokens = Math.min(options.maxTokens ?? defaults.maxTokens ?? COMMAND_CODE_MAX_TOKENS, COMMAND_CODE_MAX_TOKENS)
  const effort = reasoningEffort(options)

  return {
      config: {
        workingDir: defaults.workingDir,
        date: now.toISOString().slice(0, 10),
        environment: `${process.platform}-${process.arch}, Node.js ${process.version}`,
        structure: [], isGitRepo: false, currentBranch: '', mainBranch: '', gitStatus: '', recentCommits: [],
      },
      memory: null,
      taste: null,
      skills: null,
      params: {
        model: options.model,
        messages: serializeMessages(options.messages),
        tools: serializeTools(options.tools),
        system: options.system ?? '',
        stream: true,
        max_tokens: maxTokens,
        temperature: options.temperature ?? 0.3,
        ...(effort === undefined ? {} : { reasoning_effort: effort }),
      },
      threadId: defaults.uuid?.() ?? crypto.randomUUID(),
  }
}

/** Header inputs shared by every dispatch; Authorization is added after credential resolution. */
export function commandCodeHeaders(defaults: RequestDefaults): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...defaults.attribution,
    'x-command-code-version': defaults.commandCodeVersion ?? COMMAND_CODE_CLI_VERSION,
    'x-cli-environment': 'production',
    'x-project-slug': projectSlugFromWorkingDir(defaults.workingDir),
    'x-taste-learning': 'true',
    'x-co-flag': 'false',
  }
}
