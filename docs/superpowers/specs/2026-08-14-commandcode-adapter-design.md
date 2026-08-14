# Command Code LLM Adapter Design

**Status:** Approved for planning  
**Date:** 2026-08-14  
**Plugin:** `dsh-plugin-commandcode-provider`

## Goal

Provide DeepSeek Harness (DSH) with an ESM-only function plugin that registers the `commandcode` provider route on `ctx.llm`. The adapter sends DSH generation requests to Command Code's `/alpha/generate` endpoint and translates newline-delimited JSON events into DSH `StreamChunk`s.

The first release supports API-key credentials, text inputs, tool calls, reasoning deltas, usage accounting, cancellation, idle timeouts, and deterministic error classification.

## Scope and boundaries

### In scope

- Workspace-integrated development with DSH package dependencies resolved through the host pnpm workspace.
- A `CommandCodeAdapter extends LlmAdapter` registered under the `commandcode` provider.
- Credentials resolved at request time via DSH's credentials seam and the configured credential reference.
- Static Command Code model capabilities and reasoning-effort metadata.
- Request serialization for DSH text/system/assistant/tool messages and standard JSON Schema tools.
- Newline-delimited JSON transport parsing and stateful translation to `StreamChunk`.
- HTTP and protocol error mapping, secret redaction, abort propagation, and an idle-read watchdog.
- Unit and transport-level tests, plus a concise README.

### Explicitly out of scope

- OAuth/device-login flow, token storage, and credential refresh.
- Dynamic model directory retrieval, cache persistence, runtime re-registration, slash commands, and cost calculation.
- Image input in v1. Serialization rejects image blocks with a DSH unsupported-input error.
- Changes to DSH's `agent-loop` or other core control flow.

### Extension boundary

`Config` and `CommandCodeAdapter` retain narrowly scoped configuration/defaults seams. A later OAuth or catalog implementation must be added as separate modules and must not alter the serializer/translator contracts.

## Architecture

The implementation uses one responsibility per module, mirroring the DSH DeepSeek adapter layout while keeping Command Code wire semantics isolated.

| Module | Responsibility | Runtime dependencies |
| --- | --- | --- |
| `src/types.ts` | Command Code request/event/usage TypeScript types only. | None |
| `src/models.ts` | Static model input modalities and reasoning-effort capability tables. | None |
| `src/errors.ts` | Provider-message extraction, redaction, and DSH error-code classification. | `@deepseek-ai/dsh-llm` types/errors |
| `src/serialize.ts` | Convert `GenerateOptions` plus plugin defaults to the Command Code request body. | DSH LLM types |
| `src/stream.ts` | Incrementally decode newline-delimited JSON without losing partial UTF-8 lines. | `LlmError` |
| `src/translate.ts` | Convert parsed wire events to ordered DSH stream chunks and terminal state. | DSH LLM types/errors |
| `src/adapter.ts` | Fetch lifecycle, headers, combined abort signal, idle watchdog, and cleanup. | DSH LLM/timeout/launch environment |
| `src/index.ts` | Named function-plugin exports, config, settings integration, and reversible registration. | Cordis and DSH extension APIs |

No module imports `src/index.ts`; dependencies flow from `index.ts` into the adapter and from adapter into the protocol modules. Relative TypeScript imports use explicit `.ts` suffixes.

## Registration and configuration

The function plugin exports named `name`, `inject`, `Config`, and `apply` bindings only. `apply()` must:

1. register `commandcode` as a configurable provider with its settings namespace;
2. create an adapter using validated defaults and request-time credential resolvers;
3. register that adapter for `['commandcode']`;
4. install the settings section; and
5. replace the registration when retry-policy configuration changes.

All registrations are acquired through `ctx.effect()`/`ctx.on()` or APIs returning disposers, so unload/HMR reverses every effect. No custom API-key files are read. The default credential reference is `COMMANDCODE_API_KEY`.

`CommandCodeAdapter` must implement both `listModels()` and `resolveModel()`. They preserve the selected provider/model identity, report `inputModalities: ['text']`, obtain opaque reasoning-effort IDs from the static capability table, and expose `defaultMaxTokens` capped at 64,000. Unknown models use the configured context window and text-only fallback but do not advertise unsupported reasoning efforts. This allows DSH to validate `reasoningEffort` before dispatch rather than rejecting every such request through the base adapter default.

Credential resolution is deterministic: first validate the configured credential reference; if the DSH credentials service is present, resolve only through that service and do not fall back to the process environment after a miss. Only when the service is absent may the adapter obtain the named value from `launchEnvironmentOf(ctx)`. Empty, whitespace-only, or header-invalid values fail before `fetch` as `MISSING_CREDENTIAL` or `INVALID_CREDENTIAL`; messages may contain the credential reference but never its value.

## Request flow

1. DSH selects the `commandcode` adapter and calls `stream(options)`.
2. The adapter resolves the configured credential reference immediately before dispatch, combines the caller signal with its timeout/watchdog signal, and serializes the request.
3. `serializeRequest()` produces the v1 wire envelope:
   - `config` carries the Command Code execution context: `workingDir`, an ISO-8601 `date`, CLI/environment metadata, and the remaining stable project-context fields required by the verified reference request;
   - `params.model` carries the selected model. `params` also contains `messages`, `tools`, `system`, `stream: true`, `max_tokens` (capped at `min(request maxTokens/default, 64_000)`), configured temperature, and an optional supported `reasoning_effort`;
   - `memory`, `taste`, and `skills` are explicitly `null`; a generated UUID supplies `threadId`;
   - text, system prompts, assistant tool calls, tool results, and JSON Schema tools map to the Command Code message/tool fields;
   - `stop` is not supported by the verified v1 Command Code envelope, so `options.stop !== undefined` throws `LlmError(..., 'UNSUPPORTED')` before any network request;
   - image input fails before network dispatch.
4. The adapter performs the POST with `Authorization`, `attributionHeaders()`, and the complete fixed Command Code compatibility header set: `x-command-code-version` from the pinned Command Code CLI-version constant, `x-cli-environment: production`, `x-project-slug` from the execution context, `x-taste-learning: true`, and `x-co-flag: false`. Tests assert each header and its value before starting the idle watchdog.
5. `parseCommandCodeLines()` accepts JSON lines and `data: <JSON>` lines; it ignores blank lines, comments, `event:` framing, `[DONE]`, and any plain or `data:` line that cannot parse as JSON. Only successfully parsed values that violate the Command Code event schema are rejected by `translate()` with a stable protocol error.
6. The parsed events are passed to `translate()`.
7. A `finally` block cancels an unfinished upstream reader/body even after the consumer stops early.

## Stream translation contract

The translator owns all wire-event state. It allocates monotonically increasing DSH block indexes and never emits chunks after a terminal `finish`.

- Empty text or reasoning deltas do not open blocks.
- Nonempty text/reasoning deltas open the corresponding block lazily and append to it.
- A tool-call event opens a tool-call block and emits one complete `tool-call-delta`. Wire `input` is `unknown`: a record is serialized once with `JSON.stringify`; a string must parse to a JSON object and is reserialized once into canonical object JSON; every other shape is a stable malformed-response error. `argumentsDelta` is therefore always raw JSON for the argument object, never double-encoded JSON text.
- On Command Code finish, the translator defers terminal emission until it has closed every opened block.
- Terminal order is always: all `block-end` chunks, then optional `usage`, then exactly one `finish`.
- A successful finish with no content blocks becomes an `EMPTY_RESPONSE` error finish.
- A closed transport without a finish event throws `LlmError('STREAM_CLOSED')`.
- A wire `{ type: 'error' }` event extracts nested message/code/type/status data, redacts it, classifies it with the same provider classifier as HTTP failures, and throws `LlmError`; it is not converted to `STREAM_CLOSED` and no later chunks may be emitted.

Finish reasons map as follows:

| Wire reason | DSH reason |
| --- | --- |
| `tool-calls` | `{ kind: 'tool-calls' }` |
| `length`, `max_tokens`, `max-tokens`, `max_output_tokens` | `{ kind: 'max-tokens' }` |
| normal stop | `{ kind: 'stop' }` |
| unknown reason | error finish with a stable provider code |

Usage preserves DSH's disjoint token convention: use `noCacheTokens` when supplied; otherwise compute uncached input as `max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`.

## Errors, cancellation, and observability

- HTTP status and in-stream provider errors are classified at the adapter boundary: 401/403 to authentication, 429 to rate-limit, context-window provider errors to `CONTEXT_WINDOW_EXCEEDED`, and 5xx to server failure.
- Error text must redact `Authorization: Bearer …`, API keys, and equivalent sensitive fields before creating a DSH error.
- Parser malformation, missing terminal events, unsupported image/stop input, invalid tool input or usage, and unknown terminal reasons use stable DSH error codes.
- Caller abort produces the normal aborted terminal outcome; the idle watchdog produces DSH's stream-idle-timeout outcome.
- Command Code attribution headers are sent with every fetch.

## Test strategy

Use the Node test runner and a local mock server. The server emits newline-delimited JSON, supports fragmented writes, configurable status/error bodies, request capture, delayed reads, and `hangAfterLast`.

| Test file | Primary assertions |
| --- | --- |
| `stream.spec.ts` | fragmented line decoding, blank lines, comments/`event:`/`data:` framing, ignored `not json` and `data: non-json` lines, `[DONE]`, schema-invalid parsed events, EOF handling |
| `serialize.spec.ts` | complete envelope with `config` execution context and `params.model`, all request fields, 64k cap, effort omission, `stop` rejection without network dispatch, image rejection |
| `translate.spec.ts` | lazy blocks, string and record tool input canonicalization, terminal ordering, usage mapping, finish mapping, in-stream error classification/redaction, no-finish EOF |
| `models.spec.ts` | static capability-table snapshots plus known/unknown `resolveModel()` behavior and reasoning capabilities |
| `errors.spec.ts` | HTTP and in-stream redaction and context-overflow classification |
| `adapter.spec.ts` | text/tool/usage integration, status mapping, exact headers/envelope, credential resolution precedence and validation, abort, watchdog, and upstream cancellation |
| `index.spec.ts` | provider registration and disposer behavior where the DSH test harness supports it |

The acceptance gate is `pnpm run typecheck`, `pnpm run build`, and `pnpm run test` passing in the workspace-resolved environment.

## Workspace integration

The plugin becomes a DSH pnpm workspace member solely to resolve matching private `@deepseek-ai/*` packages from the host's pinned sources. The host change is explicit: add `../dsh-plugin-commandcode-provider` as a member in `/Users/mikan/WebstormProjects/deepseek-harness/pnpm-workspace.yaml`, retain the plugin's exact `@deepseek-ai/*` versions, and run `pnpm install` from the host root. Commit the resulting host lockfile only if pnpm changes it; do not modify DSH runtime packages or `agent-loop`.

This external-path topology is a development integration, not a portable standalone CI topology. Before publishing or enabling independent CI, the plugin must instead be moved under the DSH checkout, vendored/submoduled at a stable in-workspace path, or consume published compatible DSH packages. The workspace acceptance gate runs from a clean paired checkout after installation, followed by the plugin's typecheck, build, and test commands.

## Non-goals and future work

OAuth and dynamic model discovery remain intentionally absent. A future implementation may add an `auth/` module and a catalog client, but must retain the adapter's existing API-key path, static fallback table, serializer result shape, and translation state machine.
