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
