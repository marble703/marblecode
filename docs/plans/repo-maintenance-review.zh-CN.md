# 阶段性仓库整理审查

## 背景

这一轮审查的目标不是重新设计系统，而是判断当前仓库是否已经出现：

- 上帝文件
- 模块耦合过重
- 类型定义膨胀
- 不合理依赖方向
- 重复模式
- 不合理测试用例
- 滥用全局状态

结论是：需要做部分重构，但不建议做大范围重写。当前仓库整体方向仍然健康，优先级最高的是“收敛重复”和“降低测试维护成本”，而不是结构大换血。

## 总结结论

建议单独安排一次低风险整理回合，优先处理：

1. local readonly provider 的重复模式
2. manual-suite 中过大的测试文件与 fixture/setup 重复
3. `session -> planner/view-model` 的依赖方向问题

暂不建议优先处理：

1. `ToolProvider -> ToolSource` 全量 rename
2. planner 大模块的无目标拆分
3. 真实 LSP/MCP source 接入前的大规模抽象重写

## 主要发现

### 1. 测试侧已经出现上帝文件

高优先级：

- `scripts/manual-suite/planner-runtime.ts`
  - 当前体量很大，混合 runtime helper、state machine、resume/recovery、artifact mutation、model retry 等不同层级测试。
  - 后续 planner artifact schema 变化时，这个文件会变成最脆弱的维护点之一。
- `scripts/manual-suite/core.ts`
  - 当前同时承载 tool registry、provider lifecycle、tool logging、local diagnostics/symbols/references、context、git、shell、policy 等多类测试。
  - 最近 P1.4/P1.5/P1.6/P1.7 的新增 case 都自然堆进了这个文件，继续增长会越来越难读。

建议：

- `planner-runtime.ts` 后续拆分为更聚焦的 runtime/resume/retry/artifact 组
- `core.ts` 至少先把 local provider / tool logging / shell-git-policy 测试分开

### 2. local provider 已形成明确重复模式

高优先级：

- `src/tools/local-diagnostics-provider.ts`
- `src/tools/local-symbols-provider.ts`
- `src/tools/local-references-provider.ts`

三者都重复了：

- `.marblecode/*.json` artifact 路径拼装
- `policy.assertReadable(...)`
- 读取 JSON
- `ENOENT` 返回空结果
- artifact version/list 校验
- workspace escape 校验
- relative path 归一化
- provider sanitize hook 的相同结构

这类重复比“代码风格重复”更值得处理，因为它同时涉及安全边界与错误处理一致性。

建议：

- 增加 `src/tools/local-artifacts.ts` 或等价 helper
- 只抽共享读取/路径校验逻辑，不急着抽过滤逻辑
- 保持外部 tool 名称、artifact 格式、错误文案尽量稳定

### 3. session 模块依赖方向不理想

中高优先级：

- `src/session/index.ts` 当前依赖 `src/planner/view-model.ts`

这会让 session 这种基础持久化模块反向依赖 planner 的 read-model / view-model 语义。虽然当前功能能工作，但从长期结构看不够干净。

建议方向：

- `session` 只负责 session 存储、解析、列举
- planner summary / recent session projection 由更高层组合
- TUI 或独立 read-model service 负责把 session 与 planner summary 合成展示数据

### 4. planner 仍有几个偏大的核心模块

中优先级：

- `src/planner/loop.ts`
- `src/planner/view-model.ts`
- `src/planner/replan-merge.ts`
- `src/planner/execute.ts`

它们的问题不是“已经失控”，而是继续增长会接近新的维护边界。

当前判断：

- 不建议现在无目标重拆
- 建议在下一次触碰对应功能时顺手继续细拆
- 应优先补共享 helper，而不是先追求文件尺寸本身

### 5. planner 类型有 optional-field 膨胀趋势

中优先级：

- `src/planner/types.ts` 中的 `PlannerStep`

`PlannerStep` 当前同时承载：

- 规划定义字段
- 执行状态字段
- fallback/recovery 字段
- conflict/ownership 字段
- subtask context 字段

这类类型暂时还能用，但已经进入“后续需要分层”的区间。

当前不建议立刻重构，因为这会波及很多模块和测试。

更合理的时机：

- P2 并发语义继续演进前
- 或者真实 LSP/MCP source 进入 planner 执行语义之前

### 6. 测试中存在一些脆弱模式

中优先级：

- 并发测试用 `setTimeout(...)` 证明 overlap，存在潜在 flaky 风险
- 多处通过 regex 断言 JSONL 日志，而不是结构化解析
- 手写 planner artifacts JSON 较多，schema 变化时联动面大

建议：

- 增加 barrier/latch helper 替代 sleep 式并发证明
- 增加 `readJsonl()` / `assertToolLogEntry()` / `assertPlannerEvent()` helper
- 增加 planner artifact fixture builder，降低 inline JSON 重复

### 7. 全局状态没有严重滥用

低优先级 / watchlist：

- `process.env`
- `process.cwd()`
- `Date.now()`
- `new Date()`

这些主要出现在 CLI/session/provider/policy 合理边界内，目前没有看到明显失控。未来如果要进一步提升 deterministic tests，可以考虑注入 clock/env reader，但不是近期阻塞项。

## 推荐整理顺序

### 第一阶段：低风险收敛重复

建议优先做：

1. 为 local diagnostics/symbols/references 提取共享 local artifact helper
2. 为 manual-suite local provider tests 提取 setup/artifact helper
3. 保持现有 artifact shape / 错误文案 / tools.jsonl 字段不变

这一步的收益最大，风险最小。

### 第二阶段：测试结构减压

建议随后做：

1. 拆 `scripts/manual-suite/core.ts`
2. 拆 `scripts/manual-suite/planner-runtime.ts`
3. 引入 structured JSONL assertion helpers
4. 引入 planner artifact fixture builders

这一步主要是降低未来迭代成本，而不是改变产品行为。

### 第三阶段：依赖方向与 planner 细拆

建议最后做：

1. 处理 `session -> planner/view-model` 依赖方向
2. 视后续开发路径再拆 `planner/loop.ts`
3. 视后续开发路径再拆 `planner/view-model.ts`
4. 视后续开发路径再拆 `planner/replan-merge.ts`

这一步应跟随真实需求，不建议脱离功能演进单独大做。

## 建议的下一轮小目标

如果下一轮专门做“仓库整理”，建议目标控制在：

### P1.8：local artifact/provider 重复收敛

建议内容：

1. 新增 `src/tools/local-artifacts.ts`
2. 重构：
   - `src/tools/local-diagnostics-provider.ts`
   - `src/tools/local-symbols-provider.ts`
   - `src/tools/local-references-provider.ts`
3. 在 manual-suite helper 中增加：
   - `enableExternalProvider(config, providerId)`
   - `writeMarbleArtifact(workspaceRoot, fileName, payload)`
4. 用现有 local provider cases 验证行为不变

目标是减少重复与安全边界复制，而不是引入新的抽象层级。

当前状态：已完成。

本轮已经实际落地：

- `src/tools/local-artifacts.ts`
- local diagnostics/symbols/references provider 的共享 artifact/path helper 接入
- manual-suite local provider setup/artifact helper
- local artifact helper 的 deterministic tests

后续仓库整理重点应转向：

1. `scripts/manual-suite/core.ts` 与 `scripts/manual-suite/planner-runtime.ts` 的结构减压
2. JSONL / planner events 的 structured assertion helpers
3. `session -> planner/view-model` 依赖方向收敛

当前状态更新：structured assertion helpers 已完成第一轮落地。

本轮已经实际落地：

- `readJsonl(...)`
- `assertJsonlRecord(...)`
- `readSessionJsonl(...)`
- `assertToolLogEntry(...)`
- `assertPlannerEvent(...)`
- `core.ts` / `planner-execution.ts` 中代表性 JSONL 断言迁移

因此后续仓库整理重点应进一步转向：

1. `scripts/manual-suite/core.ts` 与 `scripts/manual-suite/planner-runtime.ts` 的结构减压
2. planner artifact / session fixture builder
3. `session -> planner/view-model` 依赖方向收敛

当前状态更新：manual-suite 结构减压第一步已完成。

本轮已经实际落地：

- `core.ts -> core-tools.ts / core-providers.ts / core-local-providers.ts`
- `planner-runtime.ts -> planner-runtime-core.ts / planner-runtime-resume.ts`
- case 名称、顺序与 deterministic suite 总数保持不变

因此后续仓库整理重点应进一步转向：

1. planner artifact / session fixture builder
2. 剩余 regex-style JSONL / event assertions 的 structured migration
3. `session -> planner/view-model` 依赖方向收敛

当前状态更新：planner artifact / session fixture builder 第一轮已完成。

本轮已经实际落地：

- `createPlannerPlan(...)`
- `createPlannerState(...)`
- `createExecutionState(...)`
- `createExecutionLocks(...)`
- `writePlannerArtifacts(...)`
- `writePlannerEvents(...)`
- `planner-runtime-resume.ts` 中代表性 resume / partial-window fixture 迁移

因此后续仓库整理重点应进一步转向：

1. 剩余 regex-style JSONL / event assertions 的 structured migration
2. `planner-execution.ts` / `tui.ts` 中仍然手写较多的 planner artifact fixture 继续收敛
3. `session -> planner/view-model` 依赖方向收敛

当前状态更新：structured event / log assertion sweep 第一轮已完成。

本轮已经实际落地：

- `assertSessionJsonlRecord(...)`
- `assertPlannerLogEntry(...)`
- `planner-recovery.ts` 中 retry / fallback / local replan event 断言迁移
- `planner-runtime-core.ts` 中 planner events / planner log / tools log 代表性断言迁移
- `planner-runtime-resume.ts` 中 model retry / failure planner log 断言迁移
- `planner-execution.ts` 中 degraded event 断言迁移

因此后续仓库整理重点应进一步转向：

1. `planner-execution.ts` / `tui.ts` 中仍然手写较多的 planner artifact fixture 继续收敛
2. `session -> planner/view-model` 依赖方向收敛
3. 只在有明确收益时继续清理剩余零散 regex-style 断言

当前状态更新：TUI / read-model planner fixture 收敛第一轮已完成。

本轮已经实际落地：

- `tui.ts` 中多处正常 planner session fixture 改为复用 `writePlannerArtifacts(...)` / `writePlannerEvents(...)`
- `createPlannerPlan(...)` / `createPlannerState(...)` / `createExecutionState(...)` 在 TUI/read-model case 中得到进一步复用
- 依赖 malformed / partial artifact 的场景继续保留手写 setup

因此后续仓库整理重点应进一步转向：

1. `session -> planner/view-model` 依赖方向收敛
2. 仅在确有收益时继续收敛 `planner-execution.ts` 等剩余重复 fixture
3. 避免为了“统一风格”而抽象掉故意 malformed/partial 的测试输入

当前状态更新：`session -> planner/view-model` 依赖方向收敛已完成。

本轮已经实际落地：

- `src/session/index.ts` 不再 import `loadPlannerSessionSummary(...)`
- session 基础层现在只暴露 storage-scoped `listRecentSessionEntries(...)`
- recent session summary projection 上移到 `src/tui/recent-sessions.ts`
- TUI 侧 `SessionListItem` 类型和 recent session 组合逻辑不再挂在 session 基础层
- 新增 deterministic case：`session entries stay storage scoped`

因此后续仓库整理重点应进一步转向：

1. 若无新的结构性热点，可视为当前 P1 维护整理主线基本收口
2. 如有明确收益，再小范围处理 `planner-execution.ts` 等剩余少量 fixture 重复
3. 后续优先级应转回 P2 planner execution 语义演进或 P3 read-model DTO 稳定化，而不是继续做无目标整理

当前状态更新：degraded completion metadata 第一轮已完成。

本轮已经实际落地：

- `PlannerState.degradedCompletion`
- degraded completion 时 `plan.state.json` 的结构化标记
- `planner_execution_finished` event 中的 `degradedCompletion` / `degradedStepIds`
- `PlannerViewModel` / TUI planner view 对 degraded completion 的直接投影
- degraded execution / read-model deterministic 覆盖扩展

因此后续优先级应进一步转向：

1. dependency-level optional / degraded acceptance 的最小语义
2. conflict domain / blocked wave 原因的更强解释性
3. 在这些 execution 语义更稳定后，再进入 P3 read-model DTO 固化

当前状态更新：dependency-level degraded acceptance 第一轮已完成。

本轮已经实际落地：

- `PlannerStep.dependencyTolerances?: Record<string, 'required' | 'degrade'>`
- parse/consistency checks 对 dependency tolerance key 的校验
- graph readiness 对显式 degraded dependency acceptance 的最小支持
- `verify` 继续保持保守阻塞，不会因 degraded dependency 自动放行
- deterministic execution 覆盖新增 required / degraded-accepted / verify-blocked 三类路径

因此后续优先级应进一步收敛到：

1. blocked reason / conflict reason 的更结构化 metadata
2. active wave / conflict domain 限制原因的更强可解释性
3. 在这些 execution 语义稳定后，再进入 P3 read-model DTO 固化

当前状态更新：blocked/conflict explainability 第一轮已完成。

本轮已经实际落地：

- `PlannerBlockedReason` / `PlannerConflictSummary` 结构
- `execution.state.json` 中的 `blockedReasons` / `latestConflict`
- `subtask_blocked` / `subtask_conflict_detected` event 的结构化 explainability metadata
- `PlannerViewModel` / TUI planner view 对 blocked/conflict explainability 的直接投影
- deterministic execution + TUI/read-model 覆盖扩展

因此后续优先级可以进一步转向：

1. planner read-model DTO 的稳定字段边界
2. `conflictDomains` 的更强约束或 registry（若确有必要）
3. 在这些字段稳定后，再进入只读 WebUI / external inspector 接口

当前状态更新：read-model DTO stabilization 第一轮已完成。

本轮已经实际落地：

- `PlannerViewModel` / `PlannerSessionSummary` / `PlannerEventsView` 的 `schemaVersion: '1'`
- `PlannerStepView` / `PlannerBlockedReasonView` / `PlannerLatestConflictView` 等命名 DTO/view types
- summary 层对 `degradedCompletion` / `blockedStepIds` / `degradedStepIds` 的稳定投影
- read-model normalizer helper 收敛，减少内联 shape / 宽松 cast
- deterministic TUI/read-model 覆盖扩展

因此后续优先级可继续收敛到：

1. external inspector / WebUI 前置只读 API 边界
2. recent-session / planner-live 的轻量 UI polish（如确有收益）
3. `conflictDomains` registry 仅在出现明确约束需求时再做

当前状态更新：read-model consumer convergence 第一轮已完成。

本轮已经实际落地：

- `show:planner` 对 `formatPlannerView()` 的复用
- `planner-live` 的纯 formatter 抽取与稳定 DTO 消费
- planner-live 对 degraded/blocked/conflict/current-wave 状态的更直接展示
- deterministic TUI 覆盖新增 live formatter case

因此后续优先级可以进一步转向：

1. external inspector / WebUI 前置只读 API facade
2. session list / session detail 的更直接 read API 入口
3. `conflictDomains` registry 继续后置，除非出现明确约束需求

当前状态更新：external read API facade 第一轮已完成。

本轮已经实际落地：

- `src/planner/read-api.ts`
- planner-only recent session summary list facade
- planner session detail facade（summary/view/events 聚合）
- deterministic facade 覆盖新增

因此后续优先级可继续收敛到：

1. machine-readable inspector/CLI 输出（如确有必要）
2. 只读 WebUI / inspector 的 session list/detail/timeline API 进一步收敛
3. `conflictDomains` registry 继续后置，除非出现明确约束需求

## 暂不建议优先做的事

- 不建议为了“文件看起来更小”而重拆 planner 核心逻辑
- 不建议现在就做 `ToolProvider -> ToolSource` rename
- 不建议把 local providers 过度抽象成复杂框架
- 不建议在没有明确需求前引入 clock/env 注入体系
- 不建议为了测试整洁度就一次性重写整套 manual-suite

## 文档用途

这份文档是阶段性维护审查记录，用来支撑后续“是否值得做整理回合”的决策。

它不是：

- 产品路线图主文档
- 逐项必须执行的硬承诺
- 立即开始的大重构计划

后续如果某个建议真正进入实施，再把对应条目收敛回主路线图即可。
