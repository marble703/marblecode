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

`conflictDomains` 和 `failureTolerance=degrade` 的基础能力已经落地，但更细的执行语义还未完成：

- project-level conflict domain registry 或更强约束
- dependency-level optional / degraded acceptance
- 更清晰的 degraded outcome 表达，而不只是 `FAILED + degradedStepIds`

这些不是当前主链路 blocker，但会影响后续并发质量和结果表达清晰度。

### 5. WebUI 产品化接口仍未开始

当前 `PlannerViewModel`、`loadPlannerView()`、`loadPlannerEvents()`、`loadPlannerSessionSummary()` 已经形成共享 read model。

但如果要支持 WebUI 或外部读取，还缺：

- 稳定的只读 API/DTO 边界
- 更明确的 history/event 协议
- 面向外部消费者的 session 查询接口

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

### P2：细化并发语义

这部分应在 P0/P1 后继续推进，而不是抢在前面。

目标：

- 提高并发执行质量
- 提高 degraded / conflict 的语义清晰度

建议任务：

1. 为 `conflictDomains` 增加更强约束或项目级 registry。
2. 为 degraded 场景定义更清晰的 outcome/message 语义。
3. 评估是否需要 dependency-level optional / degraded acceptance。
4. 继续补 manual-suite 覆盖：same-domain conflict、optional docs failure、verify blocking 等。

完成标准：

- 同文件路径之外的语义冲突更容易表达
- degraded 结果不会和真正失败混淆
- 并发执行的限制原因能在 artifact / TUI 中更直接解释

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
