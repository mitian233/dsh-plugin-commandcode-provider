/** Static Command Code capability snapshot; unknown model IDs are deliberately conservative. */

export type CommandCodeInputModality = 'text' | 'image'
export type CommandCodeReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const TEXT_ONLY = ['text'] as const
const NO_EFFORTS: readonly CommandCodeReasoningEffort[] = []

export const MODEL_INPUT_MODALITIES: Readonly<Record<string, readonly CommandCodeInputModality[]>> = {
  'MiniMaxAI/MiniMax-M3': ['text', 'image'],
  'Qwen/Qwen3.6-Plus': ['text', 'image'],
  'Qwen/Qwen3.7-Flash': ['text', 'image'],
  'Qwen/Qwen3.7-Plus': ['text', 'image'],
  'Qwen/Qwen3.8-Max': ['text', 'image'],
  'claude-fable-5': ['text', 'image'],
  'claude-haiku-4-5-20251001': ['text', 'image'],
  'claude-opus-4-7': ['text', 'image'],
  'claude-opus-4-8': ['text', 'image'],
  'claude-opus-5': ['text', 'image'],
  'claude-sonnet-4-6': ['text', 'image'],
  'claude-sonnet-5': ['text', 'image'],
  'google/gemini-3.1-flash-lite': ['text', 'image'],
  'google/gemini-3.5-flash': ['text', 'image'],
  'google/gemini-3.5-flash-lite': ['text', 'image'],
  'google/gemini-3.6-flash': ['text', 'image'],
  'gpt-5.3-codex': ['text', 'image'],
  'gpt-5.4': ['text', 'image'],
  'gpt-5.4-mini': ['text', 'image'],
  'gpt-5.5': ['text', 'image'],
  'gpt-5.6-luna': ['text', 'image'],
  'gpt-5.6-sol': ['text', 'image'],
  'gpt-5.6-terra': ['text', 'image'],
  'meta/muse-spark-1.1': ['text', 'image'],
  'meta/muse-spark-1.2': ['text', 'image'],
  'meta/muse-spark-1.2-contributor': ['text', 'image'],
  'moonshotai/Kimi-K2.5': ['text', 'image'],
  'moonshotai/Kimi-K2.6': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code': ['text', 'image'],
  'moonshotai/Kimi-K2.7-Code-Highspeed': ['text', 'image'],
  'moonshotai/Kimi-K3': ['text', 'image'],
  'sakana/fugu-ultra': ['text', 'image'],
  'stepfun/Step-3.7-Flash': ['text', 'image'],
  'thinkingmachines/inkling': ['text', 'image'],
  'thinkingmachines/inkling-small': ['text', 'image'],
  'xai/grok-4.5': ['text', 'image'],
  'xiaomi/mimo-v2.5': ['text', 'image'],
}

export const MODEL_EFFORTS: Readonly<Record<string, readonly CommandCodeReasoningEffort[]>> = {
  'Qwen/Qwen3.8-Max': ['low', 'medium', 'xhigh'],
  'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-4-6': ['low', 'medium', 'high', 'xhigh', 'max'],
  'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  'deepseek/deepseek-v4-flash': ['high', 'max'],
  'deepseek/deepseek-v4-pro': ['high', 'max'],
  'gpt-5.3-codex': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.4-mini': ['low', 'medium', 'high'],
  'gpt-5.5': ['low', 'medium', 'high', 'xhigh'],
  'gpt-5.6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
  'gpt-5.6-terra': ['low', 'medium', 'high', 'xhigh', 'max'],
  'google/gemini-3.1-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash': ['low', 'medium', 'high'],
  'google/gemini-3.5-flash-lite': ['low', 'medium', 'high'],
  'google/gemini-3.6-flash': ['low', 'medium', 'high'],
  'sakana/fugu-ultra': ['high', 'xhigh'],
  'xai/grok-4.5': ['low', 'medium', 'high'],
  'zai-org/GLM-5.2': ['high', 'max'],
}

export function inputModalitiesForModel(model: string): readonly CommandCodeInputModality[] {
  return MODEL_INPUT_MODALITIES[model] ?? TEXT_ONLY
}

export function modelSupportsImageInput(model: string): boolean {
  return inputModalitiesForModel(model).includes('image')
}

export function reasoningEffortsForModel(model: string): readonly CommandCodeReasoningEffort[] {
  return MODEL_EFFORTS[model] ?? NO_EFFORTS
}

export function modelSupportsReasoningEffort(model: string, effort: string): boolean {
  return reasoningEffortsForModel(model).includes(effort as CommandCodeReasoningEffort)
}

/** Static fallback metadata consumed by model resolution; no catalog lookup is performed. */
export function modelDefaultsFor(model: string): {
  inputModalities: readonly CommandCodeInputModality[]
  reasoningEfforts: readonly CommandCodeReasoningEffort[]
  defaultMaxTokens: 64_000
} {
  return {
    inputModalities: inputModalitiesForModel(model),
    reasoningEfforts: reasoningEffortsForModel(model),
    defaultMaxTokens: 64_000,
  }
}
