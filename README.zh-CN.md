# Coding Agent Core

一个面向本地 CLI 工作流的、小而稳、默认安全的 Coding Agent Core。

## 当前状态

当前仓库已经不是纯骨架，而是一个可以跑通基础闭环的 MVP：

- 支持 CLI 入口
- 支持配置加载
- 支持项目级 `.marblecode/` 配置加载
- 支持 OpenAI-compatible Provider
- 底层使用传统 `POST /chat/completions`
- 支持静态规则路由
- 支持上下文构建
- 支持粘贴代码片段和关键词检索上下文
- 支持工具注册和调用
- 支持结构化 Patch 预览、应用、回滚信息生成
- 支持替换/删除前自动备份原文件
- 支持路径和 Shell 策略控制
- 支持验证器
- 支持项目内 Markdown verifier 设计
- 支持本地 Session 日志和自动清理
- 支持模型连通性检查脚本
- 支持一次本地 smoke test，验证 Patch 驱动改码闭环

这个版本已经在当前仓库里验证过：

- 模型连通性检查返回了 `MODEL_OK`
- 真实执行过一次 coding 修改任务
- 修改后项目 `build` 仍然通过

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

先规划，再串行执行 subtask，直到 verifier 通过：

```bash
node dist/index.js plan "修复 src/math.js 中的 add 错误并通过 verify" --execute
```

带着新输入恢复 planner session：

```bash
node dist/index.js plan "保留现有导出结构" --session <session-id-or-path>
```

在终端里查看最近一次 planner 结果：

```bash
npm run show:planner -- --last
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
- `npm run test:examples`：运行手动触发的完整 examples 测试套件，覆盖 patch、verifier、rollback、shell 和权限检查
- `npm run check:model -- --model cheap`：检查当前配置下的模型、URL、Key 是否可用
- `npm run check:planner`：使用真实配置好的 planning model 在 `examples/manual-test-suite/planner-task.md` 上运行 planner 检查
- `npm run check:planner:execute`：在临时 manual suite workspace 上使用真实模型运行完整的 planner -> subagent -> verifier 串行链路
- `npm run show:planner -- --last`：在终端渲染 planner session 的计划摘要、事件时间线和当前子任务结果

## 配置说明

- `agent.config.jsonc` 仍然负责本地运行时配置，比如 provider、model 和本地策略
- `.marblecode/config.jsonc` 是项目级共享配置入口
- `.marblecode/verifier.md` 是共享 verifier 设计的推荐位置
- 项目配置可以覆盖 `context`、`policy`、`routing`、`session`、`verifier` 等共享运行参数
- 项目配置也可以通过 `env` 注入项目级 shell 环境变量
- 如果没有手动 verifier、JSON verifier 命令列表或 `.marblecode/verifier.md`，verifier 会回退到基于仓库内容的自动发现
- `agent.config.jsonc` 是本地配置文件，已经加入 `.gitignore`
- `providers.openai.baseUrl` 填你的兼容接口地址
- 当前 MVP 同时接受 `http://...` 和 `https://...`
- `providers.openai.apiKeyEnv` 推荐填写环境变量名
- 当前实现也兼容把真实 key 直接写进去做本地测试
- 如果模型名不同，修改 `models.cheap.model`、`models.code.model`、`models.strong.model`

## 上下文选择

- `--file path/to/file.ts`：把指定文件加入上下文
- `--paste "..."`：把粘贴代码作为 `[Pasted ~N lines #k]` 上下文项注入
- 如果没有提供 `--file`，系统会从请求和粘贴片段里提取查询词，对候选文件打分，并自动挑选最可能相关的 3 到 5 个文件
- 显式传入的 `--file` 永远排在上下文前面，并且优先级高于自动召回结果
- 模型还会收到一个 `Context selection summary` 摘要块，说明查询词和自动选中的候选文件
- 最近修改文件也会作为兜底上下文来源
- 如果当前上下文还不够，模型应继续用 `search_text`、`list_files`、`read_file` 搜索后再改动

## Planner

- `node dist/index.js plan "..."` 默认进入只读 planner 循环
- 加上 `--execute` 后，host 会在 planner 产出有效计划后按顺序执行 code/test/verify 步骤
- planner 模式只开放 `read_file`、`list_files`、`search_text`、`git_diff`
- planner 响应只允许 `plan`、`plan_update`、`tool_call`、`final`
- planner 遇到非法模型输出会最多自动重试 3 次，之后把 session 标记为失败
- planner 和 agent 的模型调用也会对 `429 rate limit`、超时、短暂 `5xx` 这类瞬时错误做退避重试
- planner session 会落盘 `plan.json`、`plan.state.json`、`plan.events.jsonl`、`planner.request.json`、`planner.context.packet.json`
- planner 还会写出 `planner.log.jsonl`，记录结构化 plan snapshot、非法输出重试和终态摘要
- 重试参数可放在 `session.modelRetryAttempts` 和 `session.modelRetryDelayMs`，默认是重试 3 次、基础等待 3 秒
- planner 支持通过 `--session` 或 `--last` 做基础恢复和 replan
- `planner.context.packet.json` 是后续 planner/subagent 共享上下文的显式格式；当前先作为稳定 artifact 输出，便于调试和未来 TUI 使用
- 可用 `npm run show:planner -- --session <session-id-or-path>` 或 `--last` 在终端查看当前计划、事件时间线和已记录的 subtask 执行结果

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
- `src/cli`：CLI 入口
- `src/agent`：主执行循环
- `src/provider`：模型抽象和 OpenAI-compatible Provider
- `src/router`：规则路由
- `src/context`：上下文选择
- `src/tools`：工具注册和内置工具
- `src/patch`：Patch 协议与应用
- `src/policy`：权限和 Shell 策略
- `src/verifier`：补丁后的验证执行
- `src/session`：本地会话记录
- `examples/snippets`：用于演示 coding 修改的简单代码片段
- `examples/verifier-fixture`：用于 verifier 冒烟验证的最小 TypeScript 测试项目
- `examples/manual-test-suite`：用于手动全量回归验证的 fixture 和说明文档
- `docs/mvp-v1.md`：MVP 架构和协议说明

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

- Shell 执行默认限制在当前工作区内
- 默认禁止高风险命令、联网命令和后台常驻模式
- 模型通过结构化 Patch 改码，不直接控制文件写入
- 更完整的架构和协议说明见 `docs/mvp-v1.md`
