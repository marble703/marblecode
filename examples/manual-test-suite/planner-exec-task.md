# Planner Execute Real-Model Check Task

Use this task when manually validating the default `planner -> subagent -> verifier` workflow with a real model.

## Prompt

```text
为 examples/manual-test-suite/project 生成一次“修复 src/math.js 中 add 函数错误并通过 verify”的结构化计划。请给出最小修复所需的检查、代码修复、测试、verify 步骤，只聚焦这个问题。
```

## Suggested Files

- `src/math.js`
- `tests/check-math.js`
- `package.json`
- `.marblecode/verifier.md`

## Manual Command

```bash
npm run check:planner:execute
```

This real-model execution check asserts:

- planner finishes with `DONE`
- at least one subtask agent run is recorded
- execution graph and lock artifacts are written for the resulting planner session
- final verifier step succeeds
- `src/math.js` is repaired to `return a + b;`
- `show:planner` can render the resulting session
