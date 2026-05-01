# Documentation Index

This repository now separates user/runtime documentation from planning and evolution documents.

## Project Docs

- `docs/project/architecture.md`: current architecture overview and runtime module map
- `docs/project/architecture_ZH-CN.md`: Chinese architecture overview
- `docs/project/testing.md`: testing commands, manual-suite groups, and regression guidance
- `docs/project/tui.md`: TUI command reference and usage notes
- `docs/project/planner-parallel-graph.zh-CN.md`: planner execute graph, waves, conflicts, locks, rolling planning, and feedback behavior

## Planning Docs

- `docs/plans/planner-runtime-refactor.zh-CN.md`: current planner runtime refactor plan and execution priorities

## Maintenance Notes

- When a planning document becomes fully completed, archive or remove it instead of leaving stale future-tense content in the main docs tree.
- Prefer updating `docs/project/*` for behavior that users or contributors rely on today.
- Prefer updating `docs/plans/*` for staged implementation plans, refactor sequences, and evolution tracking.
