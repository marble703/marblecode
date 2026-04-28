# 架构概览

本文档描述了当前仓库的现有架构。它有意比长期设计文档更聚焦，比旧的MVP计划更准确。

## 目标

运行时的构建围绕以下几个约束条件：

- 本地优先的 CLI 工作流
- 默认安全的文件与 Shell 访问
- 基于结构化 JSON 步骤、与提供商无关的 Agent 循环
- 由主机控制补丁应用，而非由模型控制文件写入
- 显式的会话产物，使得规划、执行、回滚和调试始终保持可检查状态

## 主要用户流程

### `run`

常规的编码循环。

1. CLI 解析请求并加载合并后的本地配置与项目配置。
2. 主机将任务路由到某个模型别名。
3. 上下文由显式文件、粘贴的代码片段、关键词召回以及最近使用的文件共同构建。
4. Agent 循环运行，模型返回类型为 `tool_call`、`patch` 或 `final` 的 JSON 响应。
5. 除非启用了 `--yes` 选项，否则会显示补丁预览。
6. 主机应用补丁、记录回滚元数据并运行验证器。
7. 验证失败时可触发有限次数的修复尝试。

### `plan`

只读的规划器循环。

1. 规划器接收显式文件、粘贴的代码片段以及受限上下文。
2. 规划器可使用只读工具进行搜索。
3. 规划器返回结构化的 `plan`、`plan_append`、`plan_update`、`tool_call` 或 `final` 响应。
4. 主机持久化规划产物和规划器日志，以便后续检查或恢复执行。

### `plan --execute`

由规划器驱动的执行流程。

1. 规划器生成结构化计划，也可以只生成一个 partial planning window。
2. 主机对计划进行归一化并构建执行图，并且可以只执行接下来配置好的几个 wave。
3. 后续 wave 可以通过 `plan_append` 和 `plan.delta.<revision>.json` 产物继续追加。
4. 代码/测试/文档步骤通过 coder 子代理运行。
5. 验证步骤通过验证器路径运行。
6. 失败的步骤可以重试、切换到备用模型、基于执行反馈（undeclared changed files / affected subgraph）触发局部重新规划，或者等待下一轮 planning window。

### `tui`

一个用于 `run`、`plan` 和 `plan --execute` 的交互式终端前端，同时支持规划器会话的检查和实时查看。

### `rollback`

使用先前会话记录的回滚元数据来恢复被替换或删除的文件。

## 运行时高层结构

在高层，运行时的结构如下所示：

```text
CLI/TUI
  -> 配置加载
  -> 路由
  -> 上下文选择
  -> 工具注册表 + 策略引擎
  -> agent 循环 或 planner 循环
  -> 补丁应用 / 验证器 / 回滚
  -> 会话产物和日志
```

Planner execute 扩展了上述流程：

```text
planner 循环
  -> 归一化/追加后的计划
  -> 执行图
  -> 波次窗口选择
  -> 文件锁 / 所有权
  -> coder 子代理
  -> 验证器步骤
  -> 重试 / 备用模型 / 本地重新规划 / 下一轮 planning window
```

## 模块图

### `src/cli`

以下功能的命令行入口点：

- `run`
- `plan`
- `tui`
- `rollback`

CLI 保持轻量，并将实际工作委托给运行时模块。

### `src/config`

加载并验证运行时配置。

当前的配置分层：

- 来自 `agent.config.jsonc` 的本地运行时配置
- 来自 `.marblecode/config.jsonc` 的项目覆盖配置
- 来自 `.marblecode/verifier.md` 的项目验证器计划

该模块还为路由、上下文、策略、验证器和会话行为提供默认值。

### `src/router`

将提示词映射到模型别名和执行策略。

当前路由仍使用静态启发式规则，但其输出现在会影响常规编码运行和 planner execute 的行为。

### `src/context`

根据以下内容构建受限上下文包：

- 显式文件
- 粘贴的代码片段
- 关键词召回
- 最近使用的文件

它还会生成一个上下文选择摘要，让模型了解为什么选择了某些文件。

### `src/tools`

定义主机工具注册表及内置工具。

当前内置工具包括：

- `read_file`
- `list_files`
- `search_text`
- `run_shell`
- `git_diff`
- `git_status`
- `git_log`
- `git_show`
- `git_diff_base`

规划器模式使用受限的只读子集。

### `src/policy`

强制执行路径、Shell、环境以及提供商网络的限制。

该模块是模型意图与主机执行之间的主要安全边界。

当前已补充的边界加固包括：

- 基于工作区相对路径的检查之外，再增加 resolved-path 校验，拒绝通过符号链接逃逸出工作区
- 对链式命令、子 shell 语法、重定向以及内联环境变量赋值等 shell 语法做限制
- 对 planner 子任务和其他受限运行场景提供更窄的显式写路径约束

### `src/agent`

为 `run` 和 coder 子任务实现基于 JSON 步骤的编码循环。

它负责：

- 发送模型请求
- 执行工具调用
- 预览并应用补丁
- 调用验证器
- 返回结构化的完成或干预状态

当前的内部拆分：

- `index.ts`：公共入口和 rollback helper
- `model.ts`：request 构建和 system prompt 组装
- `parse.ts`：模型步骤 JSON 解析和规范化
- `runtime.ts`：runtime 循环以及 patch/apply/verifier 编排
- `messages.ts`：patch preview 渲染与失败/干预文案组装

### `src/patch`

拥有内部补丁表示及补丁应用管道。

模型永远不会直接写入文件。主机负责解释结构化的补丁操作，并在应用过程中记录备份及回滚元数据。

补丁应用现在也会将“基线漂移”与一般 apply 错误区分开来，这样当文件在补丁生成后又被修改时，agent 和 planner 路径能给出更明确的恢复提示。

### `src/verifier`

解析验证器命令，并在补丁应用之后或规划器验证步骤中运行它们。

它支持：

- 显式的每次运行命令
- 配置定义的命令
- 来自 `.marblecode/verifier.md` 的 Markdown 验证器计划
- 基于仓库的备选发现机制
- 结构化的验证失败分析

当前的内部拆分：

- `index.ts`：`runVerifier()` 的编排入口
- `commands.ts`：manual/config/markdown/discovery 多来源命令解析
- `execute.ts`：shell 执行与 failure 聚合
- `analysis.ts`：验证失败分析 prompt 构建和 JSON 解析

### `src/session`

在 `.agent/sessions` 下存储本地产物，并按时间和数量清理旧会话。

该模块还负责解析普通会话和规划器会话，支持最近会话视图，并为回滚和规划器检查提供持久化基础。

### `src/provider`

定义统一的模型接口以及当前的 `OpenAICompatibleProvider` 实现。

目前仅实现了与 OpenAI 兼容的 Chat Completions 接口，但内部的请求/响应模型已经为流式传输、工具调用、推理 token 统计和供应商元数据预留了字段。

### `src/planner`

实现只读的规划器循环以及主机端的规划器执行流程。

当前的内部拆分：

- `index.ts`：公共入口点，以及 planner session 初始化与 runtime/bootstrap 衔接逻辑
- `loop.ts`：顶层 planner 循环和结果映射
- `runtime.ts`：planner request/state/result helper 和 step 分类逻辑
- `execution-types.ts`：execution-state 和 strategy 接口类型
- `execution-state.ts`：持久化 `execution.state.json` 快照构造
- `execution-machine.ts`：planner execution phase transition table 和事件分发入口
- `execution-strategies.ts`：执行策略选择和策略实现
- `model.ts`：规划器请求构建
- `parse.ts`：规划器响应解析和计划归一化
- `artifacts.ts`：规划器产物写入以及会话恢复/加载辅助函数
- `view-model.ts`：面向 TUI/WebUI 的 planner artifact 聚合与只读 DTO 构造
- `execute.ts`：顶层 planner 执行编排和 wave 分发
- `execute-wave.ts`：wave 选择、冲突检查和 blocked 依赖标注
- `execute-verify.ts`：verify 步骤执行和 verify-repair 衔接
- `execute-subtask.ts`：subtask 尝试准备、锁准备和 coder 子代理执行辅助逻辑
- `execute-resume.ts`：基于执行 artifacts 的 execution resume 入口
- `prompts.ts`：子任务、修复和重新规划的提示词构建器
- `state.ts`：ready/active/blocked/done 状态推导
- `recovery.ts`：本地重新规划流程
- `graph.ts`：执行图、冲突边和波次
- `locks.ts`：文件锁所有权及写入断言
- `utils.ts`：规划器共享辅助函数

有关任务图、波次和文件锁的详细信息，请参阅 `docs/project/planner-parallel-graph.zh-CN.md`。

### `src/tui`

提供交互式终端 UI 和规划器会话查看器。

planner artifact 的读取、事件归一化以及 planner read-model API 现已收敛到 `src/planner/view-model.ts`，而 `src/tui/planner-view.ts` 主要负责终端格式化和归一化后的 timeline 渲染。

TUI 不是一个独立的运行时栈，而是基于相同 `run` / `plan` / `plan --execute` 流程的前端界面。

有关命令级别的用法，请参阅 `docs/project/tui.md`。

### `src/shared`

跨模块共享的辅助函数。

当前重要的例子：

- `json-response.ts`：用于 agent、planner 和 verifier 响应的带分隔符/平衡括号的 JSON 提取
- `file-walk.ts`：递归遍历工作区文件，被上下文和工具模块复用
- `redact.ts`：结构化日志脱敏

## Planner Execute 的基础能力

Planner execute 是架构中超出原始 MVP 的主要部分。

当前主机端执行的基础能力包括：

- 带有显式依赖和文件作用域的归一化规划器步骤
- 包含 `dependency`、`must_run_after`、`conflict` 和 `fallback` 边的执行图，并带有用于语义写入耦合的 conflict reason/domain 元数据
- 从执行图中派生的执行波次
- 带有写所有权和降级为受保护读的文件锁表
- 由 `maxConcurrentSubtasks` 限制的、冲突感知的并发控制
- 持久化到 `execution.state.json` 的 execution-state 快照
- 通过 `serial`、`fail`、`aggressive`、`deterministic` 策略模式驱动的调度选择
- 针对失败步骤的重试、备用模型选择、带有下游依赖替代语义的 graph fallback 激活、经过 proposal 校验且受 bounded scope 约束并带有锁兼容性检查的本地重新规划，以及可降级的非关键步骤处理
- 持久化的执行产物，用于 TUI、离线检查以及 execution resume；planner view 现在会直接读取 `execution.state.json` 的 phase/strategy/wave/recovery 元数据

失败传播语义目前刻意保持保守：

- 同一 wave 中已经启动的任务允许先执行完，再统一并回主机状态
- 如果某一步失败，会优先激活可用的 graph fallback step
- 如果当前执行仍然停止，则仍处于 pending 的下游依赖节点会被显式标注为“被失败依赖阻断”，而不是被静默跳过

最好将其理解为“主机管理的结构化执行”，而不仅仅是一个更大的规划器提示词。

## 产物模型

该架构高度依赖会话产物，而非隐式的内存状态。

常见的产物包括：

- `request.json`
- `context.json`
- `model.jsonl`
- `tools.jsonl`
- `patch.json`
- `verify.json`
- `rollback.json`

规划器特定的产物包括：

- `plan.json`
- `plan.state.json`
- `plan.events.jsonl`
- `planner.request.json`
- `planner.context.packet.json`
- `planner.log.jsonl`
- `execution.graph.json`
- `execution.state.json`
- `execution.locks.json`
- `replan.proposal.<stepId>.json`
- `replan.rejected.<stepId>.json`

这些产物使得运行时更易于检查、恢复、在思维中重放以及调试。

## 安全模型

当前架构中的几个核心设计决策：

- 模型不直接写入文件
- Shell 命令经过策略检查，并以工作区根目录作为当前执行目录
- 敏感文件被排除在常规上下文和工具访问之外
- 写入访问可被限制为显式的文件授权
- planner execute 的写入额外受到文件锁的约束
- 会话默认对敏感信息进行脱敏

## 本文档的定位

本文档是当前的架构概览。

它不是：

- 一份历史 MVP 合约
- 一份详细的 planner execute 深度解析
- 一份 TUI 命令手册
- 一份重构路线图

请使用其他文档来满足这些需求：

- `README.md`：功能和流程概览
- `docs/project/planner-parallel-graph.zh-CN.md`：planner execute 图与锁模型
- `docs/project/tui.md`：TUI 命令参考
