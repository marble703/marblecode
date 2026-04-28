# Planner 演进路线图

本文基于当前仓库实现状态，整理 planner execute 后续优化方向、优先级和推进路线。范围包括显式状态机完整化、语义冲突域、图化 fallback/replan、滚动式规划、LSP/MCP 中间层，以及未来 WebUI/TUI 接口。

本文描述规划与推进状态。第一阶段的状态机收敛已经完成基础实现，其余阶段仍是后续路线。

## 当前状态快照

已具备的基础：

- `executePlannerPlan()` 已通过 `src/planner/execution-machine.ts` 使用事件驱动的显式 phase transition，并持久化 `execution.state.json`。
- `execution.graph.json` 已包含 `dependency`、`must_run_after`、`conflict`、`fallback` 四类边类型，其中 `fallback` 已可由 `fallbackStepIds` 生成并在 step 失败后激活。
- `execution.locks.json` 已记录文件锁，支持 write lock、guarded read、所有权转移。
- `subtaskConflictPolicy` 已支持 `serial`、`fail`、`aggressive`、`deterministic`，并通过 `PlannerExecutionStrategy` 选择 wave。
- planner execute 可从 execution artifacts 进入恢复路径，但恢复策略仍偏保守。
- TUI 已有 `PlannerViewModel`、`show:planner`、live polling view，可消费 `plan.json`、`plan.state.json`、`execution.graph.json`、`execution.locks.json` 和事件日志。
- TUI 拆分已完成：共享类型、slash-command 解析、paste/patch-confirm helper、state hydration、render、planner session actions、run/plan/execute dispatch 已分别落到 `src/tui/{types,commands,paste,state,render,session-actions,run-prompt}.ts`，`src/tui/agent-repl.ts` 仅保留顶层循环编排。

当前主要缺口：

- 状态机已有 transition table 和 dispatch 入口，但还没有把 wave/lock/replan 等所有运行时决策都纳入 reducer。
- `execution.state.json` 记录了阶段和集合快照，但还不是所有调度决策的唯一来源。
- artifact resume 目前基本是重置非 DONE 步骤再重跑，没有精确恢复 active wave、fallback path 或局部子图状态。
- 冲突检测现在已开始同时支持 `fileScope`、显式 `conflictsWith` 和 `conflictDomains`，但语义域 taxonomy 仍是第一版。
- graph fallback 已支持基础激活，并且 fallback 成功后已可替代失败 source step 满足下游依赖。
- 局部 replan 已经是 proposal-first，并具备 completed-step 保护、bounded scope 和 active lock compatibility 校验；更严格的 future graph-delta / rolling-merge 约束仍待后续阶段补齐。
- wave 失败处理仍偏“一失败则停止 wave/全局失败”，没有 `DEGRADED` 或可容忍失败语义。
- 工具系统目前是内置 `ToolRegistry`，没有 LSP/MCP provider 层。
- TUI/viewer 已开始读取 `execution.state.json` 的 phase/strategy/epoch/wave/recovery metadata，但还没有稳定的 WebUI DTO 或事件协议。
- planner 一次性产出完整计划，无法根据执行反馈滚动追加后续 wave。

## 优先级判断

### P0：先完成状态机闭环（基础已完成）

这是所有后续能力的前置条件。

原因：fallback edge、rolling planning、局部 replan、可容忍失败、WebUI 可视化都需要一个可验证、可恢复、可审计的执行状态模型。如果状态转换仍散落在编排层，后续功能会继续变成分支堆叠。

目标：

- 把当前 `executionPhase` 从“变量 + 写 artifact”提升为独立 execution state machine。
- 让状态转换有显式 transition 函数和事件输入。
- 让 `execution.state.json` 成为 host resume 和 UI 展示的稳定依据。

已完成任务：

1. 新增 `src/planner/execution-machine.ts`。
2. 定义 `PlannerExecutionEvent`，覆盖初始化、冲突、阻塞、锁定、wave 执行、verify、replan、完成等 transition。
3. 定义 `transitionExecutionPhase(previousPhase, event)`，非法 transition 会抛出错误。
4. 定义 `dispatchExecutionEvent(...)`，统一执行 transition 并写出 `execution.graph.json`、`execution.locks.json`、`execution.state.json`。
5. 将 `execute.ts` 中的 phase 字符串写入替换为事件驱动 dispatch。
6. 保留 artifact schema version `1`。
7. 增加 manual-suite 覆盖：合法/非法 transition、dispatch artifact 写入、execute helper 和 artifact resume 的最终 execution-state 断言。

当前完成标准：

- `execute.ts` 不再直接随意设置 `executionPhase`。
- 所有 phase 变化都经过同一个 transition 入口。
- `execution.state.json` 至少包含当前 phase、epoch、strategy、ready/active/completed/failed/blocked、current wave、last completed wave、recovery metadata。

### P1：把 fallback/replan 变成图的一部分（fallback 与 replan proposal 基础已完成）

这是当前恢复能力最值得优先补齐的方向。

原因：仓库已经预留了 `fallbackStepIds` 和 `fallback` edge，但实际失败恢复仍在 `execute-subtask.ts` 和 `recovery.ts` 中用过程式逻辑完成。把 fallback 激活纳入 graph，可以显著提升可审计性、可视化和 resume 可靠性。

目标：

- `execution.graph.json` 真实表达 fallback 边。
- step 失败后 host 优先激活 fallback path，而不是直接全局 FAILED。
- 局部 replan 输出不能直接替换内存计划，必须经过校验和图级合并。

已完成的 fallback 基础：

1. `buildExecutionGraph()` 基于 `step.fallbackStepIds` 生成 `fallback` edge。
2. fallback target 在 source step 未失败时保持 `fallback_inactive`，不会进入 ready set。
3. 当 source step 失败且存在可用 fallback target 时，host 会激活 fallback step 并继续执行，而不是直接全局 FAILED。
4. `FALLBACK_ACTIVATED` 已纳入 execution machine，进入 `recovering` phase。
5. `plan.events.jsonl` 会记录 `subtask_fallback_activated`。
6. planner view 会展示 fallback edges。
7. fallback 成功后，下游依赖原失败步骤时可由 fallback 节点替代满足。

已完成的 replan proposal 基础：

1. 新增 `src/planner/replan-merge.ts`，集中处理 proposal 构建、校验和合并。
2. local replan 会先写 `replan.proposal.<stepId>.json`，校验通过后才合并进主 `plan.json`。
3. proposal 校验会保护已完成步骤，拒绝删除或修改其关键语义字段。
4. proposal 校验失败时写 `replan.rejected.<stepId>.json`，并记录 `subtask_replan_rejected`。
5. 合并成功时记录 `subtask_replan_proposed`、`subtask_replan_merged` 和兼容事件 `subtask_replanned`。
6. proposal 的影响范围已收紧到 bounded subgraph：失败节点及其通过 `dependency` / `must_run_after` / `fallback` 可达的未完成节点。
7. proposal 合并前会检查与当前 `execution.locks.json` 的 active lock compatibility，不兼容的写范围会被拒绝。

仍待完成的替代/锁语义：

1. 当前 replacement 语义是隐式的：只要 fallback target `DONE`，依赖 source step 的下游就可继续。后续如果需要区分 `alternative` / `replacement` 模式，还需要明确 step-level 或 edge-level 表达。

完成标准：

- `execution.graph.json` 中出现的 `fallback` edge 可影响 ready step 计算。
- 失败节点有 fallback 时，不直接将整个 execution 标记 FAILED。
- `show:planner` 能展示 fallback edge 和激活原因。
- local replan 必须先经过 proposal artifact 和 validation，再合并进主计划。

当前剩余更偏策略/语义精细化，而不再是基础设施缺失：下一步更适合转向 `conflictDomains`，然后再处理 `DEGRADED` 和 rolling planning。

### P1：引入语义冲突域 conflictDomain

这是并发执行质量的关键增强，但应在状态机闭环之后推进。

原因：当前路径级冲突已能保护文件写入安全，但无法表达 API contract、DB schema、CSS theme、build config、global runtime state 等逻辑耦合。语义域会影响 graph 构建、wave 选择、锁表和 planner prompt，需要小步引入。

目标：

- Planner step 可声明 `conflictDomains: string[]`。
- Host 根据 conflict domain 生成语义 conflict edge。
- TUI 能展示 domain 级冲突原因。

建议任务：

1. 在 `PlannerStep` 中新增 `conflictDomains?: string[]`。
2. 在 planner prompt 中要求模型声明“前向更改声明”，例如 `api-contract`、`db-schema`、`css-theme`、`routing-contract`、`build-config`、`test-fixtures`。
3. 在 `PlannerExecutionNode` 中加入 `conflictDomains`。
4. 修改 `nodesConflict()`：路径冲突和 domain 冲突都能产生 `conflict` edge。
5. 给 `PlannerExecutionEdge` 增加可选 `reason` 或 `domain` 字段，避免 UI 只能看到两个 step 冲突但不知道原因。
6. 支持显式 `conflictsWith` 继续生效，且优先级最高。
7. 引入简单 domain registry 文档，不做过早复杂配置。初期允许自由字符串，但在 consistency check 中校验格式：小写 kebab-case。

已完成的 conflictDomains 基础：

1. `PlannerStep` 已支持 `conflictDomains?: string[]`。
2. planner normalize / consistency check 已支持 `conflictDomains`，并校验 `kebab-case` 格式。
3. `PlannerExecutionNode` 已携带 `conflictDomains`。
4. graph 构图时已支持 `conflict_domain` 冲突边，并在 edge 上写出 `reason` / `domain` 元数据。
5. planner system prompt 已提示模型在文件路径不足以表达耦合时声明 `conflictDomains`。
6. planner view 已可展示 conflict summary，并区分 `file_scope` / `conflict_domain` / `explicit`。

仍待完成的 conflictDomains 细化：

1. 如需更强约束，后续可引入项目级 domain registry，而不只是格式校验。
2. 未来 rolling planning / delta merge 还需要继承 domain-level 校验。

完成标准：

- 两个写不同文件但共享 `api-contract` 的 step 不会并发执行。
- `execution.graph.json` 可说明冲突原因是 file path 还是 conflict domain。
- manual suite 覆盖：不同文件同 domain 冲突、不同 domain 可并发、read/read 不冲突但 global/write domain 可冲突。

### P2：可容忍失败与 DEGRADED 执行

这是提升吞吐和韧性的功能，但不应早于 fallback/replan 图化。

原因：一旦允许 wave 在部分失败下继续，状态机、依赖语义、最终 outcome 都会复杂化。如果没有图化 fallback 和清晰状态机，容易引入误报成功。

目标：

- 非关键步骤可以失败但不阻断整个 wave。
- 下游步骤可声明是否接受 degraded dependency。
- 最终结果能区分 `DONE`、`DONE_WITH_DEGRADATION`、`FAILED`。

建议任务：

1. 新增 step 字段 `optional?: boolean` 或 `failureTolerance?: 'none' | 'degrade'`。
2. 扩展 execution state，增加 `degradedStepIds`。
3. 谨慎扩展 outcome。若不想改 `PlannerOutcome`，可先在 `execution.state.json` 中记录 degraded，最终 message 明确说明。
4. 依赖边增加语义：必需依赖和可选依赖。可先用 step-level `optional`，后续再扩展 edge-level optional dependency。
5. `executePlannerWave()` 聚合结果时：optional step failed -> 标记 degraded，继续处理同 wave 其他结果；required step failed -> 走 fallback/replan/fail。
6. verify step 默认不可 degraded，除非用户或 planner 明确标记为非关键验证。

已完成的 DEGRADED 基础：

1. `PlannerStep` 已支持 `failureTolerance?: 'none' | 'degrade'`。
2. `PlannerState` / `execution.state.json` 已支持 `degradedStepIds`。
3. wave 聚合时，`failureTolerance=degrade` 的步骤失败后不会立即阻断整个执行，而会记录为 degraded。
4. `plan.events.jsonl` 已记录 `subtask_degraded`。
5. planner view 已可展示 degraded steps。

仍待完成的 DEGRADED 细化：

1. 当前仍沿用 `status: FAILED` + `degradedStepIds` 的组合语义，后续如需更强表达可考虑独立 status/outcome 细分。
2. dependency-level optional / degraded acceptance 还没做成显式边语义。

完成标准：

- 文档更新失败不会阻塞代码和测试步骤。
- 可选 lint 失败可被记录为 degraded，但最终输出必须明确风险。
- TUI 可展示 degraded 节点。

### P2：滚动式规划与执行反馈驱动 replan

这是解决“planner 一次性产出完整计划，无法根据执行反馈动态调整后续步骤”的主线能力。

原因：这是架构层能力，依赖动态图、状态机、replan 合并校验、锁兼容检查。应在 P0/P1 基础稳定后推进。

目标：

- Planner 不必一次性规划全链路。
- Host 先执行前 N 个 wave，再基于执行结果追加后续 wave。
- 当执行反馈偏离预期时，只重绘受影响子图。

建议任务：

1. 引入 planning window 配置，例如 `routing.planningWindowWaves` 或 `routing.planningWindowSteps`。
2. 扩展 planner prompt：要求输出 `planningHorizon`、`openQuestions`、`nextPlanningTriggers`。
3. 允许 `execution.graph.json` 动态追加节点和边，但 host 必须校验：无 cycle；不破坏 DONE 节点；新增写 scope 不与现有 active lock 冲突；新增 conflict domain 不与 active wave 冲突。
4. 新增 artifact：`plan.delta.<revision>.json` 或 `graph.delta.<revision>.json`，记录追加节点/边来源。
5. 定义 execution feedback packet：包含 changedFiles、undeclaredChangedFiles、verify failures、new dependencies、lock violations、test diagnostics、step summaries。
6. 局部 replan 只允许影响一个 bounded subgraph：失败节点、依赖它的未完成节点、同 conflict domain 的未完成节点。
7. Replan proposal 必须通过合并校验后才能进入主 plan。

已完成的滚动式规划基础：

1. `routing.planningWindowWaves` 已落地，默认值为 `1`。
2. planner prompt / schema 已支持 `isPartial`、`planningHorizon`、`openQuestions`、`nextPlanningTriggers`。
3. planner loop 已支持 `plan_append` 响应类型，用于在已有部分计划后追加新步骤。
4. 新增 `plan.delta.<revision>.json`，记录 append 来源、追加步骤和窗口大小。
5. host 已支持 append 校验：禁止重定义既有步骤、禁止引入 cycle，并保留锁兼容校验入口。
6. `executePlannerPlan()` 已支持在 partial plan 下仅执行前 `planningWindowWaves` 个 wave，然后回到 planner 继续规划。
7. manual suite 已覆盖 rolling window append 成功路径和非法 append 拒绝路径。

 仍待完成的滚动式规划细化：

1. 当前 append 校验已覆盖结构与 cycle，active lock / active wave conflict 校验已通过 `validateAppendActiveWaveConflict()` 接入 `plan_append` 主流程。
2. 当前 delta artifact 还是 step-level `plan.delta.*`，未来如需更强图级审计可继续补 `graph.delta.*`。
3. execution feedback packet 已通过 `execution.feedback.json` 落地，host 现在支持按 step 级 changedFiles 检测 undeclared changed files，并在 feedback 标记 `triggerReplan`。
4. 受影响子图计算已通过 `buildPlannerAffectedSubgraph()` 落地。
5. feedback 已接入 `buildPlannerNodeReplanRequest()`，planner replan 提示词现在包含执行反馈信息（changedFiles / undeclaredChangedFiles / stepSummaries）。
6. `subtaskReplanOnFailure` 且 feedback 存在时，局部 replan 现在会把 feedback 传入 planner prompt，并继续走 proposal-first merge。
7. manual suite 已覆盖 feedback artifact 生成、affected subgraph 计算、active lock append 冲突校验。

完成标准：

- 长任务可以先产出前 1-2 个 wave 并执行，再追加后续 wave。
- 未声明文件变更会触发局部 replan 或 graph conflict refresh。
- graph revision 单调递增，TUI 能展示每次 delta。

### P2：整理 WebUI/TUI 接口

这项应与状态机和图 artifact 演进并行做薄层，不应等到最后。

原因：当前 TUI 直接读 artifact 并即时转换，适合 CLI，但 WebUI 需要稳定 DTO、事件流和增量更新。先抽 view-model 层可以降低后续 UI 成本。

目标：

- `PlannerViewModel` 成为稳定的 UI DTO。
- TUI/WebUI 共享同一个 artifact loader 和 event normalizer。
- 支持轮询和未来事件流两种模式。

建议任务：

1. 让 `loadPlannerView()` 读取 `execution.state.json` 并暴露 `executionPhase`、`strategy`、`epoch`、`currentWaveStepIds`、`degradedStepIds`。
2. 给 `PlannerViewModel` 增加 graph edge summaries，包括 conflict/fallback reason。
3. 抽出 `src/planner/view-model.ts` 或保留在 `src/tui/planner-view.ts` 但避免终端格式化逻辑和 DTO 构造耦合。
4. 定义 WebUI 未来可用的只读接口形状：`GET /sessions`、`GET /sessions/:id/planner-view`、`GET /sessions/:id/events`。
5. 暂不实现 HTTP server，先把 DTO 和事件格式稳定下来。
6. 后续如加 server，默认只监听 localhost，并复用 policy/session 配置。

已完成的 WebUI/TUI DTO 基础：

1. 新增 `src/planner/view-model.ts`，集中负责 planner artifact 读取、容错和 DTO 组装。
2. `loadPlannerView()` 已从 `src/tui/planner-view.ts` 抽离到数据层模块。
3. `PlannerViewModel` 已开始暴露 rolling planning / execution feedback / replan artifact 摘要，包括 `planDeltas`、`latestFeedback`、`replanProposals`、`replanRejections`。
4. `src/tui/planner-view.ts` 现在主要保留终端格式化和 `renderPlannerEvent()`。
5. `planner-live.ts`、`agent-repl.ts`、manual-suite TUI tests 已切换到共享 loader。

当前状态：基础能力已完成，阶段进入收尾。

已完成的 WebUI/TUI 接口收口：

1. `loadPlannerView()`、`loadPlannerEvents()`、`loadPlannerSessionSummary()` 已形成 shared read-model API。
2. `PlannerViewModel` 已暴露 normalized `timeline` / `subtaskTimeline`。
3. planner read-model 已开始暴露 `feedbackHistory`、`deltaHistory`、`replanHistory` 轻量摘要。
4. recent session summary 已开始携带 `executionPhase`、`planRevision`、`planIsPartial`。

仍待完成的 WebUI/TUI 细化：

1. 当前已在 `src/planner/view-model.ts` 引入 normalized `timeline` / `subtaskTimeline`，但未来如需更严格协议仍可进一步抽出独立 event normalizer 模块。
2. 当前 view model 已开始暴露 `feedbackHistory`、`deltaHistory`、`replanHistory` 摘要，但仍主要基于现有 artifact 组织，而不是专门的 history artifact 协议。
3. 只读接口边界已开始固化，`loadPlannerView()`、`loadPlannerEvents()`、`loadPlannerSessionSummary()` 现已形成 shared read-model API；未来 WebUI 的 `/sessions` / `/planner-view` / `/events` 仍待进一步产品化。

下一步建议（进入 P3 前的收口阶段）：

1. 已完成：`scripts/manual-suite/planner.ts` 已按 graph / execution / recovery / runtime 维度拆开。
2. 下一步：拆分 `src/tui/agent-repl.ts`，按 commands / session-actions / state / render / paste / run-prompt 分层。
3. 在上述结构性收口完成后，再进入 `ToolProvider` abstraction。

完成标准：

- `show:planner`、live TUI、未来 WebUI 可复用同一个 view model。
- View model 对 partial artifacts 容错。
- UI 层不需要理解 plan/graph/lock/execution-state 多文件细节。

### P3：LSP 与 MCP 中间层

这项重要但不应抢在 planner execution 基础之前。

原因：仓库当前工具系统非常简单：`ToolRegistry` 注册内置 `Tool`，没有插件生命周期、权限分层、外部工具 schema 同步、长连接管理。直接引入 LSP/MCP 容易扩大安全面和复杂度。建议先做中间层接口，再接具体协议。

进入 P3 前的额外前置建议：

1. 不要在 `src/tui/agent-repl.ts` 仍然膨胀的情况下直接接入 LSP/MCP。
2. 先引入 `ToolProvider`，再做 builtin migration，然后再接真实 LSP/MCP provider。
3. 对 planner 的长期方向，优先采用“graph mutation proposal capability + host validation/merge”的模式，而不是让 planner 直接拥有主计划写权限。

目标：

- 把内置工具、LSP 工具、MCP 工具统一成 tool provider。
- LSP 提供 diagnostics、definition、references、workspace symbols 等只读能力。
- MCP 作为外部工具 bridge，但受当前 policy 和 workspace boundary 管控。

建议任务：

1. 引入 `ToolProvider` 抽象：`id`、`listTools()`、`executeTool()`、`dispose()`。
2. 将现有 builtins 包装为 `BuiltinToolProvider`，保持现有 `ToolRegistry` API 兼容。
3. 新增 config 段落草案：`tools.providers` 或 `integrations.lsp/mcp`，先不落地复杂配置也可以。
4. LSP 第一阶段只做 TypeScript server diagnostics，不做自动 edit。
5. MCP 第一阶段只支持 stdio/local command，默认 disabled，必须显式 allowlist。
6. 所有外部工具结果都要经过 session log redaction 和 policy 检查。
7. Planner context selection 可优先消费 LSP diagnostics，但不能让 LSP 绕过 `context.autoDeny` 和 explicit grants。

完成标准：

- 内置工具可通过 provider 机制注册，行为不变。
- LSP diagnostics 能作为 read-only tool 出现在 planner tools 中。
- MCP 工具不能默认获得写权限或网络权限。

## 推荐推进路线

### 阶段 1：状态机收敛

目标是把当前“显式状态变量”变成可测试、可恢复、可扩展的状态机。

交付：

- `execution-machine.ts`
- 状态 transition 单测/manual-suite case
- `execute.ts` 中 phase 写入改为 event transition
- `execution.state.json` 被 TUI 读取

验证：

- `npm run build`
- `node --import tsx ./scripts/test-examples.ts`
- 重点 case：planner execute resume、execution strategies、blocked dependents、retry recovery

### 阶段 2：图化 fallback 与严格 replan proposal

目标是让恢复路径进入 graph，而不是继续散落在执行分支中。

交付：

- fallback edge generation
- fallback activation
- TUI 展示 fallback/replan events
- `replan.proposal.*.json`
- bounded subgraph merge validator
- `replan.rejected.*.json`

验证：

- fallback node activation case
- invalid replan rejected case
- replan cannot remove DONE step case
- fallback path lock acquisition case

### 阶段 3：语义冲突域

目标是让 planner 具备“前向更改声明”，改善并发安全。

交付：

- `conflictDomains` step field
- conflict edge reason/domain
- prompt 更新
- graph/wave/lock/viewer 覆盖

验证：

- same-domain different-file conflict
- different-domain parallel execution
- explicit `conflictsWith` still works

### 阶段 4：可容忍失败与 degraded

目标是让非关键步骤失败不阻断关键路径。

交付：

- optional/failureTolerance step metadata
- degraded tracking
- wave result aggregation update
- TUI degraded display

验证：

- optional docs failure continues
- required code failure still stops or activates fallback
- verify default remains blocking

### 阶段 5：滚动式规划

目标是支持动态追加 graph，并基于执行反馈做局部 replan。

交付：

- planning window config
- graph delta artifact
- execution feedback packet
- append node/edge validator
- local affected-subgraph selection

验证：

- long task only plans first N waves initially
- later wave appended after prior wave done
- undeclared file change triggers local replan proposal

### 阶段 6：LSP/MCP 与 WebUI 基础

目标是扩展生态，但保持安全和可观测。

交付：

- `ToolProvider` abstraction
- builtin provider migration
- LSP diagnostics read-only provider
- MCP local stdio provider prototype
- WebUI-ready planner view DTO

验证：

- existing tools unchanged
- LSP/MCP disabled by default
- policy blocks unauthorized external writes/network

## 不建议现在做的事

- 不建议马上引入完整 HTTP WebUI server。先稳定 DTO 和 artifact/event 模型。
- 不建议直接把 MCP 工具加入 planner/coder 默认工具列表。必须先有 provider 生命周期和 policy 边界。
- 不建议给 conflict domain 做复杂 taxonomy 配置。初期自由字符串 + 格式校验即可。
- 不建议让局部 replan 直接覆盖 `plan.json`。必须先 proposal，再校验合并。
- 不建议先做 rolling planning。它依赖动态图、状态机和 replan validator，提前做会把复杂度推回执行编排层。

## 额外建议

### Artifact schema 管理

随着 `execution.state.json`、graph delta、replan proposal 增多，建议引入轻量 schema/version 策略：

- 每个 artifact 保留 `version`。
- loader 做宽松读取，writer 写最新格式。
- manual suite 保留至少一个 partial artifact 兼容 case。

### 事件命名规范

建议 planner events 统一成动词过去式或状态转换式：

- `execution_phase_changed`
- `wave_selected`
- `locks_acquired`
- `fallback_activated`
- `replan_proposed`
- `replan_merged`
- `step_degraded`

这样 TUI/WebUI 不需要硬编码过多旧事件含义。

### 未声明文件变更

Rolling planning 前可以先做一个小能力：执行后比较 `changedFiles` 和 step 声明的 `fileScope`/`producesFiles`。

如果出现 undeclared changed files：

- 更新 step artifact，记录 `undeclaredChangedFiles`。
- 触发 graph rebuild。
- 若与 active/pending step 冲突，进入 `recovering` 或 replan proposal。

这会直接提升 planner 执行反馈质量。
