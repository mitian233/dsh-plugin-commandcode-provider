# Command Code provider for DeepSeek Harness

`dsh-plugin-commandcode-provider` adds the `commandcode` LLM provider route to
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness). It
sends requests to Command Code's `/alpha/generate` API.

## Installation

This plugin is a standalone DSH plugin. It does not modify the DeepSeek Harness
repository: install it into a profile with `dsh plugin`, the official plugin
manager.

### Run DSH

The official npm form runs the harness without a global install:

```sh
npx @deepseek-ai/dsh web
```

If `dsh` is already on your `PATH` (installed globally or via a package
manager), `dsh web` is equivalent. This plugin is compatible with DSH
`0.1.0-rc.6` and later (npm `next` tag).

### Install the plugin into a profile

From the plugin checkout, install the local directory into a profile. The
first use initializes the profile (with `@deepseek-ai/dsh-base` as its first
bundle):

```sh
cd /path/to/dsh-plugin-commandcode-provider

# Official form, no global dsh needed:
npx @deepseek-ai/dsh plugin --profile web add .

# Or with a global dsh on PATH:
dsh plugin --profile web add .
```

`add .` anchors the relative path to the invoking directory, so it links this
checkout into the profile's pnpm-managed `node_modules`. Any other pnpm spec
works the same way — an npm package, a packed tarball, or a git host:

```sh
dsh plugin --profile web add ./dsh-plugin-commandcode-provider-0.1.0.tgz
dsh plugin --profile web add github:mitian233/dsh-plugin-commandcode-provider
```

Remove the plugin with:

```sh
dsh plugin --profile web remove dsh-plugin-commandcode-provider
```

### Load the plugin row

Reference the installed package by name in the profile's `cordis.patch.yml` (or
an overlay) — see [Configuration](#configuration). Bare plugin `name`s resolve
through the profile directory's Node parent-walk, so the installed package is
found without extra wiring.

### Verify

```sh
dsh --profile web --dump-config   # shows the llm-commandcode layer and row
dsh web                           # boot the Web UI
```

### Develop and test

Dependencies install from npm against the DSH packages published under the
`next` tag (`^0.1.0-rc.6`); no DSH workspace checkout is required:

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run test        # node --import tsx --test tests/*.spec.ts
pnpm run build       # tsc -> dist/
```

`pnpm install` may ask to approve the `esbuild` build script (a `tsx`
dependency); run `pnpm approve-builds` when prompted.

### Reference implementation

The browser-assisted key retrieval flow mirrors
[`pi-commandcode-provider`](https://github.com/patlux/pi-commandcode-provider),
the Command Code provider for [pi](https://github.com/earendil-works/pi) (the
terminal AI assistant). That project's OAuth login
([`src/oauth.ts`](https://github.com/patlux/pi-commandcode-provider/blob/main/src/oauth.ts))
and local callback server
([`src/auth-server.ts`](https://github.com/patlux/pi-commandcode-provider/blob/main/src/auth-server.ts))
are the upstream contract this plugin ports:

- One-shot local HTTP server on `127.0.0.1:5959` (with a small fallback
  range), accepting exactly one valid `POST /callback` and then closing.
- Studio authorization URL
  `https://commandcode.ai/studio/auth/cli?callback=<localhost>&state=<token>`
  with a CSRF state token.
- CORS allowed origins `commandcode.ai` / `staging.commandcode.ai` /
  `localhost:3000`, plus Chrome Private Network Access preflight headers.
- On callback: validate the state token, store the API key as credentials,
  close the server.

Differences in this DSH plugin: the flow is driven from the settings page
(button click → host routes → polling) instead of pi's `/login` command, and
the key is stored through DSH's credentials service (`COMMANDCODE_API_KEY`)
instead of pi's `auth.json`. The manual paste fallback exists on both sides.

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

### Get an API key with the OAuth button

The settings page (Command Code section, right after Models) offers a
**Command Code OAuth** button. Clicking it starts a browser-assisted key
retrieval flow:

1. The plugin's host half launches a one-shot local callback server on
   `127.0.0.1` (port `5959` by default, with a small fallback range).
2. A Command Code Studio authorization page opens in your default browser.
   After you sign in, Studio POSTs your API key back to
   `http://localhost:<port>/callback`.
3. The host validates the CSRF state token, stores the key under
   `COMMANDCODE_API_KEY` through the credentials service, and **closes the
   local server automatically**.
4. The settings page polls the host and confirms once the key is stored.

The flow needs DSH's web server (Web profiles). If the automatic transfer
fails or times out, the manual API-key input below the button remains
available as a fallback. A second attempt while one is pending is refused.

The same-origin routes the browser half calls are `/commandcode-oauth/start`
and `/commandcode-oauth/status`; Studio POSTs to the local `/callback`.

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

Credential refresh, dynamic model discovery or catalog
caching, image inputs, and `stop` sequences are intentionally unsupported.
Image and `stop` requests fail before network dispatch. This plugin does not
change DSH host control flow or the agent loop.
