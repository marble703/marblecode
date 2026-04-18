# Manual Example Test Suite

This example project exists to exercise the coding-agent host without relying on any live model output.

Run it manually with:

```bash
npm run test:examples
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
- `run_shell` executes `pwd`, `ls`, and `grep`
- policy blocks sensitive file reads and forbidden shell commands
- a deterministic provider generates a patch and the host applies it
- verifier runs project tests after patch application
- patch generation can be rejected before apply
- rollback restores files after a successful apply
- verifier failures return structured stderr output for syntax errors
- verifier-failure analysis can classify a failing manual verifier as a verifier problem

## Fixture Layout

- `project/`: copied into a temporary workspace for each scenario
- `.marblecode/verifier.md`: project verifier definition used by the suite
- `src/math.js`: intentionally buggy source file fixed by the patch scenario
- `src/broken-syntax.js`: intentionally invalid JavaScript for verifier failure testing
- `tests/check-math.js`: deterministic test runner with process exit assertions
