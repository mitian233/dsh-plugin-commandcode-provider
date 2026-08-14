# Command Code provider for DeepSeek Harness

`dsh-plugin-commandcode-provider` adds the `commandcode` LLM provider route to
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness). It
sends requests to Command Code's `/alpha/generate` API.

## Development installation

This plugin is developed as a paired DSH workspace. From the DSH repository
root, add the adjacent plugin path to `pnpm-workspace.yaml` if it is not
already present:

```yaml
packages:
  - ../dsh-plugin-commandcode-provider
```

Install and run every plugin command **from the DSH root** so the private DSH
workspace packages resolve correctly:

```sh
pnpm install
pnpm --filter dsh-plugin-commandcode-provider test
pnpm --filter dsh-plugin-commandcode-provider typecheck
pnpm --filter dsh-plugin-commandcode-provider build
```

Running `pnpm` from the plugin directory is unsupported for this paired setup:
it cannot resolve DSH's workspace-only `@deepseek-ai/*` packages.

## Configuration

Load the named plugin `llm-commandcode` in a DSH composition. The provider
route is `commandcode`; select a model as `commandcode/<model-id>` (for
example, `commandcode/gpt-5.6-luna`).

```yaml
- id: llm-commandcode
  name: dsh-plugin-commandcode-provider
  config:
    apiKeyEnv: COMMANDCODE_API_KEY # DSH credential reference
    baseURL: https://api.commandcode.ai
    maxTokens: 64000
    defaultContextWindow: 1000000
    streamIdleTimeoutMs: 300000
    retryPolicy:
      mode: default
```

The current configuration field is named `apiKeyEnv` for compatibility with
DSH credential references; use it to select a reference other than the default
`COMMANDCODE_API_KEY` when needed:

```yaml
config:
  apiKeyEnv: COMMANDCODE_API_KEY
  baseURL: https://api.commandcode.ai
  maxTokens: 64000
  defaultContextWindow: 1000000
  streamIdleTimeoutMs: 300000
```

Configure `COMMANDCODE_API_KEY` through DSH's credentials service. If that
service is not installed, the plugin reads the same reference from DSH's launch
environment. A mounted credentials service is authoritative: a miss does not
fall back to the environment. Blank, whitespace-only, or HTTP-header-invalid
keys are rejected before a request is sent.

`baseURL` changes the API origin. `maxTokens` is capped at 64,000;
`defaultContextWindow`, `streamIdleTimeoutMs`, and `retryPolicy` tune model
metadata, idle streaming behavior, and DSH-managed retries. `temperature` is
accepted as a compatibility setting; each request's explicit temperature wins,
and the wire default is `0.3`. Static `models` entries can supply display,
context-window, and maximum-token overrides; this does not discover models.

## Supported behavior

- Text messages and streaming text output.
- Standard JSON Schema tools and complete tool calls.
- Reasoning deltas for models that advertise supported reasoning efforts.
- Usage reporting, cancellation, idle timeout handling, and deterministic
  HTTP/in-stream error classification.

## v1 non-goals

OAuth/device login, credential refresh, dynamic model discovery or catalog
caching, image inputs, and `stop` sequences are intentionally unsupported.
Image and `stop` requests fail before network dispatch. This plugin does not
change DSH host control flow or the agent loop.
