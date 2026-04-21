# Coding Agent Core

Small, secure-by-default coding agent core for local CLI workflows.

## Current Status

This repository now contains a runnable MVP that can complete one basic patch-driven coding task end to end.

Implemented today:

- CLI entrypoint
- config loading
- project-scoped `.marblecode/` config loading
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
- markdown verifier plans with project-local storage
- local session logging with retention cleanup
- model connectivity check script
- a local smoke test that proves the patch-driven edit loop works once end to end

Validated in this repository:

- provider connectivity check returned `MODEL_OK`
- one real coding task modified `src/router/index.ts`
- project build succeeded after the real edit

## Current Capabilities

- Run a single-agent coding loop with a fixed step cap
- Run a read-only planner loop that searches and produces structured task plans without writing files
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
- Resolve verifier plans from `.marblecode/verifier.md`
- Allow per-run verifier overrides with `--verify`
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

Create a read-only plan instead of editing files:

```bash
node dist/index.js plan "Refactor the router module and add tests"
```

Plan first, then execute subtasks serially until verifier passes:

```bash
node dist/index.js plan "Fix src/math.js so add returns a + b" --workspace examples/manual-test-suite/project --execute
```

Resume a planner session with more input:

```bash
node dist/index.js plan "Keep the current route export surface" --session <session-id-or-path>
```

Show the latest planner result in the terminal:

```bash
npm run show:planner -- --last
```

Open the lightweight live planner TUI:

```bash
npm run tui:planner -- --last
```

Open the interactive coding TUI for new conversations:

```bash
npm run tui
```

Open the TUI against another workspace:

```bash
node dist/index.js tui --workspace /path/to/project
```

Skip patch confirmation:

```bash
node dist/index.js run "Fix the add function so it returns a + b" --file examples/snippets/math.ts --yes
```

Run with pasted code instead of a file:

```bash
node dist/index.js run "Fix this function" --paste $'function add(a, b) {\n  return a - b;\n}'
```

Override the verifier for one run:

```bash
node dist/index.js run "Fix the add function" --file examples/snippets/math.ts --verify "npm run build"
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
- `npm run smoke:verifier`: run the existing verifier against `examples/verifier-fixture`
- `npm run test:examples`: run the deterministic manual suite for tools, automatic context selection, planner flows, TUI command parsing, patch apply/reject/rollback, verifier behavior, retry paths, shell, and policy checks
- `npm run check:model -- --model cheap`: verify the configured provider, key, base URL, and model
- `npm run check:planner`: run the planner task in `examples/manual-test-suite/planner-task.md` with a real configured planning model
- `npm run check:planner:execute`: run the full serial planner -> subagent -> verifier workflow on a temp manual-suite workspace with a real model
- `npm run show:planner -- --last`: render a planner session summary, timeline, and current subtask status in the terminal
- `npm run tui:planner -- --last`: open a lightweight live planner dashboard that polls session files and renders steps, subtasks, and timeline in-place
- `npm run tui`: open an interactive terminal UI that can create new `run`, `plan`, or `plan --execute` conversations
- `show:planner --last` and `tui:planner --last` now pick the most recent planner session, not the latest coder/verifier child session

## Notes

- Runtime model access uses the OpenAI-compatible `POST /chat/completions` flow.
- Shell execution is restricted to the workspace root and uses a deny-by-default security baseline.
- The agent writes code through structured patch operations, not direct model-controlled file writes.
- `agent.config.jsonc` is intentionally gitignored because it may contain local endpoints or credentials.
- Session directories now include `rollback.json`, `backups.json`, and backed-up source files under `backups/` when files are replaced or deleted.

## Configuration

- `agent.config.jsonc` remains the local runtime config for providers, models, and local policy.
- `.marblecode/config.jsonc` is the project-scoped config entrypoint for shared verifier and future project overrides.
- `.marblecode/verifier.md` is the preferred place for shared verifier plans.
- project config may override shared runtime sections such as `context`, `policy`, `routing`, `session`, and `verifier`
- project config may inject project-specific shell environment variables through `env`
- if no manual verifier, JSON verifier command list, or `.marblecode/verifier.md` exists, the verifier falls back to auto-discovery from the repo
- use `--workspace /path/to/project` on `run`, `plan`, `tui`, or `rollback` to set the session working directory without moving your main config file
- `context.autoDeny` is a gitignore-like list for files that should not be auto-read during context selection, search, or normal tool browsing
- files in `context.autoDeny`, or read-only requests outside the workspace, can still be granted explicitly with `--file` or `/files`
- Fill the provider base URL in `agent.config.jsonc` at `providers.openai.baseUrl`.
  `http://...` and `https://...` are both accepted in the current MVP so local compatible endpoints can be tested.
- Prefer storing the API key in the shell environment variable named by `providers.openai.apiKeyEnv`.
- The current implementation also accepts an inline API key in `providers.openai.apiKeyEnv` for local testing.
- If your compatible API uses different model IDs, update `models.cheap.model`, `models.code.model`, and `models.strong.model`.

## Context Selection

- `--file path/to/file.ts`: inject an explicit file into context
- `--paste "..."`: inject pasted code as a `[Pasted ~N lines #k]` context item
- if `--file` is omitted, the context builder extracts query terms from the prompt and pasted snippets, scores candidate files, and auto-selects the top 3-5 likely files
- explicit `--file` entries always stay at the front of the context list and win tie-breaks over auto-selected candidates
- the model also receives a `Context selection summary` block listing extracted query terms and the top auto-selected files
- recent files are also used as a fallback source
- if the selected context is still insufficient, the model is expected to use `search_text`, `list_files`, and `read_file` before editing

## Planner

- `node dist/index.js plan "..."` runs a read-only planner loop by default
- add `--execute` to let the host execute planner-produced code/test/verify steps serially through subagents and a final verifier pass
- in execute mode, planner stays on `planningModel` while code/test/repair subtasks run through a coder subagent on `codeModel`
- planner mode only exposes `read_file`, `list_files`, `search_text`, and `git_diff`
- planner mode now also exposes read-only git helpers such as `git_status`, `git_log`, `git_show`, and `git_diff_base`
- planner responses are limited to `plan`, `plan_update`, `tool_call`, and `final`
- planner mode retries invalid model output up to 3 times before failing the session
- planner and agent model calls also retry transient provider failures such as `429 rate limit`, timeouts, and short-lived `5xx` responses with backoff
- planner sessions persist `plan.json`, `plan.state.json`, `plan.events.jsonl`, `planner.request.json`, and `planner.context.packet.json`
- planner execution also records `execution.graph.json`, `execution.state.json`, and `execution.locks.json` so the host and TUI can explain waves, blocked steps, and file ownership
- planner also writes `planner.log.jsonl` with structured plan snapshots, invalid-output retries, and terminal summaries
- retry settings live under `session.modelRetryAttempts` and `session.modelRetryDelayMs`; defaults are 3 retries with a 3s base delay
- planner supports basic resume and replan by rerunning `plan` with `--session` or `--last`
- planner execution still defaults to one subtask at a time, but it now builds an execution graph, tracks ready/active/failed/blocked step sets, manages file lock ownership, retries failed code/test/docs nodes, can fall back to a configured model alias, and may locally replan a failed node before giving up
- routing now supports `maxConcurrentSubtasks`, `subtaskMaxAttempts`, `subtaskFallbackModel`, `subtaskReplanOnFailure`, and `subtaskConflictPolicy` so the execution model can grow toward safe concurrency without changing the default serial behavior
- `planner.context.packet.json` is the future handoff format for planner-driven subtask workers; today it is logged for determinism and TUI-friendly inspection
- use `npm run show:planner -- --session <session-id-or-path>` or `--last` to render the current plan, event timeline, and recorded subtask execution results
- `show:planner` now renders step attempts, recovery state, execution waves, file lock ownership, executor identity, model alias, changed files, and child agent session directories so you can confirm planner -> coder delegation

## Interactive TUI

- `npm run tui` opens a simple interactive terminal session for new requests
- add `--workspace` when launching the TUI, or use `/workspace <path>` inside it, to switch the active session working directory
- use `/mode run`, `/mode plan`, or `/mode execute` to switch between coding, planning, and planner execution workflows
- use `/sessions` to refresh the recent session list and `/open <index|session-id-or-path>` to inspect a prior session inside the same TUI
- use `/resume [index|session-id-or-path|last]` to continue a planner session and `/replan <extra prompt>` to continue the opened planner session with more input
- use `/follow [index|session-id-or-path|last]` to open a live planner viewer and press `q` to return to the main TUI
- use `/files path1 path2`, `/add-file`, and `/remove-file` to manage explicit files, `/verify <cmd>` to override the verifier for `run`, and `/yes on` to auto-approve patches
- use `/paste` to enter multiline pasted context, ending with a single `.` line
- files listed with `/files` are also treated as explicit read/write grants for otherwise auto-denied files inside the workspace, and as explicit read-only grants for files outside the workspace
- use `/inspect step <step-id|index>` and `/open-child <step-id|index>` to drill into planner execution results
- use `/show-state` to print the current TUI mode, workspace, and overrides
- use `/reset` to clear the current TUI state and `/quit` to exit
- in `run` mode, if `/yes` is off, the TUI will show the patch preview and ask for confirmation before applying it
- when the last opened session is a planner session, the TUI embeds a planner panel showing the current plan, subtasks, and timeline directly in the conversation UI
- see `docs/tui.md` for the full command reference and example workflows

## Multi-file Patch

- patch documents may contain multiple operations in one response when a fix spans implementation, tests, config, docs, or verifier files
- multi-file patch previews, apply, backup, and rollback all run through the same host patch pipeline

## Rollback And Backups

- when a patch replaces or deletes a file, the original file is automatically backed up into the session directory under `backups/`
- the rollback plan is saved in `rollback.json`
- roll back the latest session with `node dist/index.js rollback --last`
- or roll back a specific session with `node dist/index.js rollback --session <session-id-or-path>`

## Apply Failure Hints

- if patch application fails and you did not pass `--file`, the CLI now suggests rerunning with `--file` or `--paste`
- if context selection was too weak, the failure message also suggests making the request more specific

## Repository Layout

- `.marblecode`: project-scoped agent configuration and verifier plans
- `scripts`: local smoke checks, planner inspectors, and manual regression entrypoints
- `src/cli`: CLI entrypoint
- `src/agent`: agent loop
- `src/config`: config schema and config loading
- `src/planner`: read-only planning loop and serial planner execution flow
- `src/planner/graph.ts`: execution graph, conflict edges, and execution wave helpers
- `src/planner/locks.ts`: file lock ownership helpers used by planner execute
- `src/provider`: model abstraction and OpenAI-compatible provider
- `src/router`: static model routing
- `src/context`: bounded context construction
- `src/tools`: tool registry and built-in tools
- `src/patch`: patch format, preview, apply, rollback
- `src/policy`: path and shell policy enforcement
- `src/verifier`: post-patch verification
- `src/session`: local session persistence and cleanup
- `src/tui`: interactive terminal UI and planner session rendering
- `src/shared`: shared helpers used across modules
- `src/index.ts`: top-level entry that forwards to the CLI
- `examples/snippets`: small demo code snippets for testing coding edits
- `examples/verifier-fixture`: small TypeScript fixture project for verifier smoke checks
- `examples/manual-test-suite`: deterministic regression fixture plus real-model planner task docs for release-grade checks
- `docs/mvp-v1.md`: architecture and protocol contract
- `README.zh-CN.md`: Chinese project overview

## Verifier Markdown

Each `##` section in `.marblecode/verifier.md` defines one verifier step.

- `- run: ...` is required
- `- when: ...` is free-form documentation for humans and model analysis
- `- paths: src/**, scripts/**` limits a step to matching changed files
- `- platforms: linux, darwin, win32` limits a step by platform
- `- timeout: 120s` overrides the default verifier timeout for that step
- `- optional: true` marks a step as non-blocking

## Verifier Discovery

When no verifier is provided explicitly, the host now falls back to repo-based discovery in this order:

1. `package.json` exact scripts: `verify`, then `test`, then `build`
2. `Makefile`/`makefile` exact targets: `verify`, then `test`, then `build`
3. `Cargo.toml` -> `cargo test`
4. `go.mod` -> `go test ./...`
5. `pytest.ini`, `tox.ini`, or `pyproject.toml` with pytest signals -> `pytest`

Discovery is only a fallback. Shared project verifier behavior should still live in `.marblecode/verifier.md` when the project needs more than a simple default.

See `docs/mvp-v1.md` for the MVP contract.
