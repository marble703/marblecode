# Coding Agent Core

## 介绍

本项目的目标是构建一个高度模块化，可定制的 coding agent 框架，可生成图结构计划并执行，权限和安全策略可控，上下文构建和工具集成。

## 当前状态

当前仓库已经不是纯骨架，而是一个可运行的本地 coding-agent runtime，支持 patch 驱动改码、只读 planner 与 planner execute、共享 verifier、回滚，以及终端检查/TUI 工具。

- 支持 CLI 入口
- 支持配置加载
- 支持项目级 `.marblecode/` 配置加载
- 支持 OpenAI-compatible Provider
- 底层使用传统 `POST /chat/completions`
- 支持静态规则路由
- 支持上下文构建
- 支持粘贴代码片段和关键词检索上下文
- 支持工具注册和调用
- 支持 provider 驱动的 agent loop、planner loop 和 planner execute 流程
- 支持结构化 Patch 预览、应用、回滚信息生成
- 支持替换/删除前自动备份原文件
- 支持路径和 Shell 策略控制
- 支持 verifier 执行，以及 manual/config/markdown/discovery 多来源命令解析与失败分析
- 支持本地 Session 日志和自动清理
- 支持 planner session 摘要、终端查看器和交互式 TUI
- planner、TUI、verifier、agent 内部 runtime 已完成按模块拆分
- 支持模型连通性检查脚本
- 支持一次本地 smoke test，验证 Patch 驱动改码闭环

## 当前能力

- 以单 Agent 方式执行有限步数的编码任务
- 以只读 planner 模式搜索代码并输出结构化计划，不直接写文件
- 根据任务类型在 `cheap`、`code`、`strong` 模型档位之间切换
- 从显式文件和最近修改文件中构建有限上下文
- 支持通过 `--paste` 注入类似 `[Pasted ~3 lines #1]` 的粘贴上下文
- 在未提供 `--file` 时，支持基础关键词检索召回相关文件
- 默认排除敏感文件
- 提供 `read_file`、`list_files`、`search_text`、`run_shell`、`git_diff` 工具
- 模型不直接写文件，只输出结构化 Patch
- Patch 默认人工确认，可用 `--yes` 跳过
- Patch 替换或删除文件前会自动备份原文件
- 支持一键回滚最近一次或指定 session 的改动
- Patch 应用后可执行 verifier
- verifier 可从 `.marblecode/verifier.md` 解析
- 支持通过 `--verify` 临时覆盖本次 verifier
- 将请求、上下文、模型输出、工具调用、Patch、验证结果记录到本地 session
- 可通过 `show:planner`、`tui:planner` 和交互式 TUI 检查 planner session
- 可在 TUI 中恢复 planner session、检查单个 step，并打开子 coder session
- planner execute 已支持 execution wave、文件锁 artifact、fallback edge、bounded local replan、rolling append window 和 execution feedback artifact

## 当前限制

- 目前只实现了 OpenAI-compatible Chat Completions Provider
- 还没有 GUI
- 还没有向量检索和 Embedding
- 还没有真正接入 Provider 原生 streaming UI
- 主循环还没有切到 Provider 原生 tool calling
- `replace_file` 当前按整文件替换处理

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 编辑本地配置

```bash
nano agent.config.jsonc
```

3. 设置 API Key

推荐方式是环境变量：

```bash
export OPENAI_API_KEY=your_key_here
```

为了兼容本地测试，当前实现也支持把 key 直接写在 `providers.openai.apiKeyEnv` 里，但这只是便捷模式，不是推荐的长期方案。

4. 构建项目

```bash
npm run build
```

5. 对一个不在 `src` 里的简单片段运行 coding 任务

```bash
node dist/index.js run "修复 add 函数，让它返回 a + b" --file examples/snippets/math.ts
```

只生成计划，不直接改文件：

```bash
node dist/index.js plan "重构路由模块并补测试"
```

先规划，再执行 subtask，直到 verifier 通过：

```bash
node dist/index.js plan "修复 src/math.js 中的 add 错误并通过 verify" --workspace examples/manual-test-suite/project --execute
```

带着新输入恢复 planner session：

```bash
node dist/index.js plan "保留现有导出结构" --session <session-id-or-path>
```

在终端里查看最近一次 planner 结果：

```bash
npm run show:planner -- --last
```

打开一个轻量的实时 planner TUI：

```bash
npm run tui:planner -- --last
```

打开一个可交互的新对话 TUI：

```bash
npm run tui
```

在另一个工作目录里打开 TUI：

```bash
node dist/index.js tui --workspace /path/to/project
```

跳过 Patch 确认：

```bash
node dist/index.js run "修复 add 函数，让它返回 a + b" --file examples/snippets/math.ts --yes
```

用粘贴代码直接运行：

```bash
node dist/index.js run "修复这个函数" --paste $'function add(a, b) {\n  return a - b;\n}'
```

临时覆盖本次 verifier：

```bash
node dist/index.js run "修复 add 函数" --file examples/snippets/math.ts --verify "npm run build"
```

6. 运行本地 smoke test

```bash
npm run smoke:edit
```

7. 检查模型是否可用

```bash
npm run check:model -- --model cheap
```

8. 一键回滚最近一次 session

```bash
node dist/index.js rollback --last
```

## 常用脚本

- `npm run build`：编译项目
- `npm run dev`：用 `tsx` 直接运行 CLI
- `npm run smoke:edit`：执行一个不依赖外部 API 的本地改码 smoke test
- `npm run smoke:verifier`：对 `examples/verifier-fixture` 运行现有 verifier 冒烟验证
- `npm run test:examples`：运行确定性的 manual suite，覆盖工具、自动上下文选择、planner 流程、TUI 命令解析、patch 应用/拒绝/回滚、verifier 行为、重试路径、shell 和权限检查
- `npm run check:model -- --model cheap`：检查当前配置下的模型、URL、Key 是否可用
- `npm run check:planner`：使用真实配置好的 planning model 在 `examples/manual-test-suite/planner-task.md` 上运行 planner 检查
- `npm run check:planner:execute`：在临时 manual suite workspace 上使用真实模型运行完整的 planner -> subagent -> verifier 链路
- `npm run show:planner -- --last`：在终端渲染 planner session 的计划摘要、事件时间线和当前子任务结果
- `npm run tui:planner -- --last`：打开一个轻量实时 planner 面板，轮询 session 文件并原地渲染步骤、subtask 和时间线
- `npm run tui`：打开一个可交互终端 UI，可直接发起新的 `run` / `plan` / `plan --execute` 对话
- `show:planner --last` 和 `tui:planner --last` 现在会自动选择最近一个 planner session，而不是误选到 coder/verifier 子 session

## 配置说明

- `agent.config.jsonc` 仍然负责本地运行时配置，比如 provider、model 和本地策略
- `.marblecode/config.jsonc` 是项目级共享配置入口
- `.marblecode/verifier.md` 是共享 verifier 设计的推荐位置
- 项目配置可以覆盖 `context`、`policy`、`routing`、`session`、`verifier` 等共享运行参数
- 项目配置也可以通过 `env` 注入项目级 shell 环境变量
- 如果没有手动 verifier、JSON verifier 命令列表或 `.marblecode/verifier.md`，verifier 会回退到基于仓库内容的自动发现
- 可以在 `run`、`plan`、`tui`、`rollback` 上加 `--workspace /path/to/project`，把 session 工作目录切到别的项目而不必移动主配置文件
- `context.autoDeny` 是一个类似 gitignore 的名单，用来禁止自动上下文选择、搜索或普通工具浏览去读这些文件
- 对于 `context.autoDeny` 里的文件，或工作目录外的只读文件，可以通过 `--file` 或 `/files` 显式授予访问
- `agent.config.jsonc` 是本地配置文件，已经加入 `.gitignore`
- `providers.openai.baseUrl` 填你的兼容接口地址
- 当前 MVP 同时接受 `http://...` 和 `https://...`
- `providers.openai.apiKeyEnv` 推荐填写环境变量名
- 当前实现也兼容把真实 key 直接写进去做本地测试
- 如果模型名不同，修改 `models.cheap.model`、`models.code.model`、`models.strong.model`

## 上下文选择

- `--file path/to/file.ts`：把指定文件加入上下文
- `--paste "..."`：把粘贴代码作为 `[Pasted ~N lines #k]` 上下文项注入
- 如果没有提供 `--file`，系统会从请求和粘贴片段里提取查询词，对候选文件打分，并自动挑选最多 4 个最可能相关的文件
- 显式传入的 `--file` 永远排在上下文前面，并且优先级高于自动召回结果
- 模型还会收到一个 `Context selection summary` 摘要块，说明查询词和自动选中的候选文件
- 最近修改文件也会作为兜底上下文来源
- 如果当前上下文还不够，模型应继续用 `search_text`、`list_files`、`read_file` 搜索后再改动

## Planner

- `node dist/index.js plan "..."` 默认进入只读 planner 循环
- 加上 `--execute` 后，host 会在 planner 产出有效计划后执行 code/test/verify 步骤；默认仍一次只跑一个 subtask
- 在 `--execute` 模式下，planner 继续使用 `planningModel`，而 code/test/repair 子任务会通过 coder subagent 使用 `codeModel`
- planner 模式只开放 `read_file`、`list_files`、`search_text`、`git_diff`
- planner 模式现在也开放只读 git 工具，例如 `git_status`、`git_log`、`git_show`、`git_diff_base`
- planner 响应只允许 `plan`、`plan_update`、`tool_call`、`final`
- planner 遇到非法模型输出会最多自动重试 3 次，之后把 session 标记为失败
- planner 和 agent 的模型调用也会对 `429 rate limit`、超时、短暂 `5xx` 这类瞬时错误做退避重试
- planner session 会落盘 `plan.json`、`plan.state.json`、`plan.events.jsonl`、`planner.request.json`、`planner.context.packet.json`
- planner execute 还会额外记录 `execution.graph.json`、`execution.state.json`、`execution.locks.json`，便于 host 和 TUI 解释执行波次、阻塞节点和文件所有权
- planner 还会写出 `planner.log.jsonl`，记录结构化 plan snapshot、非法输出重试和终态摘要
- 重试参数可放在 `session.modelRetryAttempts` 和 `session.modelRetryDelayMs`，默认是重试 3 次、基础等待 3 秒
- planner 支持通过 `--session` 或 `--last` 做基础恢复和 replan
- planner execute 现在会先根据 execution graph 划分执行波次；当 `maxConcurrentSubtasks > 1` 时，同一波次内 file scope 不冲突的写步骤可以并发执行
- planner execute 仍默认一次只跑一个 subtask，但现在会构建 execution graph、跟踪 ready/active/failed/blocked step 集合、管理文件锁，对失败的 code/test/docs 节点做重试，可切换到 fallback model，并在彻底失败前尝试局部 replan
- `routing` 现在支持 `maxConcurrentSubtasks`、`subtaskMaxAttempts`、`subtaskFallbackModel`、`subtaskReplanOnFailure`、`subtaskConflictPolicy`，让执行模型可以从保守串行扩展到安全的冲突感知并发
- `subtaskConflictPolicy=serial` 会把冲突写步骤延后到后续 wave；`subtaskConflictPolicy=fail` 会在 host 检测到 pending conflict edge 时直接终止执行
- `planner.context.packet.json` 是后续 planner/subagent 共享上下文的显式格式；当前先作为稳定 artifact 输出，便于调试和未来 TUI 使用
- 可用 `npm run show:planner -- --session <session-id-or-path>` 或 `--last` 在终端查看当前计划、事件时间线和已记录的 subtask 执行结果
- `show:planner` 现在会显示 step attempts、恢复状态、execution waves、文件锁、subtask 的 executor 身份、model alias、改动文件和子 agent session 路径，便于确认 planner -> coder 的真实调用链

## 交互式 TUI

- `npm run tui` 会打开一个简单的交互式终端会话，可直接输入新请求
- 启动时可加 `--workspace`，或在 TUI 里用 `/workspace <path>` 切换当前 session 工作目录
- 用 `/mode run`、`/mode plan`、`/mode execute` 切换编码、规划和 planner 执行模式
- 用 `/sessions` 刷新最近 session 列表，用 `/open <序号|session-id-or-path>` 在同一个 TUI 里查看之前的 session
- 用 `/resume [序号|session-id-or-path|last]` 恢复 planner session，用 `/replan <额外输入>` 为当前打开的 planner session 继续补充输入
- 用 `/follow [序号|session-id-or-path|last]` 打开实时 planner 查看器，按 `q` 返回主 TUI
- 用 `/files path1 path2`、`/add-file`、`/remove-file` 管理显式文件，用 `/verify <cmd>` 为 `run` 模式覆盖 verifier，用 `/yes on` 开启自动确认 patch
- 用 `/paste` 进入多行粘贴模式，以单独一行 `.` 结束
- `/files` 中的路径也会被视为显式授权：工作目录内的 autoDeny 文件可读写，工作目录外文件仅允许读取
- 用 `/inspect step <step-id|index>` 和 `/open-child <step-id|index>` 钻取 planner 执行细节
- 用 `/show-state` 查看当前模式、工作目录和覆盖项
- 用 `/reset` 清空当前 TUI 状态，用 `/quit` 退出
- 在 `run` 模式下，如果没有开启 `/yes on`，TUI 会展示 patch preview 并询问是否应用
- 当最后打开的是 planner session 时，TUI 会把 planner 计划、subtask 和时间线直接内嵌显示在会话界面中
- 完整命令说明和示例流程见 `docs/project/tui.md`

## 多文件 Patch

- 一个 patch 响应可以同时包含多个文件操作，适用于一次修复同时改实现、测试、配置、文档或 verifier 文件的场景
- 多文件 patch 的预览、应用、备份和回滚都走同一套 host patch 流程

## 备份与回滚

- 在 `replace_file` 或 `delete_file` 前，系统会先把原文件备份到 session 目录下的 `backups/`
- 回滚计划会保存到 `rollback.json`
- 可用 `node dist/index.js rollback --last` 回滚最近一次 session
- 也可用 `node dist/index.js rollback --session <session-id-or-path>` 回滚指定 session

## Apply 失败提示

- 如果补丁应用失败且你没有传 `--file`，CLI 会提示你改用 `--file` 或 `--paste`
- 如果上下文过弱，失败提示也会建议你把请求写得更具体

## 仓库结构

- `.marblecode`：项目级 agent 配置和 verifier 计划
- `scripts`：本地 smoke check、planner 查看器和手动回归入口
- `scripts/manual-suite`：按领域拆分的手动回归场景和共享测试 helper/provider
- `src/cli`：CLI 入口
- `src/agent`：主执行循环
- `src/config`：配置 schema 和配置加载
- `src/planner`：只读 planner 循环和基于 wave 的 planner 执行流程
- `src/planner/model.ts`、`parse.ts`、`artifacts.ts`、`prompts.ts`、`state.ts`、`recovery.ts`、`utils.ts`、`execute.ts`、`execute-wave.ts`、`execute-verify.ts`、`execute-subtask.ts`、`execute-resume.ts`、`execution-types.ts`、`execution-state.ts`、`execution-strategies.ts`：已拆出的 planner 辅助模块，分别处理请求构造、解析、artifact、提示词、状态刷新、恢复流程、顶层执行编排、执行波次逻辑、verify 步骤执行、subtask 执行、基于 artifact 的恢复、execution-state 快照以及基于策略的调度逻辑
- `src/planner/graph.ts`：执行图、冲突边和 execution wave 计算
- `src/planner/locks.ts`：planner execute 使用的文件锁和所有权转移辅助逻辑
- `src/provider`：模型抽象和 OpenAI-compatible Provider
- `src/router`：规则路由
- `src/context`：上下文选择
- `src/tools`：工具注册和内置工具
- `src/patch`：Patch 协议与应用
- `src/policy`：权限和 Shell 策略
- `src/verifier`：补丁后的验证执行
- `src/session`：本地会话记录
- `src/tui`：交互式终端 UI 和 planner session 渲染
- `src/shared`：跨模块复用的共享辅助函数
- `src/shared/json-response.ts`：agent、planner、verifier 共用的 fenced/balanced JSON 提取逻辑
- `src/shared/file-walk.ts`：context 和 tools 共用的递归文件遍历逻辑
- `src/index.ts`：顶层入口，仅转发到 CLI
- `examples/snippets`：用于演示 coding 修改的简单代码片段
- `examples/verifier-fixture`：用于 verifier 冒烟验证的最小 TypeScript 测试项目
- `examples/manual-test-suite`：确定性回归 fixture，以及真实模型 planner 校验任务文档
- `docs/project/architecture.md`：当前架构总览和运行时模块关系
- `docs/project/planner-parallel-graph.zh-CN.md`：planner 并行执行、任务图、wave、冲突检测和文件锁说明
- `docs/plans/planner-evolution-roadmap.zh-CN.md`：当前 planner execute 路线图和剩余优先级
- `README.zh-CN.md`：中文说明文档

## 重构说明

- 共享 JSON 解析和共享文件遍历已经统一收口到 `src/shared`
- planner、TUI、verifier、agent 的 runtime 热点已经拆成更聚焦的内部模块
- 当前剩余工作以 `docs/plans/planner-evolution-roadmap.zh-CN.md` 为准，重点已经从模块拆分转向 planner recovery、执行状态收口和工具边界扩展

## 下一步

- 继续收口 planner execution recovery，让 `execution.state.json` 更接近恢复主真相源
- 在现有 `ToolProvider` 边界和 external readonly provider gate 之上，再逐步尝试只读 LSP diagnostics 和本地 MCP 集成

外部 tool provider 当前默认仍然禁用。共享配置现在预留了 `tools.externalProvidersEnabled` 和 `tools.allow`，后续只读集成必须显式启用并加入 allowlist。

tool 执行日志现在也会记录 provider id/kind/access/capabilities 等 metadata，external provider 还可以在常规 session redaction 之前先对自己的日志字段做最小 sanitize。

当前第一个真实的本地 readonly source 已经可以通过 `.marblecode/diagnostics.json` 读取 diagnostics，并复用同一套 external provider gate 和 logging 路径；真实 LSP/MCP 仍然是后续工作。

## Verifier Markdown

`.marblecode/verifier.md` 中每个 `##` 小节代表一个 verifier 步骤。

- `- run: ...`：必填，实际执行的命令
- `- when: ...`：自由描述，供人和模型理解这个步骤为什么存在
- `- paths: src/**, scripts/**`：只在匹配到改动文件时执行
- `- platforms: linux, darwin, win32`：按平台筛选
- `- timeout: 120s`：覆盖默认超时
- `- optional: true`：标记为非阻塞步骤

## Verifier 自动发现

当没有显式 verifier 时，host 会按下面顺序尝试从仓库推断默认命令：

1. `package.json` 的精确脚本名：`verify`，否则 `test`，否则 `build`
2. `Makefile`/`makefile` 的精确 target：`verify`，否则 `test`，否则 `build`
3. `Cargo.toml` -> `cargo test`
4. `go.mod` -> `go test ./...`
5. `pytest.ini`、`tox.ini` 或带 pytest 信号的 `pyproject.toml` -> `pytest`

自动发现只作为兜底机制。只要项目需要更复杂的验证策略，仍然应该把共享 verifier 计划写进 `.marblecode/verifier.md`。

## 说明

- Shell 命令会以当前工作区根目录作为执行目录，并配合默认拒绝风格的安全基线
- 默认禁止高风险命令、联网命令和后台常驻模式
- 模型通过结构化 Patch 改码，不直接控制文件写入
- 当前整体架构总览见 `docs/project/architecture.md`
