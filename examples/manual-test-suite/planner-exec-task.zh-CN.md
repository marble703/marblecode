# Planner Execute 真实模型检查任务

在使用真实模型手动验证默认 `planner -> subagent -> verifier` 工作流时使用此任务。

## Prompt

```text
为 examples/manual-test-suite/project 生成一次"修复 src/math.js 中 add 函数错误并通过 verify"的结构化计划。请给出最小修复所需的检查、代码修复、测试、verify 步骤，只聚焦这个问题。
```

## 建议文件

- `src/math.js`
- `tests/check-math.js`
- `package.json`
- `.marblecode/verifier.md`

## 手动命令

```bash
npm run check:planner:execute
```

此真实模型执行检查断言：

- planner 以 `DONE` 结束
- 至少记录了一次子任务 agent 运行
- 相应 planner session 写入了执行图和锁 artifact
- 相应 planner session 记录了 `show:planner` 可渲染的执行 wave
- 最终 verifier 步骤成功
- `src/math.js` 被修复为 `return a + b;`
- `show:planner` 可渲染相应 session
