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
- kept `runPlanner()` exported from `src/planner/index.ts` while shrinking the old monolithic helper surface

Still pending after this pass:

- move the planner execution/runtime loop out of `src/planner/index.ts`
- split `src/tui/agent-repl.ts`
- split `src/verifier/index.ts` into command resolution, execution, and analysis helpers
- split `src/agent/index.ts` further than the shared-helper extraction
- split `scripts/test-examples.ts`

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

- `src/planner/index.ts`: public `runPlanner()` entrypoint plus the remaining planner session setup, model fallback handling, execution orchestration, wave scheduling, verify execution, and retry/fallback/replan recovery
- `src/tui/agent-repl.ts`: slash-command parsing, REPL loop, run/plan/execute dispatch, live refresh, rendering, planner inspection, and child-session navigation
- `src/agent/index.ts`: agent loop, request building, patch preview/apply flow, verifier integration, and rollback helper
- `src/verifier/index.ts`: command resolution, verifier execution, and LLM-based verifier-failure analysis
- `scripts/test-examples.ts`: provider stubs, case registry, most fixture scenarios, and suite helpers all live in one file

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

### Manual suite split

Leave `scripts/test-examples.ts` for last so production refactors land first. When it is time, split by domain instead of by assertion style.

- `scripts/test-examples.ts`: suite entrypoint and case registration only
- `scripts/manual-suite/providers.ts`: stub providers and test doubles
- `scripts/manual-suite/planner.ts`: planner and planner-execute scenarios
- `scripts/manual-suite/agent.ts`: agent and patch-flow scenarios
- `scripts/manual-suite/verifier.ts`: verifier and discovery scenarios
- `scripts/manual-suite/tui.ts`: TUI parsing and session inspection scenarios
- `scripts/manual-suite/helpers.ts`: fixture copy helpers and config factories

## Rollout Order

1. Continue splitting planner execution orchestration while keeping `runPlanner()` exported from `src/planner/index.ts`.
2. Split TUI command, action, state-refresh, and render layers.
3. Split verifier helpers further on top of the new shared primitives.
4. Split agent helpers once verifier and planner boundaries are stable.
5. Split the manual suite after production modules are stable.

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
