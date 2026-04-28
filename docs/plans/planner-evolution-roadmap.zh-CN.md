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

### 2. resume 仍未完成 lock ownership 与 recovering 子图的精细恢复

当前从 execution artifacts 恢复时，active wave 与 fallback path 的基础恢复已经具备，但仍未完整覆盖：

- 局部锁所有权
- recovering 中的局部子图状态
- partial planning window 之后的恢复边界

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

### P0：补齐执行状态闭环与精确恢复

这是最值得继续投入的主线。

目标：

- 让 `execution.state.json` 更接近调度与恢复的唯一依据
- 把 wave/lock/fallback/replan 的更多决策纳入统一状态推进
- 将 resume 从“重置后重跑”提升到“尽可能按原执行态恢复”

建议任务：

1. 扩展 execution-state artifact，显式记录恢复所需的更多中间元数据。
2. 让 active wave、fallback activation、recovery metadata 在 resume 时可直接消费，而不是只靠重新推导。
3. 将锁状态变化和 wave 收敛结果进一步收口到 execution machine 周围。
4. 为精确 resume 增加 manual-suite 覆盖，尤其是中断于 active wave / recovering / verify 前后的场景。

完成标准：

- resume 不再默认把所有未完成步骤重置为 `PENDING`
- active wave 与 recovering 状态可被更精确恢复
- 执行状态 artifact 足以解释“为什么从这里继续跑”

### P1：在 provider 边界上接入只读扩展能力

这是当前工具层演进的下一步，而不是重新设计 registry。

目标：

- 在不改变现有工具行为和安全边界的前提下，接入新的只读 provider 能力
- 让未来 LSP diagnostics / MCP bridge 复用现有 provider-compatible registry

建议任务：

1. 定义 provider 生命周期和 disposal 约定，而不只是静态注册。
2. 为外部 provider 增加默认禁用和显式 allowlist 的配置路径。
3. 先接入只读 diagnostics/symbols 能力，再评估更复杂的 MCP bridge。
4. 在 provider 层保留 policy、session logging、redaction 的统一挂点。

完成标准：

- 现有内置工具继续通过 provider 机制注册
- CLI / planner / agent / TUI 工具行为保持不变
- 接入首个只读 provider 时不需要再重做工具总线

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
