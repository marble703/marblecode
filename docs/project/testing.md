# Testing Guide

This repository uses a small set of targeted commands instead of a large unit-test framework. The most important regression safety net is the deterministic manual suite under `scripts/manual-suite/` and `examples/manual-test-suite/`.

## Commands

- `npm run build`: compile the TypeScript project
- `npm run smoke:edit`: no-network patch/apply smoke test
- `npm run smoke:verifier`: verifier smoke test against `examples/verifier-fixture`
- `npm run test:examples`: full deterministic manual suite
- `npm run check:planner`: real-model planner check against `examples/manual-test-suite/planner-task.md`
- `npm run check:planner:execute`: real-model planner execute chain against `examples/manual-test-suite/planner-exec-task.md`

## Test Layers

### Build

`npm run build` is the baseline check for every code change.

### Smoke Tests

- `smoke:edit` validates the patch-driven edit path without external model access.
- `smoke:verifier` validates verifier command resolution and execution against the verifier fixture.

### Deterministic Manual Suite

`npm run test:examples` runs the host/runtime regression suite without relying on live model output.

It is the primary safety net for:

- planner graph and execution changes
- patch/apply/rollback changes
- verifier changes
- TUI and planner-view changes
- policy and tool boundary changes

### Real-Model Checks

- `check:planner` validates the read-only planner loop with a real configured planning model.
- `check:planner:execute` validates the full `planner -> subagent -> verifier` chain with a real model.

These are not required for every edit, but they are useful for release validation and larger planner/runtime changes.

## Manual Suite Groups

### Core

Files:

- `scripts/manual-suite/core.ts`

Purpose:

- built-in tool behavior
- policy boundaries
- context selection behavior
- git read-only tool behavior

Representative cases:

- `tool read/list/search`
- `automatic context selection`
- `git read only tools`
- `shell tools`
- `auto deny with explicit grant`
- `policy blocks`

### Planner Graph

Files:

- `scripts/manual-suite/planner-graph.ts`

Purpose:

- pure graph and lock helpers
- conflict-domain behavior
- append/replan validation
- affected-subgraph and feedback helper logic

Representative cases:

- `planner graph and waves`
- `planner graph fallback readiness`
- `planner execution locks`
- `planner execution strategies`
- `planner conflict domains`
- `planner replan proposal validation`
- `planner plan append validation`
- `planner replan lock compatibility`

### Planner Runtime

Files:

- `scripts/manual-suite/planner-runtime.ts`

Purpose:

- planner loop helpers
- execution state machine transitions
- event dispatch artifacts
- planner resume behavior
- planner model retry behavior

Representative cases:

- `planner execution state machine transitions`
- `planner execution event dispatch`
- `planner invalid retry and resume`
- `planner resume classifier favors active wave`
- `planner execute resume from artifacts`
- `planner model retry`
- `planner model retry exhaustion`

### Planner Execution

Files:

- `scripts/manual-suite/planner-execution.ts`

Purpose:

- end-to-end planner execute behavior
- concurrent waves
- conflict policy
- rolling append
- degraded execution
- execution feedback artifacts

Representative cases:

- `planner execute chain`
- `planner execute concurrent wave`
- `planner execute rolling window append`
- `planner execute conflict policy fail`
- `planner execute conflict domain fail`
- `planner execute degraded optional docs`
- `planner execute feedback writes undeclared changes`
- `planner execute undeclared changes trigger replan`

### Planner Recovery

Files:

- `scripts/manual-suite/planner-recovery.ts`

Purpose:

- retry, fallback model, graph fallback, local replan, blocked dependents

Representative cases:

- `planner execute retry recovery`
- `planner execute fallback model`
- `planner execute graph fallback`
- `planner execute local replan`
- `planner execute rejects invalid local replan`
- `planner execute rejects lock-incompatible local replan`
- `planner execute blocked dependents`

### TUI And Read Model

Files:

- `scripts/manual-suite/tui.ts`

Purpose:

- TUI command parsing
- recent session summaries
- planner view artifact tolerance
- read-model APIs for planner sessions

Representative cases:

- `interactive tui command parsing`
- `interactive tui command errors`
- `planner view tolerates partial artifacts`
- `planner view loads delta and feedback artifacts`
- `planner read-model api exposes raw and normalized events`
- `planner session summary includes execution metadata`

### Agent And Patch

Files:

- `scripts/manual-suite/agent.ts`

Purpose:

- patch apply/reject behavior
- write-scope restrictions
- rollback
- agent model retry
- verifier integration in the normal agent loop

Representative cases:

- `patch apply and verifier`
- `restricted write scope blocks extra file`
- `multi-file patch apply`
- `patch rejection`
- `patch baseline drift`
- `rollback restore`

### Verifier

Files:

- `scripts/manual-suite/verifier.ts`

Purpose:

- verifier command source resolution
- auto discovery
- verifier failure output and analysis

Representative cases:

- `verifier auto discovery`
- `verifier manual override takes priority`
- `verifier disabled skips execution`
- `verifier syntax error output`
- `verifier failure analysis`

## When To Run Which

- planner graph, planner execute, planner resume, planner artifacts, or TUI/read-model changes:
  - `npm run build`
  - `npm run test:examples`
- patch/apply/rollback changes:
  - `npm run build`
  - `npm run smoke:edit`
  - `npm run test:examples`
- verifier changes:
  - `npm run build`
  - `npm run smoke:verifier`
  - `npm run test:examples`
- release validation or major planner changes:
  - `npm run build`
  - `npm run test:examples`
  - `npm run check:planner`
  - `npm run check:planner:execute`

## Maintenance Notes

- Prefer strengthening weak test cases over adding nearby duplicates.
- Keep deterministic helper/graph tests when they isolate behavior better than end-to-end execute cases.
- If a test name claims to validate a planner replan or feedback path, ensure it asserts the relevant event or artifact rather than only checking a generic success outcome.
