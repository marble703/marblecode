# Architecture Overview

This document describes the current repository architecture as it exists today. It is intentionally narrower than a long-term design doc and more accurate than the old MVP plan.

## Goals

The runtime is built around a few constraints:

- local-first CLI workflows
- safe-by-default file and shell access
- provider-agnostic agent loops built on structured JSON steps
- host-controlled patch application instead of model-controlled file writes
- explicit session artifacts so planning, execution, rollback, and debugging stay inspectable

## Main User Flows

### `run`

The normal coding loop.

1. CLI parses the request and loads merged local + project config.
2. The host routes the task to a model alias.
3. Context is built from explicit files, pasted snippets, keyword recall, and recent files.
4. The agent loop runs with JSON responses of type `tool_call`, `patch`, or `final`.
5. Patch previews are shown unless `--yes` is enabled.
6. The host applies the patch, records rollback metadata, and runs the verifier.
7. Verifier failures can trigger bounded repair attempts.

### `plan`

The read-only planner loop.

1. Planner receives explicit files, pasted snippets, and bounded context.
2. Planner may search with read-only tools.
3. Planner returns structured `plan`, `plan_append`, `plan_update`, `tool_call`, or `final` responses.
4. The host persists plan artifacts and planner logs for later inspection or resume.

### `plan --execute`

The planner-driven execution flow.

1. Planner produces a structured plan, optionally as a partial planning window.
2. Host normalizes the plan, builds an execution graph, and may execute only the next configured window of waves.
3. Additional waves can be appended later through `plan_append` plus `plan.delta.<revision>.json` artifacts.
4. Code/test/docs steps run through coder subagents.
5. Verify steps run through the verifier path.
6. Failed steps may retry, switch to a fallback model, trigger local replan with execution feedback (undeclared changed files, affected subgraph), or leave the host waiting for another planning window.

### `tui`

An interactive terminal front end for `run`, `plan`, and `plan --execute` that also exposes planner-session inspection and live viewing.

### `rollback`

Uses recorded rollback metadata from a prior session to restore replaced or deleted files.

## High-Level Runtime Shape

At a high level, the runtime looks like this:

```text
CLI/TUI
  -> config loading
  -> routing
  -> context selection
  -> tool registry + policy engine
  -> agent loop or planner loop
  -> patch apply / verifier / rollback
  -> session artifacts and logs
```

Planner execute extends that flow:

```text
planner loop
  -> normalized / appended plan
  -> execution graph
  -> wave selection window
  -> file locks / ownership
  -> coder subagents
  -> verifier step
  -> retry / fallback / local replan / next planning window
```

## Module Map

### `src/cli`

Command-line entrypoints for:

- `run`
- `plan`
- `tui`
- `rollback`

The CLI stays thin and delegates to the runtime modules.

### `src/config`

Loads and validates runtime configuration.

Current config layering:

- local runtime config from `agent.config.jsonc`
- project overrides from `.marblecode/config.jsonc`
- project verifier plan from `.marblecode/verifier.md`

This module also supplies defaults for routing, context, policy, verifier, and session behavior.

### `src/router`

Maps prompts onto model aliases and execution policy.

Current routing still uses static heuristics, but the output now influences both normal coding runs and planner execute behavior.

### `src/context`

Builds bounded context packets from:

- explicit files
- pasted snippets
- keyword recall
- recent files

It also generates a context selection summary so the model sees why files were chosen.

### `src/tools`

Defines the host tool registry, tool-provider abstraction, and built-in tools.

Current built-in tools include:

- `read_file`
- `list_files`
- `search_text`
- `run_shell`
- `git_diff`
- `git_status`
- `git_log`
- `git_show`
- `git_diff_base`

Planner mode gets a restricted read-only subset.

Current tool registration now supports both direct tools and provider-backed registration. Builtins are wired through provider helpers so future LSP/MCP integrations can reuse the same registry boundary without changing agent/planner callsites.

The current provider boundary now also includes:

- provider metadata for `kind`, `access`, `description`, and capabilities
- registry-level provider introspection through `listProviders()` and `getProviderForTool()`
- explicit provider lifecycle disposal through `disposeAll()`
- a minimal config boundary for future external providers via `tools.externalProvidersEnabled` and `tools.allow`
- a deterministic readonly diagnostics fixture provider used only for regression coverage, not for production LSP/MCP integration

The next layer now in place is shared registry setup in `src/tools/setup.ts`:

- agent and planner callsites no longer need to hand-roll built-in provider registration
- external providers are only accepted when they declare `kind: 'external'`, `access: 'read_only'`, and pass the config gate
- external providers remain disabled by default until `tools.externalProvidersEnabled=true` and the provider id appears in `tools.allow`
- lifecycle disposal is now exercised in real CLI/TUI/subtask paths, not just on the registry class in isolation

### `src/policy`

Enforces path, shell, environment, and provider-network restrictions.

This module is the main safety boundary between model intent and host execution.

Current boundary hardening includes:

- workspace-relative path checks plus resolved-path validation so symlink escapes are rejected
- shell syntax restrictions for chained commands, subshell syntax, redirection, and inline environment assignments
- explicit write-path narrowing for planner subtasks and other restricted runs

### `src/agent`

Implements the JSON-step coding loop for `run` and coder subtasks.

It is responsible for:

- sending model requests
- executing tool calls
- previewing and applying patches
- invoking the verifier
- returning structured completion or intervention states

Current internal split:

- `index.ts`: public entrypoint and rollback helper
- `model.ts`: request construction and system prompt assembly
- `parse.ts`: model-step JSON parsing and normalization
- `runtime.ts`: runtime loop plus patch/apply/verifier orchestration
- `messages.ts`: patch preview rendering and intervention/failure message assembly

### `src/patch`

Owns the internal patch representation and patch application pipeline.

The model never writes files directly. The host interprets structured patch operations and records backups plus rollback metadata during apply.

Patch application also distinguishes baseline drift from generic apply errors so agent and planner flows can surface clearer recovery guidance when a file changes after patch generation.

### `src/verifier`

Resolves verifier commands and runs them after patch application or planner verify steps.

It supports:

- explicit per-run commands
- config-defined commands
- markdown verifier plans from `.marblecode/verifier.md`
- repo-based fallback discovery
- structured verifier-failure analysis

Current internal split:

- `index.ts`: orchestration entrypoint for `runVerifier()`
- `commands.ts`: command resolution across manual/config/markdown/discovery sources
- `execute.ts`: shell execution and failure aggregation
- `analysis.ts`: verifier-failure prompt building and JSON parsing

### `src/session`

Stores local artifacts under `.agent/sessions` and cleans old sessions by age and count.

This module also resolves normal and planner sessions, powers recent-session views, and provides the persistence backbone for rollback and planner inspection.

### `src/provider`

Defines the unified model interface and the current `OpenAICompatibleProvider` implementation.

Only OpenAI-compatible Chat Completions is implemented today, but the internal request/response model already reserves fields for streaming, tool calls, reasoning token accounting, and vendor metadata.

### `src/planner`

Implements the read-only planner loop and the host-side planner execution flow.

Current internal split:

- `index.ts`: public entrypoint plus planner session setup and runtime/bootstrap wiring
- `loop.ts`: top-level planner loop and result mapping
- `runtime.ts`: planner request/state/result helpers and step classification
- `execution-types.ts`: execution-state and strategy interfaces
- `execution-state.ts`: persisted execution-state snapshot builder
- `execution-machine.ts`: planner execution phase transition table and event dispatch
- `execution-strategies.ts`: execution strategy selection and policy implementations
- `model.ts`: planner request building
- `parse.ts`: planner response parsing and plan normalization
- `artifacts.ts`: planner artifact writing and session resume/load helpers
- `view-model.ts`: planner artifact aggregation for TUI/WebUI-facing read models
- `execute.ts`: top-level planner execution orchestration and wave handoff
- `execute-wave.ts`: wave selection, conflict checks, and blocked-dependent annotations
- `execute-verify.ts`: verify-step execution and verify-repair handoff
- `execute-subtask.ts`: subtask attempt setup, lock preparation, and coder-subagent execution helpers
- `execute-resume.ts`: execution resume from persisted execution artifacts
- `prompts.ts`: subtask, repair, and replan prompt builders
- `state.ts`: ready/active/blocked/done derivation
- `recovery.ts`: local replan flow
- `graph.ts`: execution graph, conflict edges, and waves
- `locks.ts`: file lock ownership and write assertions
- `utils.ts`: planner-shared helpers

For the details of task graphs, waves, and file locks, see `docs/project/planner-parallel-graph.zh-CN.md`.

### `src/tui`

Provides the interactive terminal UI and planner-session viewers.

Planner artifact loading, event normalization, and planner read-model APIs now live in `src/planner/view-model.ts`, while `src/tui/planner-view.ts` focuses on terminal formatting and rendering normalized timeline entries.

The TUI is not a separate runtime stack; it is a front end over the same `run` / `plan` / `plan --execute` flows.

For command-level usage, see `docs/project/tui.md`.

### `src/shared`

Shared cross-module helpers.

Important current examples:

- `json-response.ts`: fenced/balanced JSON extraction for agent, planner, and verifier responses
- `file-walk.ts`: recursive workspace file traversal reused by context and tools
- `redact.ts`: structured log redaction

## Planner Execute Foundations

Planner execute is the main place where the architecture has grown beyond the original MVP.

Current host-side execution foundations include:

- normalized planner steps with explicit dependencies and file scopes
- execution graphs with `dependency`, `must_run_after`, `conflict`, and `fallback` edges, including conflict reason/domain metadata for semantic write coupling
- execution waves derived from the graph
- file lock tables with write ownership and guarded-read downgrade
- conflict-aware concurrency bounded by `maxConcurrentSubtasks`
- execution-state snapshots persisted as `execution.state.json`
- strategy-driven scheduling via `serial`, `fail`, `aggressive`, and `deterministic` policy modes
- retry, fallback model selection, graph fallback activation with downstream dependency substitution, proposal-validated bounded local replan with lock-compatibility checks, and degraded non-critical step handling
- persisted execution artifacts for TUI, offline inspection, and execution resume, with the planner view now reading `execution.state.json` phase/strategy/wave/recovery metadata directly
- first-pass resume ownership and planning-window metadata such as `reusedLockOwnerStepIds` and `planningWindowState`, so partial planning windows and guarded-owner reuse are inspectable through persisted state instead of only transient runtime variables

Failure propagation is intentionally conservative:

- tasks already started in the same wave are allowed to finish and then get merged back into host state
- if a step fails, graph fallback steps are activated first when available
- if execution still stops, pending downstream dependents are annotated as blocked by failed dependencies instead of being treated as silently skipped

This is best understood as “host-managed structured execution,” not just a bigger planner prompt.

## Artifact Model

The architecture relies heavily on session artifacts instead of implicit in-memory state.

Common artifacts include:

- `request.json`
- `context.json`
- `model.jsonl`
- `tools.jsonl`
- `patch.json`
- `verify.json`
- `rollback.json`

Planner-specific artifacts include:

- `plan.json`
- `plan.state.json`
- `plan.events.jsonl`
- `planner.request.json`
- `planner.context.packet.json`
- `planner.log.jsonl`
- `execution.graph.json`
- `execution.state.json`
- `execution.locks.json`
- `replan.proposal.<stepId>.json`
- `replan.rejected.<stepId>.json`

These artifacts make the runtime easier to inspect, resume, replay mentally, and debug.

## Safety Model

Several design decisions are central to the current architecture:

- models do not write files directly
- shell commands are policy-checked and run with the workspace root as their current directory
- sensitive files are excluded from normal context and tool access
- write access can be narrowed to explicit file grants
- planner execute writes are additionally constrained by file locks
- sessions redact secrets by default

## What This Document Is And Is Not

This document is the current architecture overview.

It is not:

- a historical MVP contract
- a detailed planner execute deep dive
- a TUI command manual
- a refactor roadmap

Use the other docs for those purposes:

- `README.md`: feature and workflow overview
- `docs/project/planner-parallel-graph.zh-CN.md`: planner execute graph and lock model
- `docs/project/tui.md`: TUI command reference
