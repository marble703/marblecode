# Planner Execute Real-Model Check Task

Use this task when manually validating the serial `planner -> subagent -> verifier` workflow with a real model.

## Prompt

```text
为 examples/manual-test-suite/project 执行一次“修复 src/math.js 中 add 函数错误并通过 verify”的完整 planner 流程。先生成结构化计划，再按顺序执行子任务，直到 verifier 通过并正常结束。请保持修改最小，只修复这个问题。
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
- final verifier step succeeds
- `src/math.js` is repaired to `return a + b;`
- `show:planner` can render the resulting session
