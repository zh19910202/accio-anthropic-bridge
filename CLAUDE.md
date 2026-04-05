# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Accio Anthropic Bridge —— 将 Anthropic / OpenAI 风格的 API 请求桥接到 Accio 本地登录态与网关。对外暴露 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 最小可用子集，同时服务 Claude Code（走 Accio/Claude 账号池）和 Codex（走独立凭证池）两个主题。

Node.js >= 22，纯 CommonJS，零 npm 依赖（主项目），`node:test` 内置测试。

## 常用命令

```bash
npm start                # 启动 bridge（首次无 .env 自动执行 setup）
npm test                 # 运行所有测试：node --test 'test/**/*.test.js'
npm run check            # 语法检查 + 测试
npm run check:syntax     # 仅语法检查（find src scripts -name '*.js' -exec node --check {} +）

# 单个测试
node --test test/direct-llm.test.js

# 桌面壳
npm run desktop:install  # 安装 desktop 依赖
npm run desktop:start    # 开发态启动 Electron
npm run desktop:check    # 桌面壳语法检查
```

## 架构

### 启动链

`src/start.js` → 检查 `.env` 是否存在（无则调 `scripts/init-env.js`） → `src/bootstrap.js`（加载 `.env`） → `src/server.js`（`main()` 构建所有依赖，创建 HTTP server）

### 双主题路由

请求按端点自动分流到不同主题和账号池：

| 端点 | 主题 | 账号池 | 处理模块 |
|------|------|--------|----------|
| `POST /v1/messages` | Claude Code | `config/accounts.json` | `routes/anthropic.js` |
| `POST /v1/chat/completions` | Codex | `config/codex-accounts.json` | `routes/openai.js` |
| `POST /v1/responses` | Codex | `config/codex-accounts.json` | `routes/openai.js` |

### 传输层决策（Transport Selection）

每个请求在两层传输间选择：

1. **DirectLlmClient** (`direct-llm.js`)：直连上游 LLM 网关，支持多账号 failover、额度预检、自动 token 刷新、standby 池（主路径）
2. **ExternalFallbackPool** (`external-fallback.js`)：外部兜底渠道（OpenAI/Anthropic 第三方端点），Direct 失败或 thinking 模式不可用时启用

选择逻辑在 `routes/anthropic.js` 和 `routes/openai.js` 的 `selectXxxTransport()` 函数中。

> 注：`AccioClient` (`accio-client.js`) 是早期通过 Accio 本地 WebSocket 网关代理的传输层，代码仍保留但当前路由已不再走此路径。

### 核心模块

| 模块 | 职责 |
|------|------|
| `auth-provider.js` | Claude 账号池管理（round_robin / random / fixed 策略） |
| `codex-auth-provider.js` | Codex 独立账号池管理 |
| `direct-llm.js` | 直连上游 — 含 SSE 解析、账号 failover、standby 凭证预热、额度预检 |
| `external-fallback.js` | 外部兜底渠道 — 支持 OpenAI/Anthropic 多协议探测 |
| `bridge-core.js` | 共享的请求编排逻辑（session binding、transport 选择） |
| `gateway-manager.js` | Accio 本地网关自动拉起与健康检查 |
| `session-store.js` | Session → Conversation 映射持久化（JSON 文件） |
| `models.js` / `model.js` | 模型注册、别名解析（`config/model-aliases.json`） |
| `stream/` | SSE 流式写入器（`anthropic-sse.js`、`openai-sse.js`、`responses-sse.js`） |
| `routes/admin.js` | Web 管理台 API 与前端页面 |
| `runtime-config.js` | 从环境变量构建配置对象 |

### 账号 Failover 机制

`DirectLlmClient.run()` 实现多账号 failover 循环：
- 按 `AuthProvider` 策略选账号 → 额度预检 → 请求上游 → 失败时 invalidate 当前账号并尝试下一个
- 可 failover 的错误码：401/403/429/503/529
- standby 池后台定时刷新凭证和额度状态，failover 时优先从已验证的 prepared 池取账号

### 配置来源

- `.env`：主配置文件（首次由 `scripts/init-env.js` 自动生成）
- `config/accounts.json`：Claude 账号池
- `config/codex-accounts.json`：Codex 账号池
- `config/model-aliases.json`：模型名映射
- 运行时数据写入 `.data/`（sessions、traces、auth state）

## 编码约定

- 纯 CommonJS（`require` / `module.exports`），不使用 ESM
- 无 TypeScript，无编译步骤
- 使用 `node:` 前缀引用内置模块
- 测试文件放 `test/` 目录，命名 `*.test.js`，使用 `node:test` + `node:assert`
- 脚本文件放 `scripts/` 目录
- 错误处理统一通过 `errors.js` 分类和 `anthropic.js` 的 `buildErrorResponse()` 输出
- 日志通过 `logger.js` 的结构化输出
