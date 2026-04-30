# 手动示例测试套件

本示例项目用于在不依赖任何真实模型输出的情况下验证 coding-agent host。

手动运行：

```bash
npm run test:examples
```

运行真实模型 planner 检查：

```bash
npm run check:planner
```

运行真实模型 planner 执行链：

```bash
npm run check:planner:execute
```

在终端中查看最近的 planner session：

```bash
npm run show:planner -- --workspace examples/manual-test-suite/project --last
```

不要在日常 verifier 中自动运行本套件。它适用于：

- 重要的 agent-loop 变更
- patch 或 rollback 变更
- verifier 变更
- 发布前验证

本套件自动断言所有结果，不使用 AI 判断正确性。

当前确定性套件覆盖 84 个用例，分布在以下分组：

- 核心工具、context 和 policy
- planner graph、runtime、execution 和 recovery
- TUI 和 planner read-model 行为
- agent patch/apply/rollback 流程
- verifier 解析和分析

详细的分组、命令及运行时机说明，参见 `docs/project/testing.md`。

## 覆盖场景

- `read_file` 返回预期的文件内容
- `list_files` 按 glob 模式过滤 fixture 文件
- `search_text` 执行正则匹配并返回行/列位置
- 只读 git helper 工具在 workspace 是 git 仓库时，暴露仓库状态、历史、show 和 base diff 信息
- `run_shell` 执行 `pwd`、`ls` 和 `grep`
- policy 阻止读取敏感文件和执行被禁止的 shell 命令
- 显式授权可覆盖 `context.autoDeny`，允许已批准的 workspace 内文件和只读的 workspace 外文件
- 当未提供 `--file` 时，自动 context 选择对路由相关文件进行排序
- planner 模式创建只读计划、记录计划事件、重试无效的 patch-like 输出、支持模型重试，并支持基本的 resume/replan
- planner 模式同时写入 `planner.log.jsonl`，仓库中包含 `planner-task.md` 用于真实模型 planner 验证
- planner 执行模式由 `planner-exec-task.md` 覆盖，验证串行子任务执行直至 verifier 成功
- planner 执行同时记录确定性的执行图和锁 artifact，使恢复和未来的并发规则保持可检查
- planner 执行现在覆盖保守的 wave 调度和冲突策略行为，之后才默认信任真实的并发子任务工作
- planner 执行模式也覆盖节点级重试、fallback 模型选择和局部 replan 后再判定 session 失败
- 交互式 TUI 命令解析覆盖模式切换、`/workspace`、`/files`、`/verify`、`/yes`、`/open` 和 `/reset`
- verifier 自动发现在缺少 `.marblecode/verifier.md` 时降级到 package 的 `test`/`build` 脚本
- 确定性 provider 生成 patch，host 负责应用
- 多文件 patch 应用在一次响应中同时操作源文件和 fixture 笔记
- verifier 在 patch 应用后运行项目测试
- patch 生成可以在 apply 前被拒绝
- rollback 在成功 apply 后恢复文件
- verifier 失败返回包含语法错误的结构化 stderr 输出
- verifier 失败分析可将失败的手动 verifier 归类为 verifier 问题
- agent 和 planner 模型重试覆盖恢复和重试耗尽两种场景
- planner execute 测试也覆盖确定性节点重试、fallback 和局部 replan 恢复路径
- planner graph、wave 计算、执行锁和限制性写范围强制执行均以确定性方式覆盖
- planner execute 测试还覆盖不相交文件范围的同 wave 并发和 fail-fast 冲突策略行为
- planner runtime 测试覆盖执行状态元数据、持久化恢复快照 helper、active-wave resume 行为、受保护 owner 复用、无关 writer 丢弃、中断/完成的 planning-window resume 边界、部分窗口内的 fallback-path resume 以及恢复期间锁的保留

## 配套手动检查

- `npm run check:planner`：针对 `planner-task.md` 的真实模型只读 planner 验证
- `npm run check:planner:execute`：针对 `planner-exec-task.md` 的真实模型串行 `planner -> subagent -> verifier` 验证
- `npm run show:planner -- --workspace examples/manual-test-suite/project --last`：在终端中查看已记录的 planner session；此命令是手动查看器，不会被 `npm run test:examples` 执行

## 重构安全网

在拆分大型 runtime 文件时，请将本套件作为回归对照表。

- planner graph、lock、retry、fallback、local replan 和 execute-wave 重构应保持 planner-execute 场景通过
- TUI 命令或 planner-view 重构应保持交互式命令解析和 recent-session 场景通过
- agent、patch、rollback 或 verifier 重构应保持确定性 patch-apply、rollback、verifier-output 和 verifier-analysis 场景通过
- 将本套件作为结构性清理和 planner-runtime 重构的主要确定性安全网

## Fixture 布局

- `project/`：为每个场景复制到临时 workspace
- `project/.marblecode/verifier.md`：套件使用的项目 verifier 定义
- `project/src/math.js`：patch 场景修复的有意错误源文件
- `project/src/router.js`、`project/src/register-routes.js`、`project/src/server.js`：context 选择和 planner 检查使用的路由相关文件
- `project/src/notes.txt`：多文件 patch 场景使用的 fixture 笔记文件
- `project/src/broken-syntax.js`：用于 verifier 失败测试的有意无效 JavaScript
- `project/tests/check-math.js`：带进程退出断言的确定性测试运行器
- `project/tests/router.test.txt`：用作 planner/context 线索文本的路由相关测试笔记
