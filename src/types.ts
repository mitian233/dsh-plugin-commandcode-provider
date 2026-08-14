/** Command Code generate endpoint wire types. */

export interface WireExecutionConfig {
  workingDir: string
  /** UTC calendar date in YYYY-MM-DD form. */
  date: string
  environment: string
  structure: []
  isGitRepo: false
  currentBranch: ''
  mainBranch: ''
  gitStatus: ''
  recentCommits: []
}

export interface WireTextContent { type: 'text'; text: string }
export interface WireReasoningContent { type: 'reasoning'; text: string }
export interface WireToolCallContent {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}
export interface WireToolResultContent {
  type: 'tool-result'
  toolCallId: string
  toolName?: string
  output: { type: 'text' | 'error-text'; value: string }
}

export type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: WireTextContent[] }
  | { role: 'assistant'; content: Array<WireTextContent | WireReasoningContent | WireToolCallContent> }
  | { role: 'tool'; content: WireToolResultContent[] }

export interface WireTool {
  type: 'function'
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface WireParams {
  model: string
  messages: WireMessage[]
  tools: WireTool[]
  system: string
  stream: true
  max_tokens: number
  temperature: number
  reasoning_effort?: string
}

/** Exact JSON body for POST /alpha/generate. */
export interface WireRequest {
  config: WireExecutionConfig
  memory: null
  taste: null
  skills: null
  params: WireParams
  threadId: string
}

export interface WireUsageDetails {
  noCacheTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface WireUsage {
  inputTokens: number
  outputTokens: number
  inputTokenDetails?: WireUsageDetails
}

export type WireEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-start' }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'reasoning-end' }
  | { type: 'tool-result' }
  | {
    type: 'tool-call'
    toolCallId: string
    toolName: string
    /** Translator validation requires at least one and selects input > args > arguments. */
    input?: unknown
    args?: unknown
    arguments?: unknown
  }
  | { type: 'finish'; finishReason: string; totalUsage?: WireUsage }
  | ({ type: 'error'; error: unknown; message?: unknown })
  | ({ type: 'error'; error?: unknown; message: unknown })

/** Adapter-owned values needed to build a fully deterministic wire request. */
export interface RequestDefaults {
  workingDir: string
  maxTokens?: number
  now?: () => Date
  uuid?: () => string
  commandCodeVersion?: string
  attribution?: Record<string, string>
}
