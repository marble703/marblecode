# Coding Agent Core

Small, secure-by-default coding agent core for local CLI workflows.

## Current Status

This repository now contains a runnable MVP that can complete one basic patch-driven coding task end to end.

Implemented today:

- CLI entrypoint
- config loading
- provider abstraction with an OpenAI-compatible implementation
- traditional OpenAI-compatible `POST /chat/completions` model calls
- rule-based routing
- context building
- tool registry
- structured patch preview/apply/rollback
- path and shell policy enforcement
- verifier execution
- local session logging with retention cleanup
- model connectivity check script
- a local smoke test that proves the patch-driven edit loop works once end to end

Validated in this repository:

- provider connectivity check returned `MODEL_OK`
- one real coding task modified `src/router/index.ts`
- project build succeeded after the real edit

## Current Capabilities

- Run a single-agent coding loop with a fixed step cap
- Route tasks between `cheap`, `code`, and `strong` model profiles
- Collect bounded context from explicit files and recent files
- Exclude sensitive files from normal context and tool access
- Read files, list files, search text, read git diff, and run restricted shell commands
- Ask the model for structured patch output instead of direct file writes
- Preview and confirm patches before applying them
- Run configured verifier commands after patch application
- Persist request, context, model, tool, patch, and verifier artifacts in local session directories

## Current Limits

- Provider implementation is only OpenAI-compatible Chat Completions
- No GUI
- No vector search or embeddings
- No native provider streaming UI yet
- No native provider tool-calling loop yet
- Patch operations currently work at whole-file granularity for replacements

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Edit `agent.config.jsonc`:

```bash
nano agent.config.jsonc
```

3. Set your API key.

Preferred approach:

```bash
export OPENAI_API_KEY=your_key_here
```

If you are testing against a local compatible endpoint, the current MVP also accepts an inline key directly in `providers.openai.apiKeyEnv`. That is supported for convenience, but keeping the key in an environment variable is still safer.

4. Build the project:

```bash
npm run build
```

5. Run the CLI:

```bash
node dist/index.js run "fix the router fallback logic" --file src/router/index.ts
```

Skip patch confirmation:

```bash
node dist/index.js run "fix the router fallback logic" --file src/router/index.ts --yes
```

6. Optional: run the local smoke test without any external API.

```bash
npm run smoke:edit
```

7. Check whether the configured model is reachable.

```bash
npm run check:model -- --model cheap
```

## Scripts

- `npm run build`: compile the project
- `npm run dev`: run the CLI with `tsx`
- `npm run smoke:edit`: run a local no-network patch-application smoke test
- `npm run check:model -- --model cheap`: verify the configured provider, key, base URL, and model

## Notes

- Runtime model access uses the OpenAI-compatible `POST /chat/completions` flow.
- Shell execution is restricted to the workspace root and uses a deny-by-default security baseline.
- The agent writes code through structured patch operations, not direct model-controlled file writes.
- `agent.config.jsonc` is intentionally gitignored because it may contain local endpoints or credentials.

## Configuration

- Fill the provider base URL in `agent.config.jsonc` at `providers.openai.baseUrl`.
  `http://...` and `https://...` are both accepted in the current MVP so local compatible endpoints can be tested.
- Prefer storing the API key in the shell environment variable named by `providers.openai.apiKeyEnv`.
- The current implementation also accepts an inline API key in `providers.openai.apiKeyEnv` for local testing.
- If your compatible API uses different model IDs, update `models.cheap.model`, `models.code.model`, and `models.strong.model`.

## Repository Layout

- `src/cli`: CLI entrypoint
- `src/agent`: agent loop
- `src/provider`: model abstraction and OpenAI-compatible provider
- `src/router`: static model routing
- `src/context`: bounded context construction
- `src/tools`: tool registry and built-in tools
- `src/patch`: patch format, preview, apply, rollback
- `src/policy`: path and shell policy enforcement
- `src/verifier`: post-patch verification
- `src/session`: local session persistence and cleanup
- `docs/mvp-v1.md`: architecture and protocol contract
- `README.zh-CN.md`: Chinese project overview

See `docs/mvp-v1.md` for the MVP contract.
