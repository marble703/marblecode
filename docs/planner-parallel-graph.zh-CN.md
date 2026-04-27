# Planner 并行执行与任务图说明

这份文档整理当前仓库中 planner execute 的“并行规划基础设施”和“任务图执行模型”。

这里的“并行”指的是：planner 先产出一个结构化计划，host 再把计划转换为任务图、波次和锁规则，并在安全前提下并发执行同一波次中的子任务。

当前实现的核心目标不是盲目提速，而是先把以下几件事做成显式、可检查、可落盘的执行基础：

- 步骤依赖关系明确化
- 写入冲突显式建模
- 文件所有权和写锁显式建模
- 执行波次可解释
- 失败后的重试、fallback model、局部 replan 有统一落点

## 相关代码

- `src/planner/index.ts`: `runPlanner()` 的公开入口，负责 session/context 初始化并接入 planner loop
- `src/planner/loop.ts`: planner runtime loop、模型 fallback、invalid-response retry、tool/plan/final 分支推进
- `src/planner/runtime.ts`: planner request/state 初始化、step 分类、结果映射等轻量运行时 helper
- `src/planner/execution-types.ts`: execution state、strategy 接口与恢复相关类型
- `src/planner/execution-state.ts`: `execution.state.json` 快照构造
- `src/planner/execution-machine.ts`: execution phase transition table、事件分发和 artifact 写入入口
- `src/planner/execution-strategies.ts`: serial/fail/aggressive/deterministic 执行策略入口
- `src/planner/execute.ts`: planner execute 顶层编排
- `src/planner/execute-wave.ts`: ready-step 选 wave、wave 执行、失败传播
- `src/planner/execute-resume.ts`: 基于 execution artifacts 的执行恢复入口
- `src/planner/graph.ts`: 执行图、冲突边、wave 计算
- `src/planner/locks.ts`: 文件锁、所有权转移、写权限断言
- `src/planner/state.ts`: 从计划推导 ready/active/blocked/done 状态集合
- `src/planner/recovery.ts`: 局部 replan 恢复逻辑
- `src/planner/prompts.ts`: subtask/verify-repair/replan 提示词构造
- `src/planner/artifacts.ts`: `plan.events.jsonl`、`execution.graph.json`、`execution.locks.json` 等落盘

## 总体流程

1. planner 在只读模式下搜索代码并生成 `plan`
2. host 校验并规范化 `plan`
3. host 根据计划生成 `execution graph`
4. host 根据图计算 `waves`
5. host 按 wave 选择可执行步骤
6. 对写步骤准备文件锁与所有权
7. 通过 coder subagent 执行 code/test/docs 步骤，或直接运行 verify 步骤
8. 失败时进入 retry、fallback model、local replan 等恢复路径
9. 通过 execution machine 持续更新 `plan.json`、`plan.state.json`、`execution.graph.json`、`execution.locks.json`、`execution.state.json` 和事件日志

在 rolling planning 基础下，如果当前计划声明了 `isPartial=true`，host 也可以只执行前若干个 wave，然后回到 planner 请求 `plan_append`，并通过 `plan.delta.<revision>.json` 记录新增步骤。

## 执行反馈与反馈驱动 replan

当前 host 在每轮 wave 完成后会写出 `execution.feedback.json`，包含：

- `changedFiles` / `undeclaredChangedFiles`
- `verifyFailures`
- `stepSummaries`
- `triggerReplan` / `replanReason`

当检测到 undeclared changed files 时，会标记 `triggerReplan=true` 并记录 `execution_feedback_undeclared_files` 事件。局部 replan 请求现在会包含这些反馈信息，并且受影响子图会通过 `buildPlannerAffectedSubgraph()` 根据依赖关系、conflict domains 和未声明文件交集来限定范围。

Append 校验现在也通过 `validateAppendActiveWaveConflict()` 检查 writer step 是否与 active lock / active wave 冲突。

可以把当前模型理解成：

- planner 负责“提出可执行的步骤和依赖”
- host 负责“把步骤变成安全的执行图”
- subagent 负责“在被授予的文件范围内完成具体改动”

## Execution Machine

Planner execute 的阶段推进由 `src/planner/execution-machine.ts` 管理。

当前使用事件驱动的 transition table：

- `EXECUTION_INITIALIZED`: `idle` -> `planning`
- `LOCKS_ACQUIRED`: `planning`/`converging`/`recovering` -> `locking`
- `WAVE_EXECUTED`: `locking` -> `executing_wave`
- `WAVE_CONVERGED`: `executing_wave` -> `converging`
- `WAVE_REPLANNED`: `locking`/`executing_wave`/`recovering` -> `recovering`
- `FALLBACK_ACTIVATED`: `locking`/`executing_wave`/`recovering` -> `recovering`
- `VERIFY_STEP_STARTED`: `planning`/`converging`/`recovering` -> `executing_wave`
- `VERIFY_STEP_SUCCEEDED`: `executing_wave` -> `converging`
- `VERIFY_STEP_FAILED`: `executing_wave` -> `failed`
- `CONFLICT_DETECTED` / `DEPENDENCIES_BLOCKED` / `WAVE_FAILED`: 进入 `failed`
- `EXECUTION_COMPLETED`: 进入 `done`

非法 transition 会抛错，避免执行编排层随意覆盖 `executionPhase`。

`dispatchExecutionEvent()` 会在 transition 成功后统一写出：

- `execution.graph.json`
- `execution.locks.json`
- `execution.state.json`

## 任务图模型

任务图的定义在 `src/planner/graph.ts`。

### 节点

每个 planner step 会被投影成一个执行节点，核心字段包括：

- `stepId`
- `kind`
- `accessMode`
- `fileScope`
- `dependencies`
- `mustRunAfter`
- `conflictsWith`
- `fallbackStepIds`

其中最关键的是两个维度：

- 依赖关系：决定先后顺序
- 访问范围：决定是否允许同波次并发

### 边

当前支持四类边：

- `dependency`: 来自 `step.dependencies`
- `must_run_after`: 来自 `step.mustRunAfter`
- `conflict`: host 根据写入范围或显式冲突关系补出来的边
- `fallback`: 来自 `step.fallbackStepIds` 的条件恢复边

`conflict` 边尤其重要，因为它把“这两个步骤不能同时推进”从隐式约定变成了显式图结构。

当前 `conflict` 边还会带解释元数据：

- `reason: explicit`
- `reason: file_scope`
- `reason: unknown_write_scope`
- `reason: conflict_domain`

如果是 `conflict_domain`，edge 上还会记录 `domain`。

`fallback` 边不会像普通 dependency 一样参与 wave 入度计算。它表示“当 source step 失败时，target step 可以作为恢复路径被激活”。在 source step 未失败前，fallback target 会被视为 `fallback_inactive`，不会进入 ready set。

### accessMode

`accessMode` 的默认推导规则：

- `verify` 步骤 -> `verify`
- `search` / `note` 步骤 -> `read`
- 其他步骤 -> `write`

它不是装饰字段，而是并发安全的核心输入之一。

### fileScope

`fileScope` 的来源优先级：

- `step.fileScope`
- `step.producesFiles`
- `step.relatedFiles`

如果写步骤没有明确文件范围，host 会采取保守处理，尽量避免把它和其他写步骤并发执行。

## 冲突检测

冲突检测同样位于 `src/planner/graph.ts`。

规则可以概括为：

- `verify` 不参与普通写冲突判断
- 两个 `read` 步骤不冲突
- 任何涉及 `write` 的步骤，如果 `fileScope` 重叠，则冲突
- 如果某个写步骤没有 `fileScope`，host 会把它视为保守对象，不轻易与其他写步骤并发

除了自动冲突外，planner 也可以显式给出：

- `conflictsWith`
- `conflictDomains`
- `mustRunAfter`

这让模型可以表达“逻辑上不该并行”的场景，而不只依赖文件路径重叠。

## Wave 计算

wave 是当前并行执行的直接调度单元。

任务图生成后，host 会基于边集合做分层，得到如下结构：

- `wave 0`: 所有入度为 0 的步骤
- `wave 1`: 依赖上一层消除后的下一批步骤
- 依此类推

落盘产物是：

- `execution.graph.json`

其中包含：

- `nodes`
- `edges`
- `waves`

wave 的作用不是“保证一定并发”，而是“给 host 一个可解释的最大并发候选集合”。

是否真的并发，还要继续经过：

- `maxConcurrentSubtasks`
- `accessMode`
- `fileScope`
- `conflictPolicy`
- 当前锁状态

## 调度策略

调度主循环位于 `src/planner/execute.ts`，而 planner runtime loop 位于 `src/planner/loop.ts`。

### ready step

host 会先根据：

- 已完成依赖
- `mustRunAfter`
- `conflict` 边
- `fallback` 边的激活状态

推导出 ready steps。

### 选择一个 wave

从 `graph.waves` 中选择当前可运行的第一批候选后，再根据 execution strategy 做缩减：

- 如果其中包含 `verify`，优先只执行 verify
- 如果 `maxConcurrentSubtasks <= 1`，退化成串行
- 如果存在没有明确 `fileScope` 的写步骤，优先保守串行
- 否则，最多截取到 `maxConcurrentSubtasks`

所以“允许并发”不等于“强制并发”。当前实现明显偏保守，这是有意的。

### 同波次失败传播

当前语义是“已启动任务先收敛，再统一停止”。

- 同一 wave 中的 subtask 一旦已经启动，host 不会中途强杀它们
- host 会等待该 wave 的 `Promise.allSettled()` 结果全部返回
- 如果其中任一步骤失败，host 会优先检查是否存在可激活的 graph fallback step
- 如果 fallback step 被激活，执行进入 `recovering` 并继续下一轮调度
- 如果某个步骤声明了 `failureTolerance=degrade`，则 host 会把它记为 degraded，并允许当前执行继续推进
- 如果没有 fallback step 可用，当前执行会在本 wave 结束后停止
- 依赖失败步骤的下游节点不会被静默跳过，而是会被标注为 `blocked`，并带上 `dependency` 失败原因

这意味着当前模型更偏向“安全收敛”，而不是“立即取消其余并发任务”。

## conflict policy

`routing.subtaskConflictPolicy` 当前既影响冲突处理，也映射到 execution strategy：

### `serial`

默认模式。

冲突边会参与 wave 和 blocked 判定，让冲突写步骤顺延到更后面的执行时机。

适合日常使用，因为它的目标是：

- 尽量继续执行
- 尽量避免误判导致的全局失败

### `fail`

更严格的模式。

只要 host 检测到仍有待执行的冲突边，就直接失败并停止执行。

适合做保守验证，确认 planner 是否已经把步骤拆得足够清晰。

### `aggressive`

更偏吞吐优先的模式。

- 仍复用同一份执行图和锁规则
- wave 选择时更倾向于保留更大的 ready 集合，而不是过早缩减到保守串行

### `deterministic`

更偏可复现的模式。

- 即使 `maxConcurrentSubtasks > 1`，也优先按稳定顺序挑选单步执行
- 更适合做回归验证和时序敏感问题排查

## 文件锁与所有权

文件锁定义在 `src/planner/locks.ts`。

当前锁表是显式 artifact：

- `execution.locks.json`
- `execution.state.json`

每条锁记录包含：

- `path`
- `mode`
- `ownerStepId`
- `revision`
- `transferredFrom`（可选）

### 锁模式

- `write_locked`: 当前步骤拥有写权限
- `guarded_read`: 写步骤完成后降级成受保护读所有权，便于后续解释与继承

### 锁生命周期

1. 写步骤开始前，host 根据 `fileScope` 申请写锁
2. 子任务执行期间，所有写入都会经过 `assertStepCanWrite()` 断言
3. 子任务成功后，锁从 `write_locked` 降级为 `guarded_read`
4. 如果后继步骤满足所有权转移条件，可把写权从上一步转给下一步

### 为什么需要锁

因为 planner execute 不是直接在 host 内部改文件，而是委托给 coder subagent。锁表的意义是：

- 把“哪个步骤有权写哪个文件”做成显式状态
- 在 subagent 真正写文件时做二次断言
- 把未来更强的并发执行建立在可审计的文件所有权之上

## 所有权转移

host 允许有限的写权转移，主要用于这种链路：

- 上一步生成文件
- 下一步依赖该步骤并继续修改同一文件

当前允许转移的条件包括：

- 目标步骤依赖源步骤
- 目标步骤在 `mustRunAfter` 中引用源步骤
- 源步骤显式在 `ownershipTransfers` 里允许转给目标步骤
- 或两者本来就是同一个步骤

这个机制避免了“前一步刚写完，后一步却因为锁不连续而无法继续”的问题。

## 子任务执行与并发边界

当前并发单位是 wave 中的多个 subtask。每个 subtask 由 `runAgent()` 执行，并附带：

- 显式文件授权
- 写路径限制
- 写锁校验器
- 可选 verifier 开关

需要注意的是：

- 并发是在 host 调度层发生的
- 具体改码仍由独立 coder subagent 完成
- verify 仍然是特殊步骤，不与普通写步骤混跑

换句话说，当前实现更接近“冲突感知的安全并发执行”，而不是完全自由的任务抢占式执行。

## 恢复机制

执行失败后，当前恢复链路是分层的：

1. 普通重试：同一 model，最多 `subtaskMaxAttempts`
2. fallback model：切换到 `subtaskFallbackModel`
3. local replan：对失败节点做局部重规划，先写 proposal artifact，再通过校验后合并
4. 最终失败：把步骤标记为 `FAILED`

局部 replan 的目标不是重跑整个 planner，而是：

- 保留已完成步骤
- 仅对失败步骤和其下游做重新组织
- 提高长链路执行的恢复能力

### Local Replan Proposal

local replan 不再直接把模型返回的计划覆盖到主 `plan.json`。

当前流程是：

1. planner 针对失败步骤返回一个新的完整 plan
2. host 规范化该 plan
3. host 写出 `replan.proposal.<stepId>.json`
4. host 校验 proposal
5. 如果校验失败，写出 `replan.rejected.<stepId>.json` 并尝试下一个 planner model alias
6. 如果校验成功，才合并并写入主 `plan.json` / `plan.state.json`

当前 proposal 校验规则包括：

- 不能删除已完成步骤
- 不能修改已完成步骤的关键语义字段，例如 `title`、`kind`、`dependencies`、`fileScope`、`accessMode`、`mustRunAfter`、`fallbackStepIds`、`conflictsWith`
- 不能把已完成步骤重新激活
- 失败步骤必须仍然存在，且不能直接变成 `DONE`
- 对于不在本次 replan scope 内的未完成步骤，不能修改其语义字段
- 如果 proposal 中的写步骤会写入当前仍被其他 owner 持有的锁文件，且不存在合法 ownership transfer 路径，则 proposal 会被拒绝
- 新计划仍必须通过 `runPlanConsistencyChecks()`，包括引用完整性和 dependency cycle 检查

当前 replan scope 的定义是：

- 失败步骤自身
- 从失败步骤出发，沿 `dependency`、`must_run_after`、`fallback` 可达的未完成步骤

这意味着 local replan 不能借机重写无关的 pending step。

当前 fallback 也开始具备 replacement 语义：如果 source step 已失败，而其 fallback target 已成功完成，则依赖 source step 的下游步骤现在可以继续进入 ready 路径，而不必总是由 planner 预先把依赖显式改写到 fallback step。

相关事件包括：

- `subtask_replan_proposed`
- `subtask_replan_rejected`
- `subtask_replan_merged`
- `subtask_replanned`

如果不是 replan 路径，而是当前执行直接停止，则 host 会把依赖失败步骤的下游节点显式标注为 blocked，方便 TUI 和 artifact 解释为什么后续步骤没有继续跑。

## 状态与 Artifact

要理解当前执行模型，最重要的是看这些 artifact：

- `plan.json`: 当前计划
- `plan.state.json`: 当前状态摘要
- `plan.events.jsonl`: 事件流
- `planner.log.jsonl`: 结构化日志
- `execution.graph.json`: 执行图与 wave
- `execution.locks.json`: 锁表与所有权
- `execution.state.json`: 当前 ready/active/failed/blocked 集合
- `replan.proposal.<stepId>.json`: local replan 的候选计划
- `replan.rejected.<stepId>.json`: 被拒绝的 local replan 及原因

这些文件的价值在于：

- host 可恢复
- TUI 可解释
- 手工调试可追踪
- 后续并发增强有稳定数据基础

当前实现已经开始把 `execution.state.json` 作为恢复快照使用：当 planner session 仍处于执行中且存在 execution artifacts 时，resume 路径会优先尝试从 `plan.json` + `plan.state.json` + `execution.graph.json` + `execution.locks.json` + `execution.state.json` 恢复，而不是直接回到 planner loop。

## 当前限制

虽然已经有了任务图和并发基础设施，但当前实现仍然偏保守：

- wave 并发仍以“安全优先”，不是“吞吐优先”
- 对无 `fileScope` 的写步骤处理较保守
- planner 本身仍是“先规划，再执行”，还不是边规划边并发执行

## 为什么这套设计合理

这套模型的关键不是追求理论上的最强并发，而是先把以下基础打稳：

- 计划结构是显式的
- 依赖与冲突是显式的
- 文件所有权是显式的
- 执行状态是显式的
- 恢复路径是显式的

只要这些信息是显式 artifact，后续无论继续拆 `src/planner/index.ts`，还是把并发做得更激进，都不会回到“靠隐式顺序和临时约定运行”的状态。

## 当前拆分状态

这一轮重构后，planner execute 相关的大块逻辑已经从 `src/planner/index.ts` 迁出：

- `runPlanner()` 主入口保留在 `src/planner/index.ts`
- planner runtime loop 位于 `src/planner/loop.ts`
- `executePlannerPlan()` 位于 `src/planner/execute.ts`
- `executePlannerWave()` 位于 `src/planner/execute-wave.ts`
- `executePlannerVerifyStep()` 位于 `src/planner/execute-verify.ts`
- `executePlannerSubtaskWithRecovery()` 和锁准备逻辑位于 `src/planner/execute-subtask.ts`

这意味着：

- `src/planner/index.ts` 现在更接近薄入口
- `src/planner/execute.ts` 更接近 execute 顶层 orchestration
- wave 选择、wave 执行、blocked 传播已收敛到同一个 focused module

后续如果还要继续重构，更值得关注的是：

- `src/planner/execute-subtask.ts` 体积继续增长时，再考虑把 agent launch 和 recovery 细分
- `scripts/test-examples.ts` 已收敛为 suite 入口，后续如果 manual suite 继续增长，可再细分 shared fixtures 或 case registration 组织方式

## 适合怎么读这套实现

如果你想快速理解当前设计，推荐按这个顺序读：

1. `src/planner/types.ts`
2. `src/planner/graph.ts`
3. `src/planner/locks.ts`
4. `src/planner/state.ts`
5. `src/planner/loop.ts` 与 `src/planner/execute.ts`
6. 再看 `execution.graph.json`、`execution.locks.json` 和 `show:planner` 的输出

这样会比直接从 `runPlanner()` 一路往下读更容易建立整体心智模型。
