# Repository Refactor Plan

This document captures the next cleanup pass for the repository structure. The repo already has sensible top-level module boundaries, but a few core files now combine too many responsibilities and should be split before more planner and TUI work lands.

## Status

Implemented in the current pass:

- extracted shared JSON parsing into `src/shared/json-response.ts`
- extracted shared recursive file walking into `src/shared/file-walk.ts`
- updated `src/context/index.ts` and `src/tools/builtins.ts` to use the shared file walker
- updated `src/agent/index.ts` and `src/verifier/index.ts` to use the shared JSON extractor
- split planner helpers into `src/planner/model.ts`, `parse.ts`, `artifacts.ts`, `prompts.ts`, `state.ts`, `recovery.ts`, and `utils.ts`
- moved planner execution orchestration and helpers into `src/planner/execute.ts`, `src/planner/execute-wave.ts`, `src/planner/execute-verify.ts`, and `src/planner/execute-subtask.ts`
- moved the planner runtime loop into `src/planner/loop.ts`
- moved planner request/state/result helpers into `src/planner/runtime.ts`
- kept `runPlanner()` exported from `src/planner/index.ts` while shrinking the old monolithic helper surface
- split the manual suite into `scripts/manual-suite/{providers,planner,agent,verifier,tui,helpers}.ts`
- reduced `scripts/test-examples.ts` to the suite entrypoint and case registration layer

Still pending after this pass:

- split `src/agent/index.ts` further than the shared-helper extraction

Update after the current pass:

- planner-view read model extraction is complete (`src/planner/view-model.ts`)
- planner timeline normalization and read-model API are complete
- planner manual-suite hotspot split is now complete (`scripts/manual-suite/planner-{graph,runtime,execution,recovery}.ts`)
- TUI split is complete: `src/tui/types.ts`, `src/tui/commands.ts`, `src/tui/paste.ts`, `src/tui/state.ts`, `src/tui/render.ts`, `src/tui/session-actions.ts`, and `src/tui/run-prompt.ts` now hold the shared TUI layers while `src/tui/agent-repl.ts` is a thin top-level loop
- verifier split is complete: `src/verifier/commands.ts`, `src/verifier/execute.ts`, and `src/verifier/analysis.ts` now own command resolution, shell execution, and failure analysis while `src/verifier/index.ts` stays the orchestration entrypoint
- the next structural priorities are now:
  1. split `src/agent/index.ts`
  2. then introduce `ToolProvider` before LSP/MCP work

## Goals

- keep behavior stable while reducing file-level complexity
- move repeated parsing and filesystem helpers into `src/shared`
- make planner, TUI, agent, and verifier changes easier to review in isolation
- preserve current manual-suite coverage while refactoring

## Non-Goals

- no feature changes as part of the initial split
- no rewrites of the planner protocol or session artifact formats
- no movement of generated output under `dist/`

## Current Hotspots

The current repository layout is directionally good, but these files are carrying multiple sub-systems at once:

- `src/planner/index.ts`: public `runPlanner()` entrypoint plus planner session setup and runtime/bootstrap wiring
- `src/tui/agent-repl.ts`: slash-command parsing, REPL loop, run/plan/execute dispatch, live refresh, rendering, planner inspection, and child-session navigation
- `src/agent/index.ts`: agent loop, request building, patch preview/apply flow, verifier integration, and rollback helper
- `src/verifier/index.ts`: command resolution, verifier execution, and LLM-based verifier-failure analysis

The first shared-utility cleanup is already done, but these larger runtime files still need follow-up splits.

## Target Shape

### Shared utilities first

This phase is now complete and should stay the baseline for later cleanup.

- `src/shared/json-response.ts`: fenced-JSON extraction, balanced-object extraction, parseability checks
- `src/shared/file-walk.ts`: recursive file walking with shared exclude-pattern handling

This keeps later planner/agent/verifier/TUI splits smaller and reduces copy-paste drift.

### Planner split

Keep `src/planner/index.ts` as the public entrypoint for `runPlanner()`, but move most implementation details out.

Suggested internal layout:

- `src/planner/loop.ts`: top-level planning loop and result mapping
- `src/planner/model.ts`: planner request building and system prompt construction
- `src/planner/parse.ts`: planner response parsing and plan/step normalization
- `src/planner/artifacts.ts`: planner session load/write helpers, event/log appenders, context packet creation
- `src/planner/execute.ts`: top-level planner execution orchestration
- `src/planner/execute-wave.ts`: ready-step selection, wave execution, and blocked-dependent propagation
- `src/planner/execute-subtask.ts`: subagent launch, retry/fallback handling, and local replan handoff
- `src/planner/execute-verify.ts`: verify-step execution and verify-repair handoff
- `src/planner/recovery.ts`: retry/fallback/local-replan logic for failed subtasks
- `src/planner/prompts.ts`: subtask, verify-repair, and node-replan prompts

The existing `graph.ts`, `locks.ts`, and `types.ts` should remain as stable focused modules.

### TUI split

Keep a thin top-level launcher, but separate command, state-refresh, and rendering concerns.

Suggested internal layout:

- `src/tui/commands.ts`: `applyTuiCommand()` and command-target resolution
- `src/tui/session-actions.ts`: planner resume/follow/inspect/open-child actions
- `src/tui/run-prompt.ts`: run/plan/execute dispatch
- `src/tui/render.ts`: screen rendering and summaries
- `src/tui/paste.ts`: multiline paste collection and patch confirmation helpers
- `src/tui/state.ts`: session refresh, planner-view loading, and derived state hydration

Current status:

- done: `src/tui/types.ts`, `src/tui/commands.ts`, `src/tui/paste.ts`, `src/tui/session-actions.ts`, `src/tui/run-prompt.ts`, `src/tui/render.ts`, `src/tui/state.ts`

`planner-view.ts` and `planner-live.ts` already point in the right direction and should stay separate.

### Agent and verifier follow-up split

Once shared JSON parsing exists, split the agent and verifier along the same lines.

- `src/verifier/commands.ts`: command resolution
- `src/verifier/execute.ts`: command execution and failure aggregation
- `src/verifier/analysis.ts`: verifier-failure prompt building and response parsing
- `src/agent/model.ts`: agent request/system prompt
- `src/agent/parse.ts`: model-step parsing
- `src/agent/runtime.ts`: patch/apply/verify loop
- optional: `src/agent/messages.ts` for user-facing failure/help text

This phase is lower priority than planner and TUI because the files are smaller, but the shared-helper extraction should happen early.

Current status:

- done: `src/verifier/commands.ts`, `src/verifier/execute.ts`, `src/verifier/analysis.ts`
- pending: `src/agent/model.ts`, `src/agent/parse.ts`, `src/agent/runtime.ts` and optional `src/agent/messages.ts`

### Manual suite split

This phase is now complete. The suite is split by domain and the planner scenarios are further split by graph/runtime/execution/recovery responsibilities.

- `scripts/test-examples.ts`: suite entrypoint and case registration only
- `scripts/manual-suite/providers.ts`: stub providers and test doubles
- `scripts/manual-suite/planner.ts`: planner and planner-execute scenarios
- `scripts/manual-suite/agent.ts`: agent and patch-flow scenarios
- `scripts/manual-suite/verifier.ts`: verifier and discovery scenarios
- `scripts/manual-suite/tui.ts`: TUI parsing and session inspection scenarios
- `scripts/manual-suite/helpers.ts`: fixture copy helpers and config factories
- `scripts/manual-suite/planner-graph.ts`: graph, validation, and conflict-domain scenarios
- `scripts/manual-suite/planner-runtime.ts`: runtime, resume, and model-retry scenarios
- `scripts/manual-suite/planner-execution.ts`: execute-chain, rolling-planning, degraded, and feedback scenarios
- `scripts/manual-suite/planner-recovery.ts`: retry/fallback/local-replan/blocking scenarios
- `scripts/manual-suite/planner-shared.ts`: shared imports/helpers for planner suite files

## Rollout Order

1. Split TUI command, action, state-refresh, and render layers.
2. Split verifier helpers further on top of the new shared primitives.
3. Split agent helpers once verifier and planner boundaries are stable.
4. Introduce `ToolProvider` before real LSP/MCP provider work.

This order keeps the highest-risk runtime path first, lands the biggest reviewability wins early, and leaves broad test-fixture churn for last.

## Verification By Phase

Use the existing suite as the guardrail for each phase.

- any shared-helper, agent, or context/tool split: `npm run build` and `npm run smoke:edit`
- verifier-related split: `npm run build` and `npm run smoke:verifier`
- planner, TUI, session, or execution-flow split: `npm run build` and `npm run test:examples`
- large planner-execute changes or release validation: `npm run check:planner:execute` when a real model is available

`examples/manual-test-suite/README.md` documents which deterministic scenarios cover planner graphs, locks, retry/fallback, TUI command parsing, verifier discovery, rollback, and patch behavior. Use it as the checklist when moving files around.

## Success Criteria

- `src/planner/index.ts` becomes a thin entrypoint instead of the full planner subsystem
- planner execution logic is split across focused execution modules instead of collecting in one replacement hotspot
- `src/tui/agent-repl.ts` stops owning command parsing, rendering, planner inspection, and state refresh at the same time
- `src/verifier/index.ts` stops owning command resolution, command execution, and LLM analysis together
- agent, planner, and verifier all use one shared JSON-response parser
- context-building and tool file walking share one implementation
- the manual suite still covers planner execute, TUI, verifier, patch, rollback, and policy behavior after each phase
