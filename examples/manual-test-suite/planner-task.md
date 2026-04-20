# Planner Real-Model Check Task

Use this task when manually validating the read-only planner with a real model.

## Prompt

```text
为 examples/manual-test-suite/project 规划一次“重构路由模块并补测试”的执行步骤。请严格给出 5 个步骤，并覆盖：查找 router 相关文件、修改路由逻辑、更新导出或调用方、更新测试、执行 verify。不要修改任何文件。
```

## Suggested Files

- `src/router.js`
- `src/register-routes.js`
- `src/server.js`
- `tests/check-math.js`

## Manual Command

```bash
npm run check:planner
```

This real-model check asserts structure only:

- planner finishes successfully
- `plan.json`, `plan.state.json`, `plan.events.jsonl`, and `planner.log.jsonl` exist
- the generated plan contains at least 5 steps
- the plan includes search/test/verify coverage
- no patch artifact is written in planner mode
