# Planner 真实模型检查任务

在使用真实模型手动验证只读 planner 时使用此任务。

## Prompt

```text
为 examples/manual-test-suite/project 规划一次"重构路由模块并补测试"的执行步骤。请严格给出 5 个步骤，并覆盖：查找 router 相关文件、修改路由逻辑、更新导出或调用方、更新测试、执行 verify。不要修改任何文件。
```

## 建议文件

- `src/router.js`
- `src/register-routes.js`
- `src/server.js`
- `tests/router.test.txt`

## 手动命令

```bash
npm run check:planner
```

此真实模型检查仅断言结构：

- planner 成功完成
- `plan.json`、`plan.state.json`、`plan.events.jsonl` 和 `planner.log.jsonl` 存在
- 生成的 plan 至少包含 5 个步骤
- plan 包含 search/test/verify 覆盖
- planner 模式下不写入 patch artifact
