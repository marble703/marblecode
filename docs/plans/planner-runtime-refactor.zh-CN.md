# Planner Runtime 重构计划

本文替代旧的 planner execute roadmap 与阶段性 maintenance review，记录当前有效的执行内核重构方向。

如果需要了解已经落地的行为，请先看：

- `README.md`
- `docs/project/architecture.md`
- `docs/project/planner-parallel-graph.zh-CN.md`

## 目标

当前 planner execute 已经具备：

- planner 结构化步骤与 `plan_append`
- `execution.graph.json` / `execution.state.json` / `execution.locks.json`
- wave 调度、文件锁、fallback、local replan、resume
- TUI / read-model / manual-suite 基础设施

问题不在于能力缺失，而在于执行内核复杂度已经明显超过当前任务规模需要。重构目标不是删除 planner 或并发能力，而是把运行时从“图驱动执行器”收敛为“任务队列 + 动态调度执行器”。

目标状态：

- planner 继续生成结构化步骤
- graph 保留为计划表达与兼容 artifact，不再作为运行时唯一真相
- `execution.state.json` 收敛为主要运行时真相源
- scheduler 基于 ready queue、锁与并发限制动态挑选可运行任务
- locks 只做互斥，不再承担 ownership transfer 等调度语义
- failure handling 以 retry / model fallback / append-only replan 为主，而不是 graph fallback

## 核心判断

### 1. graph 应降级为 plan IR，而不是 runtime truth

当前 `graph.ts` 同时承载 dependency、must-run-after、conflict、fallback 与 wave 推导，`execute.ts`、`state.ts`、`parse.ts`、resume/replan/read-model 都不同程度依赖它。长期看，这会让执行状态、恢复路径和调度语义越来越难维护。

目标方向：

- 保留 graph 作为计划表达、cycle check、兼容输出
- 运行时调度不再依赖 wave 选择与 conflict edge 推导
- blocked / ready 等基础状态改为直接从 plan status 与 dependency 派生

### 2. execution.state.json 应逐步成为主要运行时真相源

当前状态同时分散在：

- `plan.json`
- `plan.state.json`
- `execution.graph.json`
- `execution.locks.json`
- `execution.state.json`

短期内不会立刻删除旧 artifacts，但方向已经明确：

- `execution.state.json` 负责持久化运行时 task/lock/scheduler 状态
- `plan.state.json`、`execution.graph.json`、`execution.locks.json` 逐步退化为兼容或派生产物

### 3. wave 应退出运行时主地位

wave 适合作为静态计划展示或兼容 artifact，但不适合作为主要调度机制。运行时真正关心的是：

- 哪些任务 dependency 已满足
- 哪些任务 file scope 不冲突
- 哪些任务 conflict domain 不冲突
- 当前还能并发多少任务

因此目标是：

- 由 ready queue + 动态 batch 选择替代 wave-first 调度
- verify 继续作为 barrier task
- wave 可以在兼容层继续派生，但不再驱动执行主循环

### 4. conflictDomains 保留，但降级为 scheduler metadata

在复杂字段中，`conflictDomains` 仍然表达一个有价值的运行时语义：两个不同文件的任务也可能因为共享语义域而不适合并发执行。

重构方向：

- 保留 `conflictDomains`
- 不再生成 graph conflict edge 作为主调度语义
- scheduler 在选择 batch 时直接检查 conflict domain 冲突

## 分阶段计划

### 阶段 0：解耦基础状态与计划校验

目标：让 `state.ts` 与 `parse.ts` 不再依赖完整 execution graph。

已完成：

1. `src/planner/state.ts`
   - `refreshPlannerStateFromPlan()` 改为直接基于 step status、dependencies 与 `dependencyTolerances` 推导 ready/blocked
   - 不再调用 `buildExecutionGraph()` / `getBlockedReasons()`
2. `src/planner/parse.ts`
   - `runPlanConsistencyChecks()` 改用 dependency-only cycle check
   - 不再依赖 `buildExecutionGraph()` / `hasDependencyCycle()`
3. 文档同步
   - `docs/project/architecture_ZH-CN.md` 已更新该收敛变化

阶段 0 的意义：这是后续替换调度器的前置条件。没有这一步，graph 仍会渗透到基础状态刷新与 planner plan 校验路径中。

### 阶段 1：引入 ready-queue runtime

目标：在不立刻删除旧模块的前提下，用新的运行时结构接管 `execute.ts` 的主执行循环。

当前状态：runtime primitives 已落地，`execute.ts` 的 ready/pending/batch 判定已收口到 runtime runner adapter，batch selection 默认走 ready queue，新 adapter 在 fallback-ready 场景下保留 legacy wave 选择；batch execution 仍复用现有 `executePlannerWave()` / verify / feedback / recovery 路径。下一步再继续把 execution 主循环从 wave-first 编排彻底收口到 runtime runner。

计划内容：

1. 新增运行时类型：`ExecutionTask` / `ExecutionStateV2`
2. 新增 scheduler：
   - `getReadyTasks()`
   - `selectRunnableBatch()`
   - file scope / `conflictDomains` 并发约束
3. 新增 reducer：
   - `TASK_STARTED`
   - `TASK_SUCCEEDED`
   - `TASK_FAILED`
   - `TASK_RETRIED`
   - `TASK_DEGRADED`
   - `TASKS_APPENDED`
   - `EXECUTION_COMPLETED`
4. 新增 runner：
   - ready queue 循环
   - batch dispatch
   - 复用现有 subtask 执行和 verifier 路径
5. 新增 simple locks：
   - 只保留 acquire / release / canAcquire
   - 不引入 guarded_read 与 ownership transfer 语义
6. `execute.ts` 切换到新 runner
7. 继续输出兼容 artifacts：
   - `plan.state.json`
   - `execution.graph.json`
   - `execution.locks.json`

阶段 1 的约束：

- 不立即删除旧 execution modules
- 不立即重写 resume / local replan / TUI
- 先让主调度逻辑从 wave-first 切到 ready-queue-first

### 阶段 2：收敛 failure handling

目标：把 failure 语义从 graph 结构里抽出来。

计划内容：

1. 保留 model fallback
2. 删除 graph fallback 的主路径地位
3. 失败恢复优先顺序收敛为：
   - retry
   - model fallback
   - append-only replan
   - fail / degrade

### 阶段 3：简化 local replan

目标：把 local replan 从“局部图替换”收敛为“追加任务”。

计划内容：

- planner 失败恢复只允许 `plan_append`
- 不再替换已存在 task
- 不再删除旧 task
- 不再 merge 局部图
- 保留 `plan.delta.*.json` 与 `execution.feedback.json`

### 阶段 4：清理 legacy modules

当 ready-queue runtime 稳定后，再逐步收尾：

- 精简 `graph.ts`
- 删除 `ownership.ts`
- 删除 `execute-wave.ts` 的运行时职责
- 精简 `execution-strategies.ts`
- 收口 `execution-machine.ts` 的事件模型

## 当前优先级

### P0

- 完成阶段 1：ready-queue runtime 接管 `execute.ts`

### P1

- 收敛 failure handling，弱化 graph fallback
- append-only replan

### P2

- 让 `execution.state.json` 真正成为主要运行时真相源
- 清理 legacy artifacts 与 legacy execute modules

## 验收标准

每一阶段至少通过：

- `npm run build`
- `npm run smoke:verifier`
- `npm run test:examples`

对执行内核的关键行为，还应维持以下覆盖：

- 基础 chain 执行
- 不同 file scope 的并发执行
- 相同 file scope 的互斥执行
- verify barrier
- retry / fallback model
- degraded dependency acceptance
- blocked/conflict explainability
- plan append
- TUI / read-model 兼容加载

## 文档边界

本文只记录当前有效的重构计划。

已经失效的旧计划文档应移除，而不是继续保留过期的 future-tense 描述。已经落地的行为应继续回写到：

- `docs/project/architecture*.md`
- `docs/project/testing.md`
- `README*.md`
