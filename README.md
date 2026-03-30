# Accio Anthropic Bridge

把 Anthropic / OpenAI 风格请求桥接到 Accio 本地登录态和网关的本地代理。

- Anthropic Messages API + OpenAI Chat Completions + Responses 最小子集
- 优先直连 `phoenix-gw`，回退到 Accio 本地 WebSocket，必要时再落到外部 OpenAI / Anthropic 兼容上游
- 多账号轮询 / failover / 本机快照管理
- 可视化管理台 + Electron 桌面壳

## 免责申明

- 这是非官方、逆向分析得到的桥接方案，不代表 Accio、Anthropic、OpenAI 或阿里巴巴的官方立场
- Accio 本地接口、上游网关协议、模型名、认证字段都可能随桌面端版本更新而失效，不承诺长期稳定
- 本项目会复用你当前机器上的 Accio 登录态；暴露日志、调试输出、代理请求可能间接泄露认证信息
- 是否允许这样复用登录态取决于你自己的使用场景以及相关服务条款；合规、风控、账号封禁等风险由使用者自行承担
- 如果你将本项目用于商业用途，因此引发的后果均由使用者自行承担
- 本项目仅适合本地研究、协议验证和个人实验环境
- 如果你不清楚某条调用是否会触发上游计费、审计或风控，请先不要使用

## 快速开始

需要 Node.js >= 22 和本机已安装 Accio 桌面端。

```bash
git clone <this-repo> && cd accio-anthropic-bridge
npm start
```

`npm start` 会先检查是否有 `.env`：没有时自动执行 `npm run setup` 扫描本机 `~/.accio` 生成配置；已有则直接启动。

默认监听 `http://127.0.0.1:8082`。

### Claude Code 接入

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
export ANTHROPIC_API_KEY=dummy
claude
```

`ANTHROPIC_API_KEY` 只是为了满足客户端本地校验，代理本身不校验。

### 其他客户端

```bash
# Anthropic Messages
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"accio-bridge","max_tokens":256,"messages":[{"role":"user","content":"请只回复 OK"}]}'

# OpenAI Chat Completions
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"accio-bridge","messages":[{"role":"user","content":"请只回复 OK"}]}'
```

## 管理台

浏览器打开 `http://127.0.0.1:8082/admin`，或：

```bash
npm run manager:open
```

![Accio Bridge 管理台截图](79a3e769-88da-48aa-aab6-1078cf20d5bb.png)

管理台支持：

- 查看网关状态和当前用户（脉冲指示灯实时反馈）
- 查看每个已记录账号的额度状态和刷新倒计时（短 TTL 缓存）
- 通过浏览器完成多账号 OAuth 登录，登录完成后自动记录快照
- 保存、切换和删除本机账号快照
- 配置外部兜底上游，支持 `OpenAI compatible` 和 `Anthropic Messages` 两种协议
- 在保存前直接测试外部上游连通性
- API Key 明文/密文切换、桌面端粘贴兼容、删除双击确认、自动消息提示等交互

## 桌面壳（Electron）

```bash
npm run desktop:install
npm run desktop:start
```

桌面壳会：

- 检查本地 bridge 是否已在线；没起来就自动从仓库目录拉起 `node src/start.js`
- 把管理台 `/admin` 嵌进桌面窗口
- 启动本地 desktop helper server（默认 `127.0.0.1:8090`），支持 HTTP 触发 Accio 桌面端拉起
- 只在"自己拉起了 bridge"时退出才一并结束子进程

说明：当前是本地桌面壳，不是已打包的 `.app` / `.exe`。第一次使用前需要先 `npm run desktop:install`。

## 当前支持

### Anthropic 兼容

- `POST /v1/messages` — 非流式 + SSE 流式
- `POST /v1/messages/count_tokens`
- 原生 `tool_use` / `tool_result`
- 直连上游 SSE 透传
- 外部 Anthropic fallback 返回 JSON 时自动合成为 Anthropic SSE，兼容 `Claude Code`

### OpenAI 兼容

- `GET /v1/models`
- `POST /v1/chat/completions` — 非流式 + SSE 流式
- `POST /v1/responses` 最小可用子集，含基础 streaming
- `tools` / `tool_calls`

### 仍然不是完整兼容

- OpenAI 兼容接口是"OpenAI 协议适配 + Claude 上游执行"
- `/v1/responses` 未补齐 reasoning item 等完整事件语义
- 图片 block 只做 URL / base64 级别最小映射
- Anthropic `thinking` 目前仅在 `direct-llm` 路径受理，`local-ws` 路径仍不支持
- 外部 fallback 主要定位为文本兜底；tools / 图片等复杂语义不承诺完整跨协议保持
- 上游是否正式、稳定支持 reasoning 字段目前未知；以下仅是当前环境下的实测观察，不构成官方能力声明：Gemini 在 `include_thoughts + thinking_level` 下可观察到 `thoughtSignature` / `thoughtsTokenCount`；GPT 目前只观察到 `reasoning_tokens` 统计；Claude 目前未确认存在可见 thinking 输出
- 响应缓存只覆盖低风险纯文本请求

## 认证与账号管理

### 认证来源

通过 `ACCIO_AUTH_MODE` 控制：

| 模式 | 说明 |
|------|------|
| `auto` | 先文件账号池 → 环境变量 → 本地网关（默认） |
| `file` | 只用 `ACCIO_ACCOUNTS_CONFIG_PATH` 账号池文件 |
| `env` | 只用 `ACCIO_ACCESS_TOKEN` 单 token |
| `gateway` | 强制复用 Accio 本地登录态 |

### 多账号文件

复制 `config/accounts.example.json` 填入 token：

```json
{
  "strategy": "round_robin",
  "activeAccount": "acct_primary",
  "accounts": [
    { "id": "acct_primary", "accessToken": "replace-with-token", "enabled": true, "priority": 1 },
    { "id": "acct_backup", "tokenFile": "./secrets/backup.token", "enabled": true, "priority": 2 }
  ]
}
```

对应 `.env`：

```bash
ACCIO_TRANSPORT=direct-llm
ACCIO_AUTH_MODE=file
ACCIO_ACCOUNTS_CONFIG_PATH=config/accounts.json
```

### 单 token 环境变量

```bash
ACCIO_TRANSPORT=direct-llm
ACCIO_AUTH_MODE=env
ACCIO_ACCESS_TOKEN=replace-with-access-token
ACCIO_AUTH_ACCOUNT_ID=env-default
```

### 账号快照（本机登录态）

```bash
npm run auth:state -- status          # 查看当前状态
npm run auth:state -- snapshot acct_a # 保存快照
npm run auth:state -- list            # 列出快照
npm run auth:state -- activate acct_a # 恢复快照
```

### 辅助命令

```bash
npm run capture-token -- --write-file --account-id acct_primary  # 抓 token 写入账号池
npm run auth:relogin -- --write-file --account-id acct_primary --snapshot-alias acct_primary  # 重登录 + 快照
npm run accounts:list       # 列出账号池
npm run accounts:probe      # 探测可用账号
npm run accounts:activate -- acct_backup
npm run accounts:validate
```

## 环境变量参考

```bash
# Transport
ACCIO_TRANSPORT=auto              # auto | direct-llm | local-ws
ACCIO_AUTH_MODE=auto              # auto | file | env | gateway
ACCIO_AUTH_STRATEGY=round_robin

# 账号
ACCIO_ACCOUNTS_CONFIG_PATH=config/accounts.json
ACCIO_ACCESS_TOKEN=
ACCIO_AUTH_ACCOUNT_ID=env-default

# 网关
ACCIO_GATEWAY_AUTOSTART=1
ACCIO_APP_PATH=/Applications/Accio.app
ACCIO_GATEWAY_WAIT_MS=20000
ACCIO_GATEWAY_POLL_MS=500

# 模型
ACCIO_MODELS_SOURCE=static        # static | gateway | hybrid
ACCIO_MODELS_CACHE_TTL_MS=30000
ACCIO_DIRECT_LLM_BASE_URL=https://phoenix-gw.alibaba.com/api/adk/llm
ACCIO_FALLBACK_PROTOCOL=openai    # openai | anthropic
ACCIO_FALLBACK_OPENAI_BASE_URL=   # 可选，最后兜底的外部上游 base URL
ACCIO_FALLBACK_OPENAI_API_KEY=
ACCIO_FALLBACK_OPENAI_MODEL=
ACCIO_FALLBACK_ANTHROPIC_VERSION=2023-06-01
ACCIO_FALLBACK_OPENAI_TIMEOUT_MS=60000

# 安全防护
ACCIO_MAX_BODY_BYTES=10485760
ACCIO_BODY_READ_TIMEOUT_MS=30000
ACCIO_AUTH_CACHE_TTL_MS=120000
ACCIO_DEFAULT_MAX_OUTPUT_TOKENS=4096
ACCIO_QUOTA_PREFLIGHT_ENABLED=1
ACCIO_QUOTA_CACHE_TTL_MS=30000

# 缓存
ACCIO_RESPONSE_CACHE_TTL_MS=10000
ACCIO_RESPONSE_CACHE_MAX_ENTRIES=128

# Trace
ACCIO_TRACE_ENABLED=1
ACCIO_TRACE_SAMPLE_RATE=0
ACCIO_TRACE_MAX_ENTRIES=200
ACCIO_TRACE_MAX_BODY_CHARS=16384
ACCIO_TRACE_DIR=.data/traces

# 日志
LOG_LEVEL=info
```

模型别名映射不需要改代码，直接编辑 `config/model-aliases.json`。

## 代理原理

### 两条执行链路

| 链路 | 说明 |
|------|------|
| `direct-llm` | 直接请求 `phoenix-gw` 的 `/api/adk/llm/generateContent`，tool use 语义最完整（默认优先） |
| `local-ws` | 通过 Accio 本地 WebSocket `sendQuery` 触发 agent，保留 conversation 复用 |

`ACCIO_TRANSPORT=auto`（默认）先尝试 `direct-llm`，失败后回退 `local-ws`。

### 认证分层

`auto` 模式下会按优先级尝试：文件账号池 → 环境变量 → Accio 本地网关。如果走到网关层而 `127.0.0.1:4097` 没起来，bridge 会自动拉起 Accio 桌面端。

`ACCIO_APP_PATH` 支持自动发现（macOS 优先 `/Applications/Accio.app`，其次 `~/Applications/Accio.app`）。

### 低风险降消耗策略

- **默认输出上限**：客户端没传 `max_tokens` 时自动补 `ACCIO_DEFAULT_MAX_OUTPUT_TOKENS`（默认 4096）
- **短 TTL 精确请求缓存**：只缓存完全相同输入的非流式纯文本请求，默认 TTL 10s，容量 128 条。不缓存 tools/thinking/图片/流式请求
- **额度预检跳过**：默认会在 `direct-llm` 发送前检查当前候选账号额度；若已 100% 且还有其他候选账号，则本次请求直接切到下一个账号
- **基于刷新时间的账号冷却**：账号一旦被判定满额，会按 `refreshCountdownSeconds` 熔断到下一次刷新窗口，避免每次请求都重复探测同一满额账号
- **透明切号边界**：仅当上游在首个输出发给客户端之前报 quota/auth/overloaded 类错误时，bridge 才会自动在同一请求内切到下一个账号；一旦流式输出已经开始，就只记录失败，不会伪造续写
- **外部上游兜底**：配置 `ACCIO_FALLBACK_*` 后，若账号池和本地链路因 quota/auth/timeout/5xx 等原因失败，bridge 会把请求转发到额外的外部上游。支持 OpenAI 兼容和 Anthropic Messages 两种协议；Anthropic 协议下会自动兼容 `/messages` 与 `/v1/messages` 路径差异，并处理部分上游返回的 `200 + wrapped 404` 场景

命中缓存时返回 `x-accio-cache: hit`。

### 额外能力

- `x-accio-session-id` / `x-session-id` 会话复用
- `x-accio-conversation-id` 直接绑定已有 conversation
- `x-accio-account-id` 按请求指定账号
- 会话级账号粘性和可识别错误下的多账号 failover
- 额度预检会优先跳过已满额账号；流式请求仅在首个输出前支持透明切号重试
- 可选外部 OpenAI fallback 仅对纯文本请求生效；Anthropic fallback 走 Messages 协议透传，更适合 `Claude Code`
- 管理台账号卡片展示额度状态和刷新倒计时（短 TTL 缓存）
- 管理台支持外部上游配置持久化、连通性测试和 API Key 显隐
- 自动发现 Accio 本地 agent / workspace / source
- 对本地网关超时/连接失败/429/5xx 做错误分类和指数退避重试
- 响应顶层附加 `accio.*` 调试字段

### 自动发现策略

不手动配置 `ACCIO_*` 变量时，代理会优先选择有可用 DM/source 记录的账号，其次选该账号下的 agent/profile 和默认 workspace。这是启发式策略，不是官方稳定 API。

## 调试工具

### 健康检查

```bash
curl http://127.0.0.1:8082/healthz
```

返回当前 agentId、accountId/source、session store 状态、Accio 登录状态、direct LLM 可用性、trace 摘要。

### 本地鉴权探测

```bash
curl http://127.0.0.1:8082/debug/accio-auth
```

汇总本地网关地址、`/auth/status` 和 `/debug/auth/status` 结果、是否具备 direct LLM 复用条件。

### Trace 调试样本

默认所有失败请求自动落盘，成功请求需 `ACCIO_TRACE_SAMPLE_RATE` 或 `x-accio-debug-trace: 1` 强制采样。

```bash
curl http://127.0.0.1:8082/debug/traces
curl http://127.0.0.1:8082/debug/traces?limit=5
curl http://127.0.0.1:8082/debug/traces/trace_xxx
curl http://127.0.0.1:8082/debug/traces/trace_xxx/replay   # 脱敏 curl 复现命令
```

`authorization`、`token`、`cookie` 等字段会被脱敏。

### 日志

默认 JSON 结构化日志（`ts`/`level`/`msg`/`requestId`/`method`/`path`/`status`/`ms`），通过 `LOG_LEVEL=debug` 调高。

## 请求示例

### Anthropic — 会话复用

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-accio-session-id: demo-session' \
  -d '{"model":"accio-bridge","messages":[{"role":"user","content":"请只回复 SECOND"}]}'
```

响应头返回 `x-accio-conversation-id` 和 `x-accio-session-id`。

### Anthropic — 工具映射

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "tools": [{"name":"shell_echo","description":"echo a string","input_schema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}],
    "messages":[{"role":"user","content":"请在回答前先调用一个工具，然后告诉我你调用了什么。"}]
  }'
```

响应带标准 `content[].tool_use` 和自定义 `accio.tool_results`。

### OpenAI — 复用 session

```bash
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: demo-openai' \
  -d '{"model":"accio-bridge","messages":[{"role":"user","content":"请只回复 OK"}]}'
```

### 指定账号

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-accio-account-id: acct_primary' \
  -d '{"model":"accio-bridge","messages":[{"role":"user","content":"请只回复 OK"}]}'
```

## Accio 鉴权复用现状

Accio 桌面端本地网关（默认 `127.0.0.1:4097`）暴露了 `GET /auth/status`、`GET /auth/user`、`GET /debug/auth/*` 等端点。桌面端源码确认本地保存 `accessToken`/`refreshToken`/`cookie`，请求 `phoenix-gw` 时把 `accessToken` 注入 POST body 并从 cookie 提取 `cna` 到 `x-cna` 请求头。

已验证可以：

- 从 `/debug/auth/ws-status` 提取带 `accessToken` 的上游 WebSocket URL
- 从 `/debug/auth/http-log` 提取带 `accessToken` 的上游 HTTP 请求日志
- 直接调用 `POST https://phoenix-gw.alibaba.com/api/auth/userinfo` 和 `/api/adk/llm/generateContent`

本地网关还暴露了 `POST /upload`，会拿本地 Accio Cookie 转发到 `https://filebroker.accio.com/x/upload`。

## 已验证链路

Accio 桌面端本地暴露 HTTP `127.0.0.1:4097` 和 WebSocket `ws://127.0.0.1:4097/websocket/connect?clientId=...`。

代理已验证：

1. 外部进程可以直接访问 `127.0.0.1:4097`
2. 外部进程可以建立 `/websocket/connect` 发送 `sendQuery`
3. 可以收到 `ack` / `event.append` / `event.finished` / `channel.message.created`
4. 请求结果写入 Accio 本地 conversation 存储，可被代理回读补全 tool 映射

## 测试

```bash
npm test
```

零依赖单测，覆盖 Anthropic/OpenAI 请求压平与响应映射、Direct LLM 请求构造、JSONC 解析、Session 绑定、模型发现、工具校验等。

## 目录结构

```text
accio-anthropic-bridge/
  config/
    model-aliases.json
    accounts.example.json
    accounts.json
  .env.example
  .gitignore
  package.json
  .data/
    sessions.json
  src/
    accio-client.js
    accounts-file.js
    anthropic.js
    auth-provider.js
    auth-state.js
    bootstrap.js
    bridge-core.js
    debug-traces.js
    direct-llm.js
    discovery.js
    env-file.js
    errors.js
    gateway-manager.js
    http.js
    jsonc.js
    logger.js
    model.js
    models.js
    middleware/
      body-parser.js
    openai.js
    redaction.js
    request-defaults.js
    response-cache.js
    routes/
      admin.js
      anthropic.js
      debug.js
      health.js
      openai.js
    runtime-config.js
    server.js
    session-store.js
    start.js
    stream/
      anthropic-sse.js
      openai-sse.js
      responses-sse.js
    tooling.js
  scripts/
    accounts.js
    auth-relogin.js
    auth-state.js
    capture-token.js
    init-env.js
    open-admin.js
  desktop/
    main.js
    preload.js
    start.js
    package.json
  test/
    *.test.js
```

## 关键实现文件

- [src/server.js](src/server.js) — 服务器装配、路由注册、生命周期管理
- [src/routes/anthropic.js](src/routes/anthropic.js) — Anthropic Messages 路由
- [src/routes/openai.js](src/routes/openai.js) — OpenAI Chat Completions 路由
- [src/routes/admin.js](src/routes/admin.js) — 管理台路由，含 OAuth 多账号登录流、快照 CRUD、网关状态 API
- [src/accio-client.js](src/accio-client.js) — Accio HTTP/WS 客户端、重试、conversation 回读
- [src/direct-llm.js](src/direct-llm.js) — 直连上游 LLM 的请求构造与 SSE 解析
- [src/auth-provider.js](src/auth-provider.js) — 认证来源选择、账号池轮询、失效熔断
- [src/accounts-file.js](src/accounts-file.js) — 本机账号注册表
- [src/auth-state.js](src/auth-state.js) — 登录态快照管理（保存/激活/删除/完整凭证捕获）
- [src/gateway-manager.js](src/gateway-manager.js) — 本地网关探测、自动拉起 Accio、token 抓取
- [src/models.js](src/models.js) — 模型列表管理（静态/网关/混合模式）
- [src/runtime-config.js](src/runtime-config.js) — 运行时配置加载
- [src/discovery.js](src/discovery.js) — 本地 `~/.accio` 自动发现
- [src/session-store.js](src/session-store.js) — session 到 conversation 持久化映射
- [src/anthropic.js](src/anthropic.js) / [src/openai.js](src/openai.js) — 请求压平和响应映射
- [src/debug-traces.js](src/debug-traces.js) — 请求样本采样、脱敏落盘与 replay 构造
- [src/stream/anthropic-sse.js](src/stream/anthropic-sse.js) — Anthropic SSE writer
- [src/stream/openai-sse.js](src/stream/openai-sse.js) — OpenAI SSE writer
- [src/stream/responses-sse.js](src/stream/responses-sse.js) — Responses SSE writer
- [desktop/main.js](desktop/main.js) — Electron 主进程
- [desktop/preload.js](desktop/preload.js) — contextBridge API
- [desktop/start.js](desktop/start.js) — 桌面壳启动入口
- [config/model-aliases.json](config/model-aliases.json) — 可编辑模型别名映射
- [config/accounts.example.json](config/accounts.example.json) — 账号池模板

## 已实测结果

- `GET /healthz`、`GET /v1/models`、`POST /v1/messages/count_tokens`
- `POST /v1/messages`、`POST /v1/chat/completions`、`POST /v1/responses` 最小子集
- 外部 OpenAI fallback 与外部 Anthropic fallback
- Anthropic fallback 在上游返回 JSON 时可合成 SSE；已实测 `Claude Code` 这一类流式客户端所需事件格式
- `https://open.bigmodel.cn/api/anthropic` 这类 base URL 可自动补 `v1/messages` 兼容路径
- `GET /debug/traces` / `GET /debug/traces/:id` / `GET /debug/traces/:id/replay`
- `session_id` 复用同一 `conversation_id`，会话级账号粘性
- 默认输出上限兜底、短 TTL 精确请求缓存、满额账号按刷新时间冷却切回
- 失败请求自动 trace 采样和脱敏 replay 导出
- `tool_use` / `tool_calls` / `accio.tool_results` 响应
- `GET /admin` 管理台、`GET /admin/api/state`、外部上游配置与测试、OAuth 登录流、快照删除
- 60 项单元测试全部通过

## 后续还可以继续做

1. 补齐 `tool_result` 往返协议，包括更完整的 multi-turn tool loop
2. 扩展 `/v1/responses` 的 reasoning item、tool_result item 事件覆盖
3. 更完整的图片/多模态上传桥接
4. 为外部 fallback 增加更细的健康检查、熔断和统计
5. 在 trace store 基础上补 trace diff、导出 CLI 和自动复跑工具
6. 补充 live integration test
7. 将桌面壳打包为 `.app` / `.exe` / `.deb` 发布物
8. 管理台增加账号分组、备注标签、批量操作
