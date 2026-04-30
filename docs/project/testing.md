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
- planner resume and recovery-path changes
- patch/apply/rollback changes
- verifier changes
- TUI and planner-view changes
- policy and tool boundary changes
- tool provider and registry changes

For the current planner roadmap, any change to resume logic should keep `npm run build` green and add or update deterministic manual-suite coverage for the affected recovery rule or boundary. Resume work is not considered complete if it only updates artifacts or view-model projection without a runtime-level case. This now also applies to execution-state field-boundary changes: if persisted truth, runtime-derived summaries, or runtime cursor helpers move, the suite should keep direct helper coverage instead of relying only on end-to-end resume cases.

### Real-Model Checks

- `check:planner` validates the read-only planner loop with a real configured planning model.
- `check:planner:execute` validates the full `planner -> subagent -> verifier` chain with a real model.

These are not required for every edit, but they are useful for release validation and larger planner/runtime changes.

## Manual Suite Groups

### Core

Files:

- `scripts/manual-suite/core.ts`
- `scripts/manual-suite/core-tools.ts`
- `scripts/manual-suite/core-providers.ts`
- `scripts/manual-suite/core-local-providers.ts`

Purpose:

- built-in tool behavior
- provider-backed tool registration behavior
- provider lifecycle and readonly capability boundaries
- policy boundaries
- context selection behavior
- git read-only tool behavior

Representative cases:

- `tool read/list/search`
- `tool provider registry`
- `tool provider lifecycle`
- `tool provider duplicate id`
- `readonly diagnostics provider`
- `external readonly provider gate blocks by default`
- `external readonly provider gate allows allowlisted provider`
- `tool provider dispose failure reports provider id`
- `tool provider summary helper`
- `external readonly provider gate reports access reason`
- `tool provider dispose summary`
- `tool log includes provider metadata`
- `tool log helper includes provider metadata`
- `tool log helper includes capability source fields`
- `local artifact helper returns missing`
- `local artifact helper rejects workspace escape`
- `jsonl helper reads records`
- `jsonl helper asserts matching record`
- `local diagnostics provider reads artifact`
- `local diagnostics provider filters path and severity`
- `local diagnostics provider returns empty when missing`
- `local diagnostics provider rejects workspace escape`
- `local symbols provider reads artifact`
- `local symbols provider filters path name and kind`
- `local symbols provider returns empty when missing`
- `local symbols provider rejects invalid format`
- `local symbols provider rejects workspace escape`
- `tool log sanitizes local symbols source`
- `local references provider reads artifact`
- `local references provider filters path symbol and kind`
- `local references provider returns empty when missing`
- `local references provider rejects invalid format`
- `local references provider rejects workspace escape`
- `local references provider rejects target workspace escape`
- `tool log sanitizes local references source`
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
- `scripts/manual-suite/planner-runtime-core.ts`
- `scripts/manual-suite/planner-runtime-resume.ts`

Purpose:

- planner loop helpers
- execution state machine transitions
- event dispatch artifacts
- planner resume behavior
- recovery snapshot initialization helpers
- recovery lock-strategy metadata
- recovery lock-owner outcome metadata
- recovery boundary and planning-window resume behavior
- planner model retry behavior
- planner artifact / session fixture helpers for resume and partial-window tests
- structured planner event / planner log / tool log assertions for representative runtime and recovery cases

Representative cases:

- `planner execution state machine transitions`
- `planner execution event dispatch`
- `planner execution snapshot builder`
- `planner persisted recovery snapshot helper`
- `planner runtime cursor helpers`
- `planner initial execution state extras helper`
- `planner invalid retry and resume`
- `planner resume classifier favors active wave`
- `planner runtime recovery context helper`
- `planner execute resume from artifacts`
- `planner resume recovers fallback path`
- `planner resume reuses eligible lock owners`
- `planner resume drops ineligible active writers`
- `planner resume interrupted planning window reruns active wave`
- `planner resume interrupted planning window recovers fallback path`
- `planner resume completed planning window does not rerun`
- `planner model retry`
- `planner model retry exhaustion`

The runtime/resume group now also uses shared planner fixture helpers from `scripts/manual-suite/helpers.ts` for representative `plan.json`, `plan.state.json`, `execution.state.json`, `execution.locks.json`, and `plan.events.jsonl` setup. Prefer extending those helpers instead of adding new large inline artifact blobs when new planner resume or partial-window cases are added.

When asserting planner/runtime artifacts, prefer `assertPlannerEvent(...)`, `assertPlannerLogEntry(...)`, and `assertToolLogEntry(...)` over raw string regex checks on JSONL content. The suite still has a few intentionally narrow string assertions, but new coverage should default to parsed record checks.

At the moment, `npm run test:examples` covers 121 deterministic cases.

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
- `planner execute feedback records changed files`

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
- recovery metadata projection for planner sessions

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
