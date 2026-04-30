# Planner 演进路线图

本文只保留当前仍有效的 planner execute 后续计划。已经完成的模块拆分、状态机基础、fallback/replan 基础、rolling planning 基础、degraded 基础，以及 TUI/view-model 基础能力，不再在这里重复展开。

如果需要了解当前已落地的行为，请优先查看：

- `README.md`
- `docs/project/architecture.md`
- `docs/project/planner-parallel-graph.zh-CN.md`

## 当前判断

仓库已经明确走在“planner 产出结构化步骤，host 将其转换为执行图并安全执行”的方向上。

当前基础已经具备：

- planner 结构化输出与 `plan_append`
- `execution.graph.json` / `execution.state.json` / `execution.locks.json`
- dependency / must-run-after / conflict / fallback 边
- wave 调度、文件锁、fallback 激活、proposal-first local replan
- execution feedback artifact 与 planner view model

当前真正剩余的工作，已经从“补基础设施”转向“提升执行内核成熟度、恢复精度和可扩展性”。

## 当前有效缺口

### 1. 执行状态还没有成为唯一真相源

当前已有显式 execution state machine，但 wave 选择、锁转换、fallback 激活、replan 恢复等决策还没有完全收敛到统一的 reducer / state transition 模型中。

这会带来几个问题：

- resume 仍偏保守
- 新增调度能力时容易把状态分散回编排层
- UI 与恢复逻辑仍需要从多个 artifact 反推运行时意图

当前已经开始把恢复相关元数据写入 `execution.state.json`，例如 `resumeStrategy`、`recoverySourceStepId`、`recoverySubgraphStepIds` 与 `lockResumeMode`。下一步重点不再是继续堆更多字段，而是定义更稳定的恢复规则和恢复边界，并让执行器更多地围绕这些字段初始化和推进，而不是依赖局部变量和隐式推导。

当前锁恢复已经从单纯的“保留/降级/丢弃”推进到了第一版 ownership-preserving 恢复：guarded owner 现在可以基于现有 ownership transfer 语义被识别为可复用，并通过 recovery metadata 对外可见。但这还不是最终形态，后续仍需要把 owner reuse、wave/lock 推进和恢复决策进一步收敛为更统一的状态推进模型。

### 2. resume 仍未完成 lock ownership 与 recovering 子图的精细恢复

当前从 execution artifacts 恢复时，active wave、fallback path，以及 partial planning window 的 completed-waiting-append 边界已经具备，但仍未完整覆盖：

- 更系统的局部锁所有权 / owner transfer 收敛
- recovering 中的局部子图状态
- partial planning window 执行中断后的恢复矩阵

这说明恢复链路已经越过最初的 reset-and-rerun 版本，但还没有达到成熟的图执行恢复模型。

### 3. 工具层仍缺 provider 生命周期与外部接入层

`ToolProvider` 抽象和 builtin provider 迁移已经落地，但后续要接入 LSP/MCP 或更多外部工具时，仍缺：

剩余结构性缺口主要是：

- provider 生命周期、权限边界和日志接口
- 外部 provider 配置与默认禁用策略
- 面向 diagnostics / symbols / references 这类只读能力的 provider 设计

在这一步完成前，不建议直接引入真实 LSP/MCP provider。

### 4. 语义冲突与 degraded 语义仍可继续细化

`conflictDomains`、`failureTolerance=degrade`、`dependencyTolerances` 与 degraded completion metadata 的基础能力已经落地，但并发语义仍有一个明确的后续收敛点：

- project-level conflict domain registry 或更强约束

这些不是当前主链路 blocker，但会影响后续并发质量和结果表达清晰度。

### 5. WebUI transport / inspector 仍未开始

当前 `PlannerViewModel`、`loadPlannerView()`、`loadPlannerEvents()`、`loadPlannerSessionSummary()` 与 `src/planner/read-api.ts` 已经形成稳定的只读 read-model / facade 基础。

但如果要支持真实 WebUI transport 或外部 inspector，仍缺：

- 更明确的 history/event 协议
- 面向外部工具的 machine-readable CLI / transport 入口

这应放在执行内核进一步稳定之后，而不是当前优先级最高的事项。

## 推荐优先级

### P0：补齐恢复规则闭环与精确恢复

这是最值得继续投入的主线。

目标：

- 让 `execution.state.json` 更接近调度与恢复的主要依据
- 把 wave/lock/fallback/replan 的更多决策纳入统一状态推进
- 将 resume 从“重置后重跑”提升到“按明确恢复规则继续执行”

建议任务：

1. 定义 ownership-preserving 恢复规则，而不只是保守地保留 guarded read、降级恢复子图写锁、丢弃无关活跃写锁。
2. 定义 `partial planning window` 的恢复边界，区分“当前窗口已完成但等待 append”与“当前窗口执行中断后继续恢复”。
3. 继续收口恢复快照和 dispatch snapshot 的构造入口，让执行器可以围绕 persisted execution state 初始化，而不是继续在编排层散落拼装上下文。
4. 为新的恢复规则和恢复边界补 deterministic manual-suite 覆盖，尤其是 active wave、recovering、fallback path、window boundary、verify 前后中断等场景。

完成标准：

- resume 不再默认把所有未完成步骤重置为 `PENDING`
- active wave、recovering、fallback path 与 planning window boundary 可被更精确恢复
- 恢复路径可以解释“为什么从这里继续跑，以及为什么保留/降级/丢弃某些锁 owner”

### P0.1：上一轮已完成落点

上一轮已经完成以下恢复主线落点：

1. 扩展恢复锁结果模型，新增“可安全复用 owner”的表达，并让恢复决策复用现有 ownership 语义。
2. 为 `partial planning window` 恢复定义显式 boundary mode，并把它写入 execution state / view model。
3. 为 dispatch snapshot 增加统一入口，减少恢复字段的分散同步。
4. 补 deterministic tests，覆盖 owner reuse、ineligible writer drop、completed window resume。

这些工作已经落地。下一轮不应继续扩字段，而应继续收口 execution snapshot / reducer / truth-source 边界。

### P0.2：上一轮已完成落点

上一轮已经完成以下恢复主线落点：

1. 把 execution dispatch snapshot helper 从薄包装推进为真正的单点构造入口。
2. 为 persisted recovery metadata 增加集中复制 helper，减少恢复字段散落展开。
3. 补 interrupted partial planning window 的恢复矩阵测试，覆盖 active wave 与 fallback recovery path。
4. 继续收口 `execute.ts` 中的 wave/window 运行时状态。

这些工作已经落地。下一轮不应继续堆恢复分支，而应继续把 execution state / runtime cursor / truth-source 的职责边界说清楚。

### P0.3：本轮已完成落点

本轮已经继续专注恢复主线，没有切到外部 provider。已完成的落点包括：

1. 明确 `execution.state.json` 中 persisted truth、runtime-derived、mixed 字段的分类，并把这套边界同步到代码与文档。
2. 继续精简 `execute.ts` 的局部运行时状态更新，把 runtime cursor helper 和 initial execution-state extras 收口到 `src/planner/execution-state.ts`。
3. 让 `recoveryStepId` / `recoveryReason` 进入 persisted recovery snapshot copy 路径，避免 dispatch snapshot 在恢复解释字段上再散落拼装。
4. 补 deterministic manual-suite 覆盖，新增 runtime cursor helper 与 initial execution-state extras helper case。

当前结论：owner reuse metadata 仍保持 step-level 语义，不继续扩展 path-level 恢复字段。路径级真相继续由 `execution.locks.json` 承担，`execution.state.json` 只保留恢复决策与解释所需的摘要 metadata。

完成这一轮后，恢复主线的下一步重点已经从“继续堆 resume 分支”转为“是否进入 provider 生命周期和首个只读外部能力接入”。

### P1：在 provider 边界上接入只读扩展能力

这是当前工具层演进的下一步，而不是重新设计 registry。

目标：

- 在不改变现有工具行为和安全边界的前提下，接入新的只读 provider 能力
- 让未来 LSP diagnostics / MCP bridge 复用现有 provider-compatible registry

建议任务：

1. 定义 provider 生命周期和 disposal 约定，而不只是静态注册。
2. 评估工具层命名是否需要从 `ToolProvider` 收敛为更不易与 `ModelProvider` 混淆的术语，例如 `ToolSource`。
3. 为外部 provider 增加默认禁用和显式 allowlist 的配置路径。
4. 先接入只读 diagnostics/symbols 能力，再评估更复杂的 MCP bridge。
5. 在 provider 层保留 policy、session logging、redaction 的统一挂点。

完成标准：

- 现有内置工具继续通过 provider 机制注册
- CLI / planner / agent / TUI 工具行为保持不变
- 接入首个只读 provider 时不需要再重做工具总线

### P1.1：本轮已完成基础落点

本轮先没有接入真实 LSP/MCP，而是完成了 provider 生命周期和只读能力接入所需的最小基础：

1. `ToolProvider` 增加 metadata/capabilities 表达，明确 `kind`、`access`、`description` 与能力摘要。
2. `ToolRegistry` 增加 provider id registry、`listProviders()`、`getProviderForTool()` 与 `disposeAll()` 生命周期入口。
3. 内置 builtin/planner provider 现在显式声明 `read_write` / `read_only` access metadata。
4. config schema 增加最小外部 provider 边界：`tools.externalProvidersEnabled=false` 与 `tools.allow=[]`。
5. 新增 deterministic readonly diagnostics fixture provider，用于验证 provider-compatible registry 可以接入新的只读能力而不改 agent/planner 调用路径。

这一轮的定位是 lifecycle foundation，而不是外部 provider 集成完成。下一轮如果继续推进 P1，应优先考虑：

- 是否把 `ToolProvider` 命名收敛为 `ToolSource`
- 是否为外部 provider 增加更明确的 policy/logging/redaction 挂点
- 首个真实 readonly diagnostics/symbols source 的加载方式

### P1.2：本轮已完成 external readonly provider hooks

在 P1.1 的 lifecycle foundation 之上，本轮继续补齐了 external readonly provider 的 host 接入钩子，但仍然没有接入真实 LSP/MCP：

1. 新增共享 `src/tools/setup.ts`，集中 agent/planner registry 构造与 extra provider 注册入口。
2. 新增 external provider gate：`metadata.kind === 'external'` 时必须满足 `tools.externalProvidersEnabled=true`、provider id 在 `tools.allow` 中，并且 access 为 `read_only`。
3. CLI / TUI / planner subtask / manual-suite helper 现在统一走 shared registry setup，并在实际调用路径上执行 `disposeAll()`。
4. 新增 deterministic external diagnostics fixture provider，以及 gate block / allowlist pass / dispose failure cases。

这一轮的定位是 external hook foundation，而不是生产级外部 provider 集成完成。下一轮如果继续推进 P1，应优先考虑：

- provider-level logging/redaction 挂点
- 首个真实 readonly diagnostics/symbols source 的加载与生命周期管理
- 是否再决定 `ToolProvider -> ToolSource` 的命名收敛

### P1.3：本轮已完成 provider logging/redaction hooks

在 P1.2 的 external hook foundation 之上，本轮继续补齐了 provider-level logging/redaction 的最小闭环，仍然没有接入真实 LSP/MCP：

1. `ToolRegistry` 增加 provider summary、provider-specific log sanitization，以及 `disposeAll()` 的返回 summary。
2. external provider gate 错误现在带上 provider id/kind/access，方便后续诊断和审计。
3. agent/planner 的 `tools.jsonl` 现在会记录 provider id、kind、access、capabilities，并允许 provider 自己对日志记录做最小 sanitize。
4. deterministic suite 增加 provider summary、gate access reason、dispose summary、tool log metadata 等覆盖。

这一轮的定位是 logging/redaction foundation，而不是生产级外部 provider 集成完成。下一轮如果继续推进 P1，应优先考虑：

- 首个真实 readonly diagnostics/symbols source 的加载与生命周期管理
- provider-level logging/redaction 是否需要继续收敛为共享 event/DTO 形状
- 是否再决定 `ToolProvider -> ToolSource` 的命名收敛

### P1.4：本轮已完成 local readonly diagnostics source

在 P1.3 的 logging/redaction foundation 之上，本轮继续补齐了第一个真实但本地的 readonly source，仍然没有接入真实 LSP/MCP：

1. 新增 `src/tools/local-diagnostics-provider.ts`，从 `.marblecode/diagnostics.json` 加载本地 diagnostics。
2. local diagnostics source 走现有 external provider gate、shared setup、provider metadata logging 和 sanitize hook，不再只是 deterministic fixture。
3. local source 对缺失 artifact 返回空结果，对 workspace escape 和无效 artifact 给出明确错误。
4. `src/tui/session-actions.ts` 现在也走 shared planner registry setup，并在实际路径上执行 `disposeAll()`。
5. deterministic suite 增加 local diagnostics source 的读取、过滤、缺失和 escape 覆盖。

这一轮的定位是 first local source foundation，而不是生产级外部 provider 集成完成。下一轮如果继续推进 P1，应优先考虑：

- 首个真实 readonly symbols/references source
- provider-level logging/redaction 是否需要继续收敛为共享 event/DTO 形状
- 是否再决定 `ToolProvider -> ToolSource` 的命名收敛

### P1.5：本轮已完成 local readonly symbols source

在 P1.4 的 first local source foundation 之上，本轮继续补齐了第二个真实但本地的 readonly source，仍然没有接入真实 LSP/MCP：

1. 新增 `src/tools/local-symbols-provider.ts`，从 `.marblecode/symbols.json` 加载本地 symbols。
2. local symbols source 继续走现有 external provider gate、shared setup、provider metadata logging 和 sanitize hook，证明 provider/source 抽象不只适用于 diagnostics。
3. local source 支持 `path`、`name`、`kind` 过滤，对缺失 artifact 返回空结果，对 workspace escape 和无效 artifact 给出明确错误。
4. agent/planner 的 tool logging 现在也会为 symbols capability 记录 `symbolsSource`，使 provider sanitize hook 走到真实日志路径上。
5. deterministic suite 增加 local symbols source 的读取、过滤、缺失、invalid format、escape 和 logging sanitize 覆盖。

这一轮的定位是 second local source foundation，而不是生产级外部 provider 集成完成。下一轮如果继续推进 P1，应优先考虑：

- 首个真实 readonly references/source-location source
- provider-level logging/redaction 是否需要继续收敛为共享 event/DTO 形状
- 是否再决定 `ToolProvider -> ToolSource` 的命名收敛

### P1.6：本轮已完成 local readonly references source

在 P1.5 的 second local source foundation 之上，本轮继续补齐了第三个真实但本地的 readonly source，仍然没有接入真实 LSP/MCP：

1. 新增 `src/tools/local-references-provider.ts`，从 `.marblecode/references.json` 加载本地 references/source-locations。
2. local references source 继续走现有 external provider gate、shared setup、provider metadata logging 和 sanitize hook，进一步验证 provider/source 抽象可以承载多种 readonly 索引数据。
3. local source 支持 `path`、`symbolName`、`kind` 过滤，对缺失 artifact 返回空结果，对 workspace escape、target workspace escape 和无效 artifact 给出明确错误。
4. agent/planner 的 tool logging 现在也会为 references capability 记录 `referencesSource`，使 provider sanitize hook 走到真实日志路径上。
5. deterministic suite 增加 local references source 的读取、过滤、缺失、invalid format、escape、target escape 和 logging sanitize 覆盖。

这一轮的定位是 third local source foundation，而不是生产级外部 provider 集成完成。下一轮如果继续推进 P1，应优先考虑：

- provider-level logging/redaction 是否需要继续收敛为共享 event/DTO 形状
- 是否再决定 `ToolProvider -> ToolSource` 的命名收敛
- 是否开始设计真实 LSP/MCP readonly source 的生命周期与错误模型

### P1.7：本轮已完成 provider tool-log DTO 收敛

在 P1.6 的 third local source foundation 之上，本轮优先收敛了 provider tool logging 的 host-side DTO 组装，而没有继续扩更多 source 类型：

1. 新增 `src/tools/logging.ts`，集中构造 agent/planner 共用的 provider tool log record。
2. agent/planner 不再各自手写 `providerId`、`providerKind`、`providerAccess`、`providerCapabilities` 以及 capability-specific source 字段。
3. `diagnosticsSource`、`symbolsSource`、`referencesSource` 现在由共享 helper 按 capability 统一生成，provider sanitize hook 仍然发生在 session redaction 之前。
4. deterministic suite 增加 tool log helper 的 provider metadata 与 capability source field 覆盖，同时保留现有 end-to-end sanitize 覆盖。

这一轮的定位是 logging DTO foundation，而不是生产级外部 provider 集成完成。下一轮如果继续推进 P1，应优先考虑：

- 是否再决定 `ToolProvider -> ToolSource` 的命名收敛
- 是否开始设计真实 LSP/MCP readonly source 的生命周期与错误模型
- provider-level logging/redaction 是否还需要继续抽象出更明确的 event schema

### P1.x：阶段性仓库整理候选项

在继续扩真实 readonly source 之前，当前仓库也已经出现几处值得阶段性整理但不需要大重写的热点。建议单独以一次低风险 refactor 回合处理，而不是混在功能开发中：

1. `src/tools/local-diagnostics-provider.ts`、`src/tools/local-symbols-provider.ts`、`src/tools/local-references-provider.ts` 已经形成明显重复，适合提取共享 local artifact helper。
2. `scripts/manual-suite/core.ts` 与 `scripts/manual-suite/planner-runtime.ts` 已经是测试侧上帝文件，后续继续堆 case 会让维护成本快速上升。
3. `src/session/index.ts -> src/planner/view-model.ts` 的依赖方向偏重，后续应考虑把 planner session summary 组合逻辑移出 session 基础层。
4. `src/planner/loop.ts`、`src/planner/view-model.ts`、`src/planner/replan-merge.ts` 仍然偏大，但应该只在对应功能继续演进时顺手按职责拆分，而不是先做无目标重写。

建议下一轮如果做“仓库整理”而不是新功能，优先顺序如下：

- 先收敛 local provider/local artifact 重复
- 再收敛 manual-suite fixture/setup 重复
- 然后才考虑 session/planner 依赖方向和 planner 大文件细拆

更细的审查结论与重构建议单独记录在 `docs/plans/repo-maintenance-review.zh-CN.md`，避免主路线图变成过长的审计文档。

### P1.8：本轮已完成 local artifact/provider 重复收敛

在前几轮 local readonly source foundation 之上，本轮优先收敛了 local artifact 读取与 manual-suite setup 重复，而没有继续扩 source 类型：

1. 新增 `src/tools/local-artifacts.ts`，集中处理 `.marblecode/*.json` artifact 的共享读取与 workspace path 归一化。
2. `src/tools/local-diagnostics-provider.ts`、`src/tools/local-symbols-provider.ts`、`src/tools/local-references-provider.ts` 不再各自手写相同的 artifact read / `ENOENT` / readable-path / workspace-escape 逻辑。
3. `scripts/manual-suite/helpers.ts` 新增 `enableExternalProvider(...)` 与 `writeMarbleArtifact(...)`，收敛 local provider tests 的 setup 与 artifact 写入重复。
4. deterministic suite 增加 local artifact helper 的 missing / workspace escape 覆盖，并保持现有 local provider 行为测试全部通过。

这一轮的定位是 low-risk maintenance foundation，而不是 planner 大模块重拆完成。下一轮如果继续推进“仓库整理”，应优先考虑：

- 收敛 `scripts/manual-suite/core.ts` 与 `scripts/manual-suite/planner-runtime.ts` 的结构压力
- 为 JSONL/tool log/planner event 增加 structured assertion helpers
- 再评估 `session -> planner/view-model` 依赖方向的修正边界

### P1.9：本轮已完成 structured JSONL / event assertion helpers

在 P1.8 的 low-risk maintenance foundation 之上，本轮继续优先收敛 manual-suite 中最脆弱的 JSONL/event 断言模式，而没有直接大拆测试文件：

1. `scripts/manual-suite/helpers.ts` 新增 `readJsonl(...)`、`assertJsonlRecord(...)`、`readSessionJsonl(...)`、`assertToolLogEntry(...)`、`assertPlannerEvent(...)`。
2. `scripts/manual-suite/core.ts` 中的代表性 `tools.jsonl` 断言已经从字符串 regex 改为 structured assertions。
3. `scripts/manual-suite/planner-execution.ts` 中的代表性 `plan.events.jsonl` 断言已经改为 structured planner event assertions。
4. deterministic suite 增加 JSONL helper 的基础覆盖，同时保持现有 session artifact 形状不变。

这一轮的定位是 test assertion foundation，而不是 manual-suite 结构减压完成。下一轮如果继续推进“仓库整理”，应优先考虑：

- 收敛 `scripts/manual-suite/core.ts` 与 `scripts/manual-suite/planner-runtime.ts` 的结构压力
- 为 planner artifact/session fixture 增加共享 builder，减少大块手写 JSON
- 再评估 `session -> planner/view-model` 依赖方向的修正边界

### P1.10：本轮已完成 manual-suite 结构减压第一步

在 P1.9 的 test assertion foundation 之上，本轮继续优先降低 manual-suite 上帝文件压力，但保持 case 名称、顺序与 suite 行为不变：

1. `scripts/manual-suite/core.ts` 现在只保留 case 聚合，具体实现拆到 `core-tools.ts`、`core-providers.ts`、`core-local-providers.ts`。
2. `scripts/manual-suite/planner-runtime.ts` 现在只保留 case 聚合，具体实现拆到 `planner-runtime-core.ts` 与 `planner-runtime-resume.ts`。
3. `scripts/test-examples.ts` 与外部 case 名称保持不变，因此 deterministic suite 的执行顺序和可见输出没有变化。
4. 这一轮没有改 session artifact shape、planner runtime 语义或 provider 行为，属于纯测试结构减压。

这一轮的定位是 suite structure foundation，而不是 planner fixture builder 完成。下一轮如果继续推进“仓库整理”，应优先考虑：

- 为 planner artifact/session fixture 增加共享 builder，减少大块手写 JSON
- 继续替换剩余 regex-style JSONL / event assertions
- 再评估 `session -> planner/view-model` 依赖方向的修正边界

### P1.11：本轮已完成 planner artifact / session fixture builder 第一轮

在 P1.10 的 suite structure foundation 之上，本轮继续优先收敛 planner resume / partial-window 相关测试里的手写 artifact fixture，同时保持 runtime 行为不变：

1. `scripts/manual-suite/helpers.ts` 新增 `createPlannerPlan(...)`、`createPlannerState(...)`、`createExecutionState(...)`、`createExecutionLocks(...)`、`writePlannerArtifacts(...)`、`writePlannerEvents(...)`。
2. `scripts/manual-suite/planner-runtime-resume.ts` 中代表性的 active-wave、fallback-path、owner-reuse、planning-window resume 场景，已经改为复用共享 fixture helper，而不再逐段手写 `plan.json` / `plan.state.json` / `execution.state.json` / `execution.locks.json`。
3. 部分 `plan.events.jsonl` regex 断言继续迁移为 `assertPlannerEvent(...)`，覆盖 invalid output、replanned、fallback subtask completed、model retry 等事件。
4. deterministic suite 新增 fixture helper 直接覆盖 case，确保这些 builder/write helper 本身也受回归保护。

这一轮的定位是 planner test fixture foundation，而不是 session/read-model 依赖方向收敛完成。下一轮如果继续推进“仓库整理”，应优先考虑：

- 继续替换剩余 regex-style JSONL / event assertions
- 在 `planner-execution.ts`、`tui.ts` 等仍有较多手写 artifact 的场景继续推广 fixture helper
- 再评估 `session -> planner/view-model` 依赖方向的修正边界

### P1.12：本轮已完成 structured event / log assertion sweep 第一轮

在 P1.11 的 planner test fixture foundation 之上，本轮继续优先收敛 manual-suite 中剩余最脆弱的事件和日志字符串断言，同时保持 runtime 行为不变：

1. `scripts/manual-suite/helpers.ts` 新增 `assertSessionJsonlRecord(...)` 与 `assertPlannerLogEntry(...)`，补齐 planner log 的结构化断言入口。
2. `scripts/manual-suite/planner-recovery.ts` 中 retry / fallback / local replan 相关 `plan.events.jsonl` 断言，已改为 `assertPlannerEvent(...)`。
3. `scripts/manual-suite/planner-runtime-core.ts` 中 read-only planner flow 的 `plan.events.jsonl`、`planner.log.jsonl`、`tools.jsonl` 代表性断言，已改为 `assertPlannerEvent(...)`、`assertPlannerLogEntry(...)` 与 `assertToolLogEntry(...)`。
4. `scripts/manual-suite/planner-runtime-resume.ts` 与 `scripts/manual-suite/planner-execution.ts` 中代表性的 model retry / failure、degraded 事件断言，也继续迁移为结构化 helper。
5. deterministic suite 新增 planner log helper 直接覆盖 case，确保新的 log assertion helper 本身也受回归保护。

这一轮的定位是 structured assertion maintenance foundation，而不是 TUI/session fixture 全面收敛完成。下一轮如果继续推进“仓库整理”，应优先考虑：

- 在 `planner-execution.ts`、`tui.ts` 中继续推广 shared planner fixture helper
- 评估 `session -> planner/view-model` 依赖方向的修正边界与最小落点
- 仅在确有收益时继续替换剩余零散 regex-style 断言

### P1.13：本轮已完成 TUI / read-model planner fixture 收敛第一轮

在 P1.12 的 structured assertion maintenance foundation 之上，本轮继续优先收敛 TUI/read-model 测试中的重复 planner session fixture，同时保留故意 malformed/partial 的手写场景：

1. `scripts/manual-suite/tui.ts` 中的正常 planner session setup 已开始复用 `createPlannerPlan(...)`、`createPlannerState(...)`、`createExecutionState(...)`、`writePlannerArtifacts(...)` 与 `writePlannerEvents(...)`。
2. `planner session resolution`、`recent session summaries`、`tui state refresh hydrates planner view`、`tui planner session actions`、`planner view loads delta and feedback artifacts`、`planner view loads replan rejection artifacts`、`planner view normalizes timeline events`、`planner session summary includes execution metadata` 等 case，不再重复手写基础 `plan.json` / `plan.state.json` / `plan.events.jsonl`。
3. `planner view tolerates partial artifacts` 和 `planner read-model api exposes raw and normalized events` 这类依赖 malformed/partial 或极小事件输入的场景，继续保留手写 fixture，避免 helper 掩盖测试意图。

这一轮的定位是 TUI fixture maintenance foundation，而不是 session/read-model 依赖方向收敛完成。下一轮如果继续推进“仓库整理”，应优先考虑：

- 评估 `session -> planner/view-model` 依赖方向的修正边界与最小落点
- 如有必要，在 `planner-execution.ts` 中继续推广 fixture helper
- 只对仍然明显重复的 fixture 再做小范围收敛，不追求把所有手写 artifact 全部抽象掉

### P1.14：本轮已完成 session / planner read-model 依赖方向收敛

在 P1.13 的 TUI fixture maintenance foundation 之上，本轮继续优先修正 `session -> planner/view-model` 的依赖方向，同时保持 TUI 行为不变：

1. `src/session/index.ts` 不再依赖 `src/planner/view-model.ts`，现在只负责 session 存储、recent session entry 列举和 planner session 识别。
2. 新增 `src/tui/recent-sessions.ts`，把 planner summary / child session summary 的 recent-session projection 上移到 TUI 层组合。
3. `src/tui/state.ts`、`src/tui/types.ts`、`src/tui/render.ts` 现在改为消费 TUI 层的 `SessionListItem`，而不是从 session 基础层拿 planner-rich 类型。
4. deterministic suite 新增 `session entries stay storage scoped`，明确锁定 session 基础 API 只返回 storage-scoped entry，而不混入 planner summary 字段。

这一轮的定位是 dependency-direction maintenance closeout，而不是 P2 planner execution 语义演进开始。下一轮如果继续推进，应优先考虑：

- 评估是否还需要单独做一轮 P1 收尾文档整理
- 否则切回 P2 degraded / conflict / concurrency semantics
- 仅在确有收益时继续处理 `planner-execution.ts` 中剩余少量重复 fixture

### P2.1：本轮已完成 degraded completion metadata 第一轮

在 P1.14 的 dependency-direction maintenance closeout 之后，本轮回到 planner execution 语义本身，先收敛 degraded completion 的结构化表达，而不改 `outcome: DONE` 的成功语义：

1. `src/planner/types.ts` 中的 `PlannerState` 新增 `degradedCompletion` 可选字段，用于明确标记“完成但带降级步骤”的结果。
2. `src/planner/execute.ts` 现在会在 degraded completion 时把 `degradedCompletion: true` 写入 `plan.state.json`，并在 `planner_execution_finished` event 中同时写入 `degradedCompletion` 和 `degradedStepIds`。
3. `src/planner/view-model.ts` 与 `src/tui/planner-view.ts` 现在会把 degraded completion 当作明确的 read-model 字段与展示信息，而不再只能从 `DONE + degradedStepIds` 间接推断。
4. deterministic suite 扩展了 degraded execution / view-model 覆盖，验证 state、finished event 和 planner view projection 的 degraded completion metadata。

这一轮的定位是 degraded outcome clarity foundation，而不是 dependency-level optional acceptance 完成。下一轮如果继续推进 P2，应优先考虑：

- dependency-level optional / degraded acceptance 的最小语义
- conflict domain / wave blocking 原因的更强解释性
- 仅在这些语义边界更稳定后，再评估 P3 read-model DTO 固化

### P2.2：本轮已完成 dependency-level degraded acceptance 第一轮

这一轮在不引入新的 `PlannerOutcome` 枚举、也不重写 `dependencies` 基本形状的前提下，先落地最小 dependency-level degraded acceptance 语义：

1. `src/planner/types.ts` 中的 `PlannerStep` 新增 `dependencyTolerances?: Record<string, 'required' | 'degrade'>`。
2. `src/planner/parse.ts` 现在会解析并校验 `dependencyTolerances`，只接受已声明 dependency 的 key，并把非法值归一为 `required`。
3. `src/planner/graph.ts` 现在允许非 `verify` 下游步骤在显式声明 `dependencyTolerances[dep]='degrade'` 时，接受一个 `failureTolerance=degrade` 且已失败的 dependency；`verify` 仍保持保守阻塞，不会被 degraded dependency 自动放行。
4. `src/planner/model.ts` 的 planner prompt 已加入 `dependencyTolerances` 指引，明确它只应用于显式声明的非 verify 下游场景。
5. deterministic suite 已新增 execution coverage，验证：
   - 非 verify 下游步骤可在显式 degraded acceptance 下继续执行
   - verify 不会因 degraded dependency 被自动放行
   - 未显式接受 degraded dependency 的下游步骤仍保持 blocked/failure 语义

这一轮的定位是 minimal dependency acceptance semantics，而不是 blocked/conflict explainability 完成。下一轮如果继续推进 P2，应优先考虑：

- `subtask_blocked` / `execution.state.json` / read-model 中更结构化的 blocked reason metadata
- conflict domain / active wave blocking 原因的更强解释性
- 仅在这些 execution 语义稳定后，再评估 P3 read-model DTO 固化

### P2.3：本轮已完成 blocked/conflict explainability 第一轮

这一轮不改调度策略、不改 state machine，也不引入新的 outcome 枚举，而是先把 execution explainability 的结构化 metadata 落到 artifact、event、read-model 与 TUI：

1. `src/planner/graph.ts` 新增 `PlannerBlockedReason` 与 `PlannerConflictSummary`，并提供 `getStructuredBlockedReasons()` / `findPendingConflictSummary()`。
2. `src/planner/execute.ts` 现在会：
   - 在 `subtask_blocked` event 中写入 `blockedReasons` 与 `blockedByStepIds`
   - 在 `subtask_conflict_detected` event 中写入 `fromStepId` / `toStepId` / `conflictReason` / `conflictDomain`
   - 在 `execution.state.json` 中写入 `blockedReasons` 与 `latestConflict`
   - 在 blocked terminal path 中使用真实 blocker summary，而不再只拼接全部 dependency id
3. `src/planner/view-model.ts` 与 `src/tui/planner-view.ts` 现在会直接投影并显示 `blockedReasons` / `latestConflict`。
4. deterministic suite 已扩展 execution 与 TUI/read-model 覆盖，验证结构化 blocked/conflict metadata 的写入、读取与 render。

这一轮的定位是 explainability foundation，而不是 P3 read-model DTO 固化完成。下一轮如果继续推进，应优先考虑：

- 是否把 `blockedReasons` / `latestConflict` 固化为 planner read-model DTO 的稳定字段
- 是否为 `conflictDomains` 增加更强约束或 registry，而不只是 explainability
- 仅在这些字段边界更稳定后，再进入更明确的 WebUI / external inspector read API

### P2：细化并发语义

这部分应在 P0/P1 后继续推进，而不是抢在前面。

目标：

- 提高并发执行质量
- 提高 degraded / conflict 的语义清晰度

建议任务：

1. 为 `conflictDomains` 增加更强约束或项目级 registry。
2. 在已落地的 degraded completion / dependency tolerance 语义之上，继续补 manual-suite 覆盖：same-domain conflict、optional docs failure、verify blocking 等。

完成标准：

- 同文件路径之外的语义冲突更容易表达
- degraded 结果不会和真正失败混淆
- 并发执行的限制原因能在 artifact / TUI 中更直接解释

### P3.4：本轮已完成 facade consumer wiring 第一轮

这一轮不新增 machine-readable CLI，也不引入 WebUI transport，而是先把已经存在的 planner read-only facade 接到真实运行时 consumer 上：

1. `src/planner/read-api.ts` 现在直接 re-export `loadPlannerSessionSummary()`，作为 TUI/planner read consumer 的统一入口之一。
2. `src/tui/recent-sessions.ts` 现在改为从 `read-api.ts` 引用 planner summary loader，而不再直接绕过 facade 依赖 `view-model.ts`。
3. 这一轮不改变 recent-session 行为、排序或非 planner session 路径，只收敛 read-only 依赖边界，并继续保持 deterministic suite 覆盖。

这一轮的定位是 facade wiring，而不是 machine-readable inspector 输出已经完成。下一轮如果继续推进 P3，应优先考虑：

- 是否为 `show:planner --json` 或类似 inspector CLI 输出真正复用 `loadPlannerSessionDetail()`
- 是否继续把其他 planner-only read consumers 收敛到 `read-api.ts`
- 仅在这些入口更清晰后，再评估更具体的 WebUI/transport 设计

### P3：产品化只读接口

这部分应建立在前面几项稳定之后。

目标：

- 稳定 read model 对外边界
- 为未来 WebUI 或外部调试工具预留接口形状

建议任务：

1. 固化 planner session summary / planner view / planner events 的 DTO 形状。
2. 如有必要，抽离独立 event normalizer 或 history protocol。
3. 在不引入完整 server 的前提下，先明确只读接口语义。

完成标准：

- UI 层不需要理解底层多 artifact 细节
- 外部读取 planner session 的协议可稳定复用

### P3.1：本轮已完成 read-model DTO stabilization 第一轮

这一轮不引入 WebUI server，也不改 execution 行为，而是先稳定现有 planner read-model 的字段边界与返回形状：

1. `src/planner/view-model.ts` 现在导出稳定的命名 DTO/view types，包括 `PlannerStepView`、`PlannerBlockedReasonView`、`PlannerConflictEdgeView`、`PlannerLatestConflictView`、`PlannerExecutionWaveView`、`PlannerLockEntryView` 与 `PlannerEventsView`。
2. `PlannerViewModel`、`PlannerSessionSummary`、`loadPlannerEvents()` 现在都带有 `schemaVersion: '1'`，为未来 WebUI / external inspector 提供明确的只读协议边界。
3. `PlannerSessionSummary` 现在直接暴露轻量但稳定的 execution-facing 字段，如 `degradedCompletion`、`blockedStepIds`、`degradedStepIds`，recent-session 层可直接复用，而无需重新理解 planner artifacts。
4. `loadPlannerView()` 现在对 blocked/conflict/lock/wave projection 使用更明确的 normalize helpers，而不再只依赖内联 object shape 与宽松 `as` cast。
5. deterministic suite 已扩展 read-model / TUI 覆盖，验证 `schemaVersion`、summary 字段与 DTO projection 的稳定行为。

这一轮的定位是 read-model boundary stabilization，而不是 external inspector/WebUI 接口已经开始。下一轮如果继续推进 P3，应优先考虑：

- 是否把 `loadPlannerView()` / `loadPlannerEvents()` / `loadPlannerSessionSummary()` 进一步整理成更明确的 external read API 入口
- 是否为 TUI recent-session / planner live 视图补充最小的 degraded/blocked badge polish
- 仅在这些只读边界更稳定后，再考虑更具体的 inspector/WebUI 适配

### P3.2：本轮已完成 read-model consumer convergence 第一轮

这一轮不新增 external API module，也不引入 WebUI server，而是先让现有 terminal/TUI consumers 更一致地消费 P3.1 稳定下来的 read-model DTO：

1. `scripts/show-planner.ts` 现在直接复用 `formatPlannerView()`，不再维护一份与 TUI planner panel 分叉的手写 terminal summary。
2. `src/tui/planner-live.ts` 现在抽出纯函数 `formatPlannerLiveView()`，并在 live view 中展示 `schemaVersion`、degraded status、blocked reasons、latest conflict、current wave / last completed wave 等稳定 DTO 字段。
3. deterministic suite 已新增 planner-live formatter 覆盖，验证 live consumer 对稳定 read-model 字段的投影，而不通过 stdout/raw terminal 副作用间接测试。

这一轮的定位是 consumer convergence，而不是 external inspector/WebUI read API 已经开始。下一轮如果继续推进 P3，应优先考虑：

- 是否把 `loadPlannerView()` / `loadPlannerEvents()` / `loadPlannerSessionSummary()` 整理成更明确的 external read API facade
- 是否为只读 inspector / WebUI 场景增加 session list + session detail 的更直接入口
- 仅在这些 API 边界更清晰后，再评估是否需要更正式的 transport/server 层

### P3.3：本轮已完成 external read API facade 第一轮

这一轮仍不引入 WebUI server，也不增加 transport 层，而是先把 planner session 的只读 list/detail 聚合入口从 TUI 组合层中抽出来：

1. 新增 `src/planner/read-api.ts`，提供 `listPlannerSessionSummaries()` 与 `loadPlannerSessionDetail()`。
2. facade 返回稳定的 `schemaVersion: '1'`，并以 planner session 为中心暴露：
   - recent planner session summaries
   - session detail summary
   - full planner view
   - normalized planner events/timeline
3. deterministic suite 已扩展 facade 覆盖，验证 planner-only recent list、session detail 聚合以及 `summary/view/events` 的统一 schemaVersion 边界。

这一轮的定位是 external-read preparation，而不是 WebUI/inspector transport 已经开始。下一轮如果继续推进 P3，应优先考虑：

- 是否需要为 `show:planner --json` 或类似脚本提供基于 facade 的 machine-readable 输出
- 是否为外部只读 inspector 场景进一步收敛 session list/detail/timeline 的 API 入口
- 仅在这些只读 API 更稳定后，再考虑更具体的 WebUI/transport 设计

## 暂不建议优先做的事

- 不建议重新展开已完成的 runtime/TUI/agent/verifier 拆分工作。
- 不建议优先做完整 WebUI server。
- 不建议在 provider 抽象之前直接接入真实 MCP/LSP。
- 不建议为 `conflictDomains` 过早引入复杂 taxonomy 配置。
- 不建议为了审计先补 `graph.delta.*`，除非 `plan.delta.*` 与现有 feedback 已经不足。

## 文档维护约定

- 已完成的大阶段不再长期保留在主路线图中。
- 当前行为变化应优先更新 `README.md` 与 `docs/project/*`。
- 本文只保留仍会影响下一步开发决策的事项。
