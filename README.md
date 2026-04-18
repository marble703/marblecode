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
- pasted-snippet and keyword-search context inputs
- tool registry
- structured patch preview/apply/rollback
- automatic source-file backups before replace/delete operations
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
- Accept pasted snippets as first-class context items such as `[Pasted ~3 lines #1]`
- Pull basic keyword-matched files into context even when `--file` is omitted
- Exclude sensitive files from normal context and tool access
- Read files, list files, search text, read git diff, and run restricted shell commands
- Ask the model for structured patch output instead of direct file writes
- Preview and confirm patches before applying them
- Back up original files before replace/delete patch operations
- Roll back the latest or a chosen session with one CLI command
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

5. Run the CLI against a simple snippet outside `src`:

```bash
node dist/index.js run "Fix the add function so it returns a + b" --file examples/snippets/math.ts
```

Skip patch confirmation:

```bash
node dist/index.js run "Fix the add function so it returns a + b" --file examples/snippets/math.ts --yes
```

Run with pasted code instead of a file:

```bash
node dist/index.js run "Fix this function" --paste $'function add(a, b) {\n  return a - b;\n}'
```

6. Optional: run the local smoke test without any external API.

```bash
npm run smoke:edit
```

7. Check whether the configured model is reachable.

```bash
npm run check:model -- --model cheap
```

8. Roll back the latest applied patch session.

```bash
node dist/index.js rollback --last
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
- Session directories now include `rollback.json`, `backups.json`, and backed-up source files under `backups/` when files are replaced or deleted.

## Configuration

- Fill the provider base URL in `agent.config.jsonc` at `providers.openai.baseUrl`.
  `http://...` and `https://...` are both accepted in the current MVP so local compatible endpoints can be tested.
- Prefer storing the API key in the shell environment variable named by `providers.openai.apiKeyEnv`.
- The current implementation also accepts an inline API key in `providers.openai.apiKeyEnv` for local testing.
- If your compatible API uses different model IDs, update `models.cheap.model`, `models.code.model`, and `models.strong.model`.

## Context Selection

- `--file path/to/file.ts`: inject an explicit file into context
- `--paste "..."`: inject pasted code as a `[Pasted ~N lines #k]` context item
- if `--file` is omitted, the context builder still tries keyword-based matching against workspace files
- recent files are also used as a fallback source

## Rollback And Backups

- when a patch replaces or deletes a file, the original file is automatically backed up into the session directory under `backups/`
- the rollback plan is saved in `rollback.json`
- roll back the latest session with `node dist/index.js rollback --last`
- or roll back a specific session with `node dist/index.js rollback --session <session-id-or-path>`

## Apply Failure Hints

- if patch application fails and you did not pass `--file`, the CLI now suggests rerunning with `--file` or `--paste`
- if context selection was too weak, the failure message also suggests making the request more specific

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
- `examples/snippets`: small demo code snippets for testing coding edits
- `docs/mvp-v1.md`: architecture and protocol contract
- `README.zh-CN.md`: Chinese project overview

See `docs/mvp-v1.md` for the MVP contract.
