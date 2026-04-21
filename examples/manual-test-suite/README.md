# Manual Example Test Suite

This example project exists to exercise the coding-agent host without relying on any live model output.

Run it manually with:

```bash
npm run test:examples
```

Run the real-model planner check with:

```bash
npm run check:planner
```

Run the real-model planner execution chain with:

```bash
npm run check:planner:execute
```

Inspect the latest planner session in the terminal with:

```bash
npm run show:planner -- --workspace examples/manual-test-suite/project --last
```

Do not run this suite as part of the default verifier on every change. It is intended for:

- major agent-loop changes
- patch or rollback changes
- verifier changes
- release validation

The suite automatically asserts all results without using AI to judge correctness.

## Covered Scenarios

- `read_file` returns expected file contents
- `list_files` filters fixture files by glob pattern
- `search_text` performs regex matching and returns line/column locations
- read-only git helpers expose repository status, history, show, and base diff information when the workspace is a git repo
- `run_shell` executes `pwd`, `ls`, and `grep`
- policy blocks sensitive file reads and forbidden shell commands
- explicit grants can override `context.autoDeny` for approved in-workspace and read-only out-of-workspace files
- automatic context selection ranks route-related files when no `--file` is given
- planner mode creates read-only plans, logs plan events, retries invalid patch-like output, supports model retries, and supports basic resume/replan
- planner mode also writes `planner.log.jsonl`, and the repo includes `planner-task.md` for real-model planner validation
- planner execution mode is covered by `planner-exec-task.md`, which validates serial subtask execution until verifier success
- planner execution also records deterministic execution graph and lock artifacts so recovery and future concurrency rules stay inspectable
- planner execution mode also covers node-level retry, fallback model selection, and local replanning before the session is considered failed
- interactive TUI command parsing covers mode switching, `/workspace`, `/files`, `/verify`, `/yes`, `/open`, and `/reset`
- verifier auto-discovery falls back to package `test`/`build` scripts when `.marblecode/verifier.md` is missing
- a deterministic provider generates a patch and the host applies it
- multi-file patch application works across source and fixture notes in one response
- verifier runs project tests after patch application
- patch generation can be rejected before apply
- rollback restores files after a successful apply
- verifier failures return structured stderr output for syntax errors
- verifier-failure analysis can classify a failing manual verifier as a verifier problem
- agent and planner model retries are covered for both recovery and retry exhaustion
- planner execute tests also cover deterministic node retry, fallback, and local replan recovery paths
- planner graph, wave calculation, execution locks, and restrictive write-scope enforcement are covered deterministically

## Companion Manual Checks

- `npm run check:planner`: real-model read-only planner validation against `planner-task.md`
- `npm run check:planner:execute`: real-model serial `planner -> subagent -> verifier` validation against `planner-exec-task.md`
- `npm run show:planner -- --workspace examples/manual-test-suite/project --last`: inspect a recorded planner session in the terminal; this command is a manual viewer and is not executed by `npm run test:examples`

## Fixture Layout

- `project/`: copied into a temporary workspace for each scenario
- `project/.marblecode/verifier.md`: project verifier definition used by the suite
- `project/src/math.js`: intentionally buggy source file fixed by the patch scenario
- `project/src/router.js`, `project/src/register-routes.js`, `project/src/server.js`: route-related files used by context selection and planner checks
- `project/src/notes.txt`: fixture notes file used by the multi-file patch scenario
- `project/src/broken-syntax.js`: intentionally invalid JavaScript for verifier failure testing
- `project/tests/check-math.js`: deterministic test runner with process exit assertions
- `project/tests/router.test.txt`: route-related test note used as planner/context clue text
