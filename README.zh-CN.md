# Coding Agent Core

一个面向本地 CLI 工作流的、小而稳、默认安全的 Coding Agent Core。

## 当前状态

当前仓库已经不是纯骨架，而是一个可以跑通基础闭环的 MVP：

- 支持 CLI 入口
- 支持配置加载
- 支持 OpenAI-compatible Provider
- 底层使用传统 `POST /chat/completions`
- 支持静态规则路由
- 支持上下文构建
- 支持工具注册和调用
- 支持结构化 Patch 预览、应用、回滚信息生成
- 支持路径和 Shell 策略控制
- 支持验证器
- 支持本地 Session 日志和自动清理
- 支持模型连通性检查脚本
- 支持一次本地 smoke test，验证 Patch 驱动改码闭环

这个版本已经在当前仓库里验证过：

- 模型连通性检查返回了 `MODEL_OK`
- 真实执行过一次 coding 修改任务
- 修改后项目 `build` 仍然通过

## 当前能力

- 以单 Agent 方式执行有限步数的编码任务
- 根据任务类型在 `cheap`、`code`、`strong` 模型档位之间切换
- 从显式文件和最近修改文件中构建有限上下文
- 默认排除敏感文件
- 提供 `read_file`、`list_files`、`search_text`、`run_shell`、`git_diff` 工具
- 模型不直接写文件，只输出结构化 Patch
- Patch 默认人工确认，可用 `--yes` 跳过
- Patch 应用后可执行 verifier
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

5. 运行一次 coding 任务

```bash
node dist/index.js run "修复 src/router/index.ts 里的路由逻辑" --file src/router/index.ts
```

跳过 Patch 确认：

```bash
node dist/index.js run "修复 src/router/index.ts 里的路由逻辑" --file src/router/index.ts --yes
```

6. 运行本地 smoke test

```bash
npm run smoke:edit
```

7. 检查模型是否可用

```bash
npm run check:model -- --model cheap
```

## 常用脚本

- `npm run build`：编译项目
- `npm run dev`：用 `tsx` 直接运行 CLI
- `npm run smoke:edit`：执行一个不依赖外部 API 的本地改码 smoke test
- `npm run check:model -- --model cheap`：检查当前配置下的模型、URL、Key 是否可用

## 配置说明

- `agent.config.jsonc` 是本地配置文件，已经加入 `.gitignore`
- `providers.openai.baseUrl` 填你的兼容接口地址
- 当前 MVP 同时接受 `http://...` 和 `https://...`
- `providers.openai.apiKeyEnv` 推荐填写环境变量名
- 当前实现也兼容把真实 key 直接写进去做本地测试
- 如果模型名不同，修改 `models.cheap.model`、`models.code.model`、`models.strong.model`

## 仓库结构

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
- `docs/mvp-v1.md`：MVP 架构和协议说明

## 说明

- Shell 执行默认限制在当前工作区内
- 默认禁止高风险命令、联网命令和后台常驻模式
- 模型通过结构化 Patch 改码，不直接控制文件写入
- 更完整的架构和协议说明见 `docs/mvp-v1.md`
