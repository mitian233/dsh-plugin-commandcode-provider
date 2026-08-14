# Command Code Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a DSH `commandcode` LLM provider plugin that serializes DSH calls to Command Code, translates its line-delimited stream into correct `StreamChunk`s, and registers through the DSH plugin lifecycle.

**Architecture:** Keep the approved seven-layer structure: pure wire types/models/errors/serialization/parsing/translation modules sit below one transport adapter and a reversible Cordis function-plugin registration. The implementation follows pi Command Code request/event values where the approved specification says so, but DSH owns strict event validation, credentials, terminal ordering, and cancellation semantics.

**Tech Stack:** TypeScript 5.9, Node built-in test runner, `tsx`, DSH `@deepseek-ai/*` workspace packages, Cordis, Schemastery.

**Spec:** `docs/superpowers/specs/2026-08-14-commandcode-adapter-design.md`

## Global Constraints

- ESM-only; source-relative imports use explicit `.ts` suffixes.
- Function plugin exports named `name`, `inject`, `Config`, and `apply`; no default export.
- Credentials use only DSH's credentials seam and the launch-environment fallback described in the spec; do not read custom key/auth files.
- Register every host effect reversibly through the documented DSH lifecycle APIs.
- Do not modify DSH core or `agent-loop`.
- `stop` and image inputs fail before network dispatch as `UNSUPPORTED`.
- Preserve the protocol terminal ordering: all `block-end`, optional `usage`, then exactly one `finish`; yield nothing after `finish`.
- Do not commit pre-existing untracked/unstaged files. Commits stage only files changed for their task and include the required `openai-code-agent[bot]` co-author trailer.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Complete Command Code request, discriminated wire-event, usage, and configuration-context types. |
| `src/models.ts` | Static modality, reasoning-effort, and model default metadata. |
| `src/errors.ts` | Redaction, HTTP/in-stream classification, and stable error-code helpers. |
| `src/serialize.ts` | `GenerateOptions` to the fully specified Command Code request body/header inputs. |
| `src/stream.ts` | UTF-8-safe newline parser which ignores permitted non-JSON framing. |
| `src/translate.ts` | Wire-event validation and deterministic `StreamChunk` state machine. |
| `src/adapter.ts` | `CommandCodeAdapter`, fetch lifecycle, abort/idle watchdog, model resolution, and cleanup. |
| `src/index.ts` | Function-plugin config, credentials resolver, settings, and adapter registration. |
| `tests/mock-server.ts` | Local line-delimited JSON server with request capture, fragmented writes, held-open streams, and cancellation observation. |
| `tests/assemble.ts` | Helpers to collect and assert assembled DSH chunks. |
| `tests/*.spec.ts` | Layer-specific unit and transport tests. |
| `README.md` | Install/configure/use the plugin and document v1 limitations. |

### Task 1: Workspace Integration and Test Foundation

**Files:**
- Modify: `/Users/mikan/WebstormProjects/deepseek-harness/pnpm-workspace.yaml`
- Modify: `package.json`
- Create: `tests/mock-server.ts`
- Create: `tests/assemble.ts`
- Create: `tests/stream.spec.ts`

**Interfaces:**
- Produces `createMockServer(options)` returning URL, captured request, abort/cancellation observation, and a disposer.
- Produces `collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]>`.
- The external workspace path is `../dsh-plugin-commandcode-provider`.

- [ ] **Step 1: Add the plugin to the DSH workspace and install from the DSH root**

Add `- ../dsh-plugin-commandcode-provider` to `/Users/mikan/WebstormProjects/deepseek-harness/pnpm-workspace.yaml`. From the DSH root run:

```bash
pnpm install
```

Confirm the plugin resolves each `@deepseek-ai/*` dependency through the workspace without changing DSH source packages.

- [ ] **Step 2: Write the stream parser tests before implementation**

Create `tests/stream.spec.ts` with cases for fragmented UTF-8/newline boundaries, blank/comment/`event:`/`[DONE]` lines, `not json`, `data: non-json`, a valid `data: { ... }` event, and EOF. Assert that non-JSON framing is ignored, parsed values preserve order, and a parser EOF itself does not invent a finish event.

- [ ] **Step 3: Create reusable test fixtures**

Implement a mock HTTP server that writes specified byte chunks, optionally leaves its body open after the last event (`hangAfterLast`), records method/headers/body, delays a read, and observes an aborted/cancelled connection. Implement `collect()` and minimal chunk assertion helpers in `tests/assemble.ts`.

- [ ] **Step 4: Implement `src/stream.ts` and pass its tests**

Expose:

```ts
export async function* parseCommandCodeLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown>
```

Decode incrementally with `TextDecoder`, preserve incomplete final lines, remove a leading `data:` prefix, parse JSON only when possible, and ignore all specified framing/non-JSON lines. Do not classify parsed event schema here.

- [ ] **Step 5: Verify and commit the task**

Run:

```bash
pnpm run test -- tests/stream.spec.ts
pnpm run typecheck
```

Commit only this task's plugin files, plus the deliberate DSH workspace/lockfile changes in the host repository if `pnpm install` changed the lockfile.

### Task 2: Pure Wire Types, Models, Errors, and Serialization

**Files:**
- Create: `src/types.ts`
- Create: `src/models.ts`
- Create: `src/errors.ts`
- Create: `src/serialize.ts`
- Create: `tests/models.spec.ts`
- Create: `tests/errors.spec.ts`
- Create: `tests/serialize.spec.ts`

**Interfaces:**
- Produces `serializeRequest(options, defaults): WireRequest`.
- Produces `MODEL_INPUT_MODALITIES`, `MODEL_EFFORTS`, model lookup helpers, `redactCommandCodeErrorText()`, and `commandCodeErrorCode()`.
- `WireEvent` is a discriminated union matching the approved schema; validation errors use `MALFORMED_RESPONSE`.

- [ ] **Step 1: Write failing pure-function tests**

Add model snapshots covering `gpt-5.6-luna` image capability and `deepseek/deepseek-v4-pro` text-only capability. Add error tests proving bearer/key redaction and `context_length_exceeded` classification. Add serialization tests asserting the entire request body: `config` fields/fixed values, UTC `YYYY-MM-DD` date, `params.model`, `messages`, `tools`, `system`, `stream`, 64k cap, temperature default `0.3` and request override, null `memory`/`taste`/`skills`, and UUID `threadId`.

Also test `stop` and image rejection, reasoning omission, the complete header inputs including slug normalization, and model/effort compatibility.

- [ ] **Step 2: Define pure types and static metadata**

Implement `src/types.ts` with the complete request envelope and every approved wire event variant. Implement `src/models.ts` with the static modality/effort tables copied only where relevant from the pi reference, with no live catalog or cache. Ensure unknown model fallback is text-only with no reasoning efforts.

- [ ] **Step 3: Implement redaction/error classification**

Implement `src/errors.ts` so provider error bodies and nested in-stream errors are redacted before they become a `LlmError`. Map auth, rate limit, context window, server failures, invalid/missing credentials, and unknown finish-reason code normalization exactly as specified.

- [ ] **Step 4: Implement request serialization**

Implement `serializeRequest()` using DSH message/tool types. Use the exact request context defaults from the specification; normalize system/user/assistant/tool messages and standard JSON Schema tools. Reject unsupported inputs before fetch. Derive the project slug using the approved ASCII normalization algorithm.

- [ ] **Step 5: Verify and commit the task**

Run:

```bash
pnpm run test -- tests/models.spec.ts tests/errors.spec.ts tests/serialize.spec.ts
pnpm run typecheck
```

Commit only Task 2 files.

### Task 3: Strict Translation State Machine

**Files:**
- Create: `src/translate.ts`
- Create: `tests/translate.spec.ts`

**Interfaces:**
- Consumes `AsyncIterable<unknown>` from `parseCommandCodeLines()`.
- Produces `translate(events): AsyncGenerator<StreamChunk>`.
- Throws `LlmError('MALFORMED_RESPONSE')` before state mutation for schema-invalid parsed values and `LlmError('STREAM_CLOSED')` when source ends without `finish`.

- [ ] **Step 1: Write failing translator tests**

Cover every valid event, non-object JSON, unknown event type, missing/wrong-type fields, invalid usage detail, text/reasoning empty deltas, tool arguments as record and JSON string, invalid tool inputs, `input > args > arguments`, all finish-reason mappings, unknown finish code normalization, usage disjointness, in-stream redacted errors, open upstream after finish, and no-finish EOF.

Assert exact emitted chunk sequences, especially `block-end* -> usage? -> finish`, no chunks after finish, `EMPTY_RESPONSE`, and tool `argumentsDelta` raw JSON.

- [ ] **Step 2: Implement event validator and state machine**

Validate each parsed object against `WireEvent` before allocating blocks or updating state. Allocate monotonic indexes; lazily open text/reasoning; normalize tool inputs exactly once; defer all block ends/usage/finish until `finish`; and throw for in-stream provider errors or invalid event schema. Preserve the most recent valid usage attached to finish.

- [ ] **Step 3: Verify and commit the task**

Run:

```bash
pnpm run test -- tests/translate.spec.ts
pnpm run typecheck
```

Commit only Task 3 files.

### Task 4: Adapter Transport, Model Resolution, and Plugin Registration

**Files:**
- Create: `src/adapter.ts`
- Modify: `src/index.ts`
- Create: `tests/adapter.spec.ts`
- Create: `tests/index.spec.ts`

**Interfaces:**
- `CommandCodeAdapter extends LlmAdapter` implements `stream()`, `listModels()`, and `resolveModel()`.
- `apply(ctx, config)` registers the configurable provider and adapter reversibly.

- [ ] **Step 1: Write failing adapter/plugin tests**

Use the mock server to test a text/tool/usage request end to end; 401, 429, context 400, and 5xx mappings; complete request headers and JSON body; caller abort; idle timeout; finishing while body remains open; and `finally` cancellation. Add registration/disposer tests through the DSH test harness when available.

- [ ] **Step 2: Implement the adapter**

Implement request-time API-key resolution through DSH credentials then launch environment only when the credentials service is absent. Validate keys before headers. Combine caller abort, request timeout, and idle watchdog signals; issue the POST; map non-OK response errors through `errors.ts`; feed body to parser then translator; and always cancel unfinished upstream work in `finally`.

Implement `listModels()`/`resolveModel()` from static metadata with correct provider/model identity, text modality, default max tokens, and reasoning effort information.

- [ ] **Step 3: Replace registration placeholder**

Complete `src/index.ts` using `registerConfigurableProviders`, `registerAdapter`, the credentials resolver, settings-section installation, and retry-policy replacement. Preserve named exports and use disposers for all lifecycle effects.

- [ ] **Step 4: Verify and commit the task**

Run:

```bash
pnpm run test -- tests/adapter.spec.ts tests/index.spec.ts
pnpm run typecheck
pnpm run build
```

Commit only Task 4 files.

### Task 5: End-to-End Gate and Documentation

**Files:**
- Create: `README.md`
- Modify: tests only if full-suite failures expose a contract gap.

**Interfaces:**
- Documents installation in the paired DSH workspace, `credentialRef`/environment configuration, model/provider selection, and v1 exclusions.

- [ ] **Step 1: Write concise usage documentation**

Document paired-workspace installation, the `commandcode` provider route, `COMMANDCODE_API_KEY`, base URL and tuning config, text/tool/reasoning support, and unsupported OAuth/dynamic discovery/image/stop behavior.

- [ ] **Step 2: Run the complete validation gate**

From the plugin directory run:

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

From the DSH root run the targeted plugin/host integration check available after workspace installation. Record exact commands and results.

- [ ] **Step 3: Inspect final diff and commit**

Confirm only intended plugin/docs/test files are staged; inspect all changed files; commit README and any narrowly necessary test repair. Do not commit unrelated existing files.

## Review and Acceptance

- A `luna` reviewer validates each completed pure-layer task for contract/test coverage.
- A `terra` reviewer validates the adapter/integration diff for terminal ordering, cancellation, credentials, and lifecycle behavior.
- The orchestrator runs the full three-command gate, inspects the final diff, disposes every reviewer finding, and reports residual risks.
