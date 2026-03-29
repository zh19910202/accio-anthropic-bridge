# Accio Anthropic Bridge

把 Anthropic / OpenAI 风格请求桥接到 Accio 的本地登录态和本地网关的本地代理。

这个仓库现在不再只是 PoC。当前默认工作模式是：

- 优先直连 `https://phoenix-gw.alibaba.com/api/adk/llm`
- 复用 Accio 桌面端当前登录态
- 如果直连不可用，再回退到 Accio 本地 WebSocket `sendQuery`

已经补上的关键能力包括：

- Anthropic Messages API 可用子集
- OpenAI Chat Completions 兼容接口
- 会话复用
- direct LLM tool use / tool result 映射
- 更细的错误分类和本地重试
- 自动发现可用的 Accio `agent/source/workspace`
- 本地 Accio 鉴权复用探测
- 一键环境初始化与 `.env` 自动加载
- 请求级结构化日志
- Node.js 内置测试覆盖
- 可视化管理台（`/admin`），含多账号 OAuth 登录、快照管理、网关状态实时展示
- Electron 桌面壳，内嵌管理台并自动管理 bridge 子进程生命周期
- 网关模型列表动态发现（`ACCIO_MODELS_SOURCE=gateway|hybrid`）

## 免责申明

在使用这个项目之前，请先接受下面这些边界：

- 这是非官方、逆向分析得到的桥接方案，不代表 Accio、Anthropic、OpenAI 或阿里巴巴的官方立场
- Accio 本地接口、上游网关协议、模型名、认证字段都可能随桌面端版本更新而失效，这个仓库不承诺长期稳定
- 本项目会复用你当前机器上的 Accio 登录态；如果你把日志、调试输出、代理请求或错误堆栈暴露给他人，可能间接泄露敏感认证信息
- 是否允许这样复用登录态、转发请求、桥接第三方协议，取决于你自己的使用场景以及相关服务条款；合规、风控、账号封禁、额度异常等风险由使用者自行承担
- 如果你将这个项目用于牟利、收费服务、商业分发、代充能力、账号转售或其他商业化变现用途，因此引发的法律、合规、风控、封号、索赔或其他后果，均由使用者自行承担
- 本项目仅适合本地研究、协议验证和个人实验环境，不建议在生产环境、多人共享环境或高权限账号环境直接使用
- 如果你不清楚某条调用是否会触发上游计费、审计或风控，请先不要使用

## 已验证链路

Accio 桌面端本地暴露了两类入口：

- HTTP: `http://127.0.0.1:4097`
- WebSocket: `ws://127.0.0.1:4097/websocket/connect?clientId=...`

这个代理已验证本地 gateway 链路：

1. 外部进程可以直接访问 `127.0.0.1:4097`
2. 外部进程可以直接建立 `/websocket/connect`
3. 外部进程可以发送 `sendQuery`
4. 可以收到 `ack` / `event.append` / `event.finished` / `channel.message.created`
5. 请求结果会写入 Accio 本地 conversation 存储，可被代理再次读取用于补全 tool 映射

## Accio 鉴权复用现状

关于“能不能直接利用 Accio 的认证信息请求上游”这件事，现在结论已经从“待验证”变成了“已验证可行”。

- Accio 桌面端本地网关会维护登录态，默认网关仍在 `http://127.0.0.1:4097`
- 本地可直接访问：
  - `GET /auth/status`
  - `GET /auth/user`
  - `GET /debug/auth/status`
  - `GET /debug/auth/http-log`
  - `GET /debug/auth/ws-status`
  - `POST /debug/auth/refresh`
  - `POST /debug/auth/fetch-user`
- 本地网关还暴露了 `POST /upload`，会直接拿本地 Accio `Cookie` 转发到 `https://filebroker.accio.com/x/upload`
- 从桌面端源码可以确认：
  - Accio 本地确实保存 `accessToken` / `refreshToken` / `cookie`
  - 请求 `phoenix-gw.alibaba.com` 时，会把 `accessToken` 注入 POST body
  - 同时会从 `cookie` 里提取 `cna`，带到 `x-cna` 请求头
  - 还会自动补 `x-utdid` / `x-language` / `x-app-version` / `x-os`

更关键的是，已经做过真实请求验证：

- `GET /debug/auth/ws-status` 会暴露带 `accessToken` 的上游 WebSocket URL
- `GET /debug/auth/http-log` 会暴露带原始 `accessToken` 的上游 HTTP 请求日志
- 外部进程已经成功直接调用：
  - `POST https://phoenix-gw.alibaba.com/api/auth/userinfo`
  - `POST https://phoenix-gw.alibaba.com/api/adk/llm/generateContent`

也就是说，这个桥现在已经可以直接复用 Accio 桌面端当前登录态请求上游 LLM，不再只是通过本地 websocket 曲线触发。

## 当前支持

### Anthropic 兼容

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- 非流式
- SSE 流式
- 原生 `tool_use`
- 原生 `tool_result` 继续对话
- Claude 上游事件透传式 SSE
- 响应顶层附加 `accio.*` 调试字段

### OpenAI 兼容

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses` 最小可用子集，含基础 streaming
- 非流式
- SSE 流式
- `tools`
- `tool_calls`
- `responses.input_text` / `responses.input_image` 到 OpenAI message 的最小映射
- 响应顶层附加 `accio.*` 调试字段

### 额外能力

- `ACCIO_TRANSPORT=auto|direct-llm|local-ws`
- `ACCIO_AUTH_MODE=auto|file|env|gateway`
- `ACCIO_MODELS_SOURCE=static|gateway|hybrid`
- `ACCIO_MAX_BODY_BYTES` / `ACCIO_BODY_READ_TIMEOUT_MS` 请求体防护
- `ACCIO_AUTH_CACHE_TTL_MS` 网关 token 短 TTL 缓存
- `ACCIO_DEFAULT_MAX_OUTPUT_TOKENS` 默认输出上限兜底
- `ACCIO_RESPONSE_CACHE_TTL_MS` / `ACCIO_RESPONSE_CACHE_MAX_ENTRIES` 短 TTL 精确请求缓存
- `ACCIO_TRACE_ENABLED` / `ACCIO_TRACE_SAMPLE_RATE` 请求样本采样与本地 trace 落盘
- `x-accio-session-id` / `x-session-id` 会话复用
- `x-accio-conversation-id` 直接绑定已有 conversation
- `x-accio-account-id` 指定外部账号凭证
- 会话级账号粘性和可识别错误下的多账号 failover
- 自动发现 Accio 本地账号、agent、workspace、source
- 对本地网关超时/连接失败/429/5xx 做错误分类
- 对可重试错误做指数退避重试
- `GET /debug/accio-auth` 本地鉴权探测
- `GET /debug/traces` / `GET /debug/traces/:id` / `GET /debug/traces/:id/replay` 调试样本查看与复现导出
- `npm run accounts:list|probe|activate|validate` 账号池管理
- `GET /admin` 可视化管理台，含多账号登录、快照管理、网关状态
- `POST /admin/api/accounts/login` 发起浏览器 OAuth 多账号登录流
- `GET /admin/api/accounts/callback` OAuth 登录回调
- `GET /admin/api/accounts/login-status` 登录流轮询
- `POST /admin/api/snapshots/delete` 删除本机快照
- 管理台网关模型列表发现（`ACCIO_MODELS_SOURCE=gateway|hybrid`）

## 仍然不是完整兼容

当前还不是官方 Anthropic / OpenAI 的 100% 完整实现，限制包括：

- 只有 Claude 族模型在 Anthropic 流式下能做到接近原生的 SSE 透传
- OpenAI 兼容接口当前是“OpenAI 协议适配 + Claude 上游执行”，不是直接调用 OpenAI 官方模型
- `/v1/responses` 现在支持最小可用 streaming 子集和基础 tool item 输出，但仍未补齐更完整的 output item / reasoning item 事件语义
- 图片 block 目前只做 URL / base64 级别的最小映射，没有做完整上传桥接
- thinking 目前只在 `direct-llm` 路径下按 Anthropic 语义透传，`local-ws` 会显式报不支持
- 当前响应缓存只覆盖低风险纯文本请求，不缓存 tools、thinking、图片、多模态或流式请求
- `x-accio-session-id` 在 direct LLM 模式下只是桥接层会话标识，不对应 Accio cloud conversation

## 代理原理

### 1. 为什么现在有两条执行链路

当前代理支持两种后端：

- `direct-llm`
  - 直接请求 `phoenix-gw` 的 `/api/adk/llm/generateContent`
  - 复用 Accio 桌面端本地登录态
  - tool use / tool result 语义最完整
- `local-ws`
  - 通过 Accio 本地 WebSocket `sendQuery` 触发 agent
  - 保留 Accio conversation / session 复用能力

默认 `ACCIO_TRANSPORT=auto`，会先尝试 `direct-llm`，失败后再回退到 `local-ws`。

### 1.2 当前的低风险降消耗策略

在不改变主模型映射的前提下，bridge 目前只做两类低风险优化：

- 默认输出上限
  - 当客户端没有显式传 `max_tokens` / `max_output_tokens` 时，自动补一个兜底上限
  - 默认值由 `ACCIO_DEFAULT_MAX_OUTPUT_TOKENS` 控制，默认 `4096`
  - 如果客户端已经显式传值，bridge 不会覆盖
- 短 TTL 精确请求缓存
  - 只缓存完全相同输入的非流式纯文本请求
  - 默认 TTL 由 `ACCIO_RESPONSE_CACHE_TTL_MS` 控制，默认 `10000` 毫秒
  - 缓存容量由 `ACCIO_RESPONSE_CACHE_MAX_ENTRIES` 控制，默认 `128`
  - 不缓存以下请求：`tools`、`tool_calls`、`tool_result`、thinking、图片/多模态、流式请求

命中缓存时，响应头里会返回：

```text
x-accio-cache: hit
```

未命中但允许缓存时，会返回：

```text
x-accio-cache: miss
```

### 1.1 认证来源现在也支持分层选择

除了 transport，当前 bridge 还支持独立的认证来源选择：

- `ACCIO_AUTH_MODE=auto`
  先尝试本地文件账号池，再尝试环境变量单账号，最后才回退到 Accio 本地网关
- `ACCIO_AUTH_MODE=file`
  只使用 `ACCIO_ACCOUNTS_CONFIG_PATH` 指向的账号池文件，不依赖 Accio 程序
- `ACCIO_AUTH_MODE=env`
  只使用 `ACCIO_ACCESS_TOKEN` 指定的单账号 token，不依赖 Accio 程序
- `ACCIO_AUTH_MODE=gateway`
  强制复用 Accio 本地登录态，行为与旧版本一致

如果走到 `gateway` 这层而本地 `127.0.0.1:4097` 还没起来，bridge 现在默认会：

1. 自动拉起 `ACCIO_APP_PATH` 指向的 Accio 桌面应用
2. 轮询本地 `/debug/auth/ws-status` 直到能提取 `accessToken`
3. 保持 Accio 继续运行，不会由 bridge 自动关闭

相关开关：

- `ACCIO_GATEWAY_AUTOSTART=1`
- `ACCIO_APP_PATH=/Applications/Accio.app`
- `ACCIO_GATEWAY_WAIT_MS=20000`
- `ACCIO_GATEWAY_POLL_MS=500`

其中 `ACCIO_APP_PATH` 现在支持自动发现：

- macOS 优先探测 `/Applications/Accio.app`
- 其次探测 `~/Applications/Accio.app`
- 只有你手工覆盖时才使用自定义值

如果你的目标是“单账号/多账号都不打开 Accio 也能直接请求上游模型”，就应该配合：

```bash
ACCIO_TRANSPORT=direct-llm
ACCIO_AUTH_MODE=file
```

### 2. direct LLM 如何工作

收到 Anthropic 或 OpenAI 请求后，代理会：

1. 从本地 `debug/auth/ws-status` / `debug/auth/http-log` 复用当前登录态
2. 把 Anthropic/OpenAI 的消息、工具、tool result 转成 Accio ADK LLM 请求
3. 直接请求 `phoenix-gw` 的 `/api/adk/llm/generateContent`
4. 把返回的 Claude / Accio SSE 事件重新封装成 Anthropic 或 OpenAI 兼容响应

如果本次 direct LLM 需要从 `gateway` 兜底拿 token，bridge 会优先尝试文件账号池 / 环境变量账号；只有这些都不可用时，才会触发本地 Accio 自动拉起。

### 3. WebSocket 回退模式如何工作

当 direct LLM 不可用时，代理仍然可以：

1. 根据 `session_id` 或 `conversation_id` 决定复用旧 conversation，或创建新 conversation
2. 连接 Accio 本地 WebSocket
3. 发送 `sendQuery`
4. 收集 `append/finished`
5. 回读 Accio 本地 conversation 文件，补全 `tool_calls` 和 `tool_results`

### 4. 自动发现策略

如果你不手动配置 `ACCIO_*` 变量，代理会优先选择：

1. 有可用 DM/source 记录的账号
2. 该账号下的可用 agent/profile
3. agent 的默认 workspace

这个策略比原来的硬编码强，但依然是启发式，不是官方稳定 API。

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

## 启动

```bash
npm start
```

`npm start` 现在会先检查仓库根目录下是否已有 `.env`：

- 没有 `.env` 时，自动执行一次 `npm run setup`
- 已有 `.env` 时，直接启动，不覆盖你手工改过的配置

`npm run setup` 和 `npm run init-env` 等价，都会自动扫描本机 `~/.accio`，生成当前机器专用的 `.env`。

脚本优先级如下：

1. 如果本地 Accio 网关 `http://127.0.0.1:4097` 可访问，优先读取当前登录态
2. 如果本地网关暂时不可访问，再回退到 `~/.accio/accounts/*` 的最近活跃账号、最近 session、最近 workspace 进行推断

所以大多数场景下，不需要手工填这些 `ACCIO_*` 环境变量。

如果你只想预览自动发现结果、不写入文件：

```bash
npm run init-env -- --print
```

如果 `.env` 已存在，但你想重新生成：

```bash
npm run init-env -- --force
```

如果你只是想单独生成或重建 `.env`，仍然可以直接执行 `npm run setup`。

可选环境变量：

```bash
ACCIO_TRANSPORT=auto
ACCIO_AUTH_MODE=auto
ACCIO_AUTH_STRATEGY=round_robin
ACCIO_ACCOUNTS_CONFIG_PATH=config/accounts.json
ACCIO_ACCESS_TOKEN=
ACCIO_AUTH_ACCOUNT_ID=env-default
ACCIO_GATEWAY_AUTOSTART=1
ACCIO_APP_PATH=/Applications/Accio.app
ACCIO_GATEWAY_WAIT_MS=20000
ACCIO_GATEWAY_POLL_MS=500
ACCIO_DIRECT_LLM_BASE_URL=https://phoenix-gw.alibaba.com/api/adk/llm
ACCIO_MODELS_SOURCE=static
ACCIO_MODELS_CACHE_TTL_MS=30000
ACCIO_MAX_BODY_BYTES=10485760
ACCIO_BODY_READ_TIMEOUT_MS=30000
ACCIO_AUTH_CACHE_TTL_MS=120000
ACCIO_DEFAULT_MAX_OUTPUT_TOKENS=4096
ACCIO_RESPONSE_CACHE_TTL_MS=10000
ACCIO_RESPONSE_CACHE_MAX_ENTRIES=128
```

如果你要调整模型别名映射，不需要改代码，直接编辑：

```text
config/model-aliases.json
```

如果你要脱离 Accio 程序运行，建议复制下面这个模板并填入自己的 token：

```text
config/accounts.example.json
```

对应的最小配置例如：

```bash
ACCIO_TRANSPORT=direct-llm
ACCIO_AUTH_MODE=file
ACCIO_ACCOUNTS_CONFIG_PATH=config/accounts.json
```

文件内容：

```json
{
  "strategy": "round_robin",
  "activeAccount": "acct_primary",
  "accounts": [
    {
      "id": "acct_primary",
      "name": "acct_primary",
      "accessToken": "replace-with-access-token",
      "enabled": true,
      "priority": 1
    },
    {
      "id": "acct_backup",
      "name": "acct_backup",
      "tokenFile": "./secrets/backup.token",
      "enabled": true,
      "priority": 2
    }
  ]
}
```

账号池辅助命令：

```bash
npm run accounts:list
npm run accounts:probe
npm run accounts:activate -- acct_backup
npm run accounts:validate
```

如果你只想用一个 token，也可以不写账号池文件，直接用环境变量：

```bash
ACCIO_TRANSPORT=direct-llm
ACCIO_AUTH_MODE=env
ACCIO_ACCESS_TOKEN=replace-with-access-token
ACCIO_AUTH_ACCOUNT_ID=env-default
```

如果你暂时没有手动导出的 token，也可以让 bridge 代你抓一份，并持久化到账号池文件：

```bash
npm run capture-token -- --write-file --account-id acct_primary
```

这个命令会读取 `.env`，在需要时自动拉起 Accio，抓到 token 后写入 `ACCIO_ACCOUNTS_CONFIG_PATH`。当前 bridge 默认不会主动关闭 Accio。

如果你想在重新登录后一次性完成“写入账号池 + 保存本机登录态快照”，可以直接：

```bash
npm run auth:relogin -- --write-file --account-id acct_primary --snapshot-alias acct_primary
```

如果你想把 Accio 桌面端当前登录态按账号做本机快照，并在之后恢复为某个已保存账号，可以使用：

```bash
npm run auth:state -- status
npm run auth:state -- snapshot acct_a
npm run auth:state -- list
npm run auth:state -- activate acct_a
```

这组命令会优先处理 Accio 主进程使用的加密登录态文件：

- macOS 默认是 `~/Library/Application Support/Accio/credentials.enc`
- 明文回退路径是 `~/.config/accio/credentials.json`

注意几点：

- 这不是跨机器通用 token 导出，而是“当前机器上的 Accio 登录态文件快照”
- `credentials.enc` 由 Electron `safeStorage` 加密，通常只适用于同一台机器、同一系统用户
- 如果本地 `4097` 网关还在运行，它可能仍持有旧的内存登录态；`activate` 只会恢复磁盘状态，生效前通常需要重启 Accio 或本地网关

默认监听：

```text
http://127.0.0.1:8082
```

本地管理台：

```text
http://127.0.0.1:8082/admin
```

如果服务已经启动，也可以直接执行：

```bash
npm run manager:open
```

管理台当前支持：

- 查看当前 Accio 网关状态和当前用户（脉冲指示灯实时反馈）
- 查看本机登录态落盘位置
- 保存、切换和删除本机账号快照
- 通过浏览器完成多账号 OAuth 登录，登录完成后自动记录快照
- 执行登出
- 把当前 token 写回账号池文件
- 按钮加载 spinner、消息通知自动消失、删除双击确认等交互

桌面壳（Electron）：

```bash
npm run desktop:install
npm run desktop:start
```

桌面壳会做四件事：

- 先检查本地 bridge 是否已经在 `http://127.0.0.1:<PORT>` 监听；如果没起来，就从当前仓库目录自动执行 `node src/start.js`
- 把已有的管理台 `/admin` 直接嵌进桌面窗口，不重复实现一套独立管理逻辑
- 启动一个本地 desktop helper HTTP server（默认 `127.0.0.1:8090`），支持通过 HTTP 触发"拉起 Accio 桌面端"等命令
- 只在"桌面壳自己拉起了 bridge"时，退出桌面壳时一并结束那个子进程；如果 bridge 本来就是你手动启动的，它不会额外干预

桌面壳同时提供了 preload 脚本，在页面中暴露 `window.accioBridgeDesktop.launchAccio()` API，管理台可通过此接口或 `accio-bridge://launch-accio` 协议触发 Accio 桌面端启动。

说明：

- 当前是本地桌面壳，不是已打包的 `.app` / `.exe` 发布物
- 第一次使用前需要先执行一次 `npm run desktop:install` 安装 Electron
- bridge 的实际端口仍然以你的 `.env` 里的 `PORT` 为准，桌面壳会读取同一个 `.env`
- helper server 端口可通过 `ACCIO_DESKTOP_HELPER_PORT` 环境变量或 runtime config 的 `desktopHelperUrl` 配置

## 本地鉴权探测

桥接自身新增了一个探测端点，用来快速判断当前机器上的 Accio 本地鉴权能否复用：

```bash
curl http://127.0.0.1:8082/debug/accio-auth
```

这个接口会汇总：

- 桥接访问的 Accio 本地网关地址
- `GET /auth/status` 的结果
- `GET /debug/auth/status` 的结果
- 是否能直接复用登录态打上游 LLM

它的目标不是导出敏感凭证，而是给你一个明确结论：

- 当前有没有登录态
- 本地网关有没有持有 auth material
- 当前桥是否已经具备 direct LLM 复用条件

## 健康检查

```bash
curl http://127.0.0.1:8082/healthz
```

返回内容里会带：

- 当前使用的 `agentId`
- 自动发现到的 `accountId/source`
- session store 路径和计数
- Accio 本地登录状态
- Accio 本地 debug auth 摘要
- direct LLM 是否可用
- trace store 摘要和当前采样配置

## Trace 调试样本

桥接现在支持把请求样本以脱敏后的 JSON 形式保存在本地，默认策略是：

- 所有失败请求都会自动落盘
- 成功请求默认不采样，除非你显式开启 `ACCIO_TRACE_SAMPLE_RATE`
- 单次请求也可以通过 `x-accio-debug-trace: 1` 强制采样

相关环境变量：

```bash
ACCIO_TRACE_ENABLED=1
ACCIO_TRACE_SAMPLE_RATE=0
ACCIO_TRACE_MAX_ENTRIES=200
ACCIO_TRACE_MAX_BODY_CHARS=16384
ACCIO_TRACE_DIR=.data/traces
```

常用接口：

```bash
curl http://127.0.0.1:8082/debug/traces
curl http://127.0.0.1:8082/debug/traces?limit=5
curl http://127.0.0.1:8082/debug/traces/trace_xxx
curl http://127.0.0.1:8082/debug/traces/trace_xxx/replay
```

`/debug/traces/:id/replay` 会返回一条已脱敏的 `curl` 命令，便于复现桥接层收到的请求形态。需要注意：

- 这是本地排障工具，不应该对外暴露
- `authorization`、`token`、`cookie`、`cna`、`x-utdid` 等字段会被脱敏
- 如果请求体超出 `ACCIO_TRACE_MAX_BODY_CHARS`，样本会被截断，返回的 replay 仅用于近似复现

## Anthropic 请求示例

### 最简单文本请求

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "max_tokens": 256,
    "messages": [
      {
        "role": "user",
        "content": "请只回复 OK"
      }
    ]
  }'
```

### 会话复用

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-accio-session-id: demo-session' \
  -d '{
    "model": "accio-bridge",
    "messages": [
      {
        "role": "user",
        "content": "请只回复 SECOND"
      }
    ]
  }'
```

响应头会返回：

- `x-accio-conversation-id`
- `x-accio-session-id`

注意：

- `local-ws` 模式下，这两个值会绑定到 Accio 本地 conversation
- `direct-llm` 模式下，`x-accio-session-id` 只是桥接层 session 复用标识

### 工具映射

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "tools": [
      {
        "name": "shell_echo",
        "description": "echo a string",
        "input_schema": {
          "type": "object",
          "properties": {
            "text": { "type": "string" }
          },
          "required": ["text"]
        }
      }
    ],
    "messages": [
      {
        "role": "user",
        "content": "请在回答前先调用一个工具，然后告诉我你调用了什么。"
      }
    ]
  }'
```

当前响应会带两层信息：

- 标准 Anthropic `content[].tool_use`
- 自定义 `accio.tool_results`

## OpenAI 请求示例

### Chat Completions

```bash
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "messages": [
      {
        "role": "user",
        "content": "请只回复 OK"
      }
    ]
  }'
```

### 复用 session

```bash
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-session-id: demo-openai' \
  -d '{
    "model": "accio-bridge",
    "messages": [
      {
        "role": "user",
        "content": "请只回复 OK"
      }
    ]
  }'
```

## Claude Code 接入

如果 Claude Code 支持自定义 Anthropic Base URL，可以直接这样连：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
export ANTHROPIC_API_KEY=dummy
claude
```

这里的 `ANTHROPIC_API_KEY` 只是为了满足某些客户端的本地校验。代理本身不校验这个值。

如果你启用了多账号池，还可以按请求显式指定账号：

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -H 'x-accio-account-id: acct_primary' \
  -d '{
    "model": "accio-bridge",
    "messages": [{ "role": "user", "content": "请只回复 OK" }]
  }'
```

## 测试

项目现在带了零依赖单测，可以直接跑：

```bash
npm test
```

当前测试覆盖的主要是纯转换逻辑：

- Anthropic 请求压平和响应映射
- OpenAI 请求压平和响应映射
- Direct LLM 请求构造
- JSONC 解析
- Session 绑定规则

## 日志

桥接现在默认输出 JSON 结构化日志，包含：

- `ts`
- `level`
- `msg`
- `requestId`
- `method`
- `path`
- `status`
- `ms`

可以通过下面的环境变量调低或调高日志级别：

```bash
LOG_LEVEL=debug
```

## 关键实现文件

- [src/server.js](/Users/snow/accio-anthropic-bridge/src/server.js)
  服务器装配、路由注册、生命周期管理
- [src/routes/anthropic.js](/Users/snow/accio-anthropic-bridge/src/routes/anthropic.js)
  Anthropic Messages 路由与 direct/local-ws 执行链路
- [src/routes/openai.js](/Users/snow/accio-anthropic-bridge/src/routes/openai.js)
  OpenAI Chat Completions 路由与 direct/local-ws 执行链路
- [src/routes/health.js](/Users/snow/accio-anthropic-bridge/src/routes/health.js)
  健康检查与本地鉴权探测
- [src/routes/debug.js](/Users/snow/accio-anthropic-bridge/src/routes/debug.js)
  trace 列表、详情与 replay 导出接口
- [src/stream/anthropic-sse.js](/Users/snow/accio-anthropic-bridge/src/stream/anthropic-sse.js)
  Anthropic SSE writer
- [src/stream/openai-sse.js](/Users/snow/accio-anthropic-bridge/src/stream/openai-sse.js)
  OpenAI SSE writer
- [src/accio-client.js](/Users/snow/accio-anthropic-bridge/src/accio-client.js)
  Accio HTTP/WS 客户端、重试、conversation 回读、tool artifacts 收集
- [src/discovery.js](/Users/snow/accio-anthropic-bridge/src/discovery.js)
  本地 `~/.accio` 自动发现
- [src/session-store.js](/Users/snow/accio-anthropic-bridge/src/session-store.js)
  session 到 conversation 的持久化映射
- [config/model-aliases.json](/Users/snow/accio-anthropic-bridge/config/model-aliases.json)
  可编辑的模型别名映射
- [config/accounts.example.json](/Users/snow/accio-anthropic-bridge/config/accounts.example.json)
  单账号/多账号外部凭证池模板
- [src/auth-provider.js](/Users/snow/accio-anthropic-bridge/src/auth-provider.js)
  认证来源选择、账号池轮询、账号失效熔断
- [src/accounts-file.js](/Users/snow/accio-anthropic-bridge/src/accounts-file.js)
  本机账号注册表，记录 gatewayUser 元数据和凭证产物追踪
- [src/auth-state.js](/Users/snow/accio-anthropic-bridge/src/auth-state.js)
  本机登录态快照管理，包括快照、激活、删除和完整凭证捕获
- [src/gateway-manager.js](/Users/snow/accio-anthropic-bridge/src/gateway-manager.js)
  本地网关探测、自动拉起 Accio、抓取 gateway token、可选自动退出
- [src/runtime-config.js](/Users/snow/accio-anthropic-bridge/src/runtime-config.js)
  运行时配置加载，合并 `.env` / 环境变量 / 命令行参数
- [src/models.js](/Users/snow/accio-anthropic-bridge/src/models.js)
  模型列表管理，支持静态/网关/混合模式发现
- [src/routes/admin.js](/Users/snow/accio-anthropic-bridge/src/routes/admin.js)
  管理台路由，含 OAuth 多账号登录流、快照 CRUD、网关状态 API、管理台页面渲染
- [scripts/capture-token.js](/Users/snow/accio-anthropic-bridge/scripts/capture-token.js)
  显式抓取 Accio token 并写入账号池文件
- [src/env-file.js](/Users/snow/accio-anthropic-bridge/src/env-file.js)
  `.env` 解析与复用加载
- [src/debug-traces.js](/Users/snow/accio-anthropic-bridge/src/debug-traces.js)
  请求样本采样、脱敏落盘与 replay 构造
- [src/redaction.js](/Users/snow/accio-anthropic-bridge/src/redaction.js)
  trace/error 公共脱敏与截断工具
- [src/anthropic.js](/Users/snow/accio-anthropic-bridge/src/anthropic.js)
  Anthropic 请求压平和响应映射
- [src/openai.js](/Users/snow/accio-anthropic-bridge/src/openai.js)
  OpenAI 请求压平和响应映射
- [desktop/main.js](/Users/snow/accio-anthropic-bridge/desktop/main.js)
  Electron 主进程：窗口管理、bridge 子进程生命周期、desktop helper server、Accio 桌面端拉起
- [desktop/preload.js](/Users/snow/accio-anthropic-bridge/desktop/preload.js)
  Electron preload 脚本，通过 contextBridge 暴露 `accioBridgeDesktop` API
- [desktop/start.js](/Users/snow/accio-anthropic-bridge/desktop/start.js)
  桌面壳启动入口，从当前 Node 进程 spawn Electron

## 已实测结果

本机已经实测通过或由自动化测试覆盖：

- `GET /healthz`
- `GET /v1/models`
- `POST /v1/messages/count_tokens`
- `POST /v1/messages`
- `POST /v1/chat/completions`
- `POST /v1/responses` 最小子集，含基础 streaming
- `GET /debug/traces` / `GET /debug/traces/:id` / `GET /debug/traces/:id/replay`
- 相同 `session_id` 复用同一个 `conversation_id`
- 会话级账号粘性与账号池选择
- 默认输出上限兜底和短 TTL 精确请求缓存
- 失败请求自动 trace 采样和脱敏 replay 导出
- 响应中回带 `tool_use` / `tool_calls` / `accio.tool_results`
- body size limit、body timeout、模型发现、工具校验和 trace store 的单元测试
- `GET /admin` 管理台页面加载
- `GET /admin/api/state` 网关状态 JSON 查询
- `POST /admin/api/accounts/login` → 浏览器 OAuth → `GET /admin/api/accounts/callback` 完整登录流
- `POST /admin/api/snapshots/delete` 快照删除
- direct-llm 请求构造和网关模型列表提取的单元测试

## 后续还可以继续做

1. 补齐真正可互操作的 `tool_result` 往返协议，包括更完整的 multi-turn tool loop
2. 继续扩展 `/v1/responses` 的 reasoning item、tool_result item 和更细粒度事件覆盖
3. 做更完整的图片/多模态上传桥接，而不是当前的 URL / base64 最小映射
4. ~~在用户显式授权前提下，研究是否增加 Electron helper 去读取本地加密凭证~~ — 已实现：desktop helper server 支持 `/debug/decrypt-credentials`
5. 如果找到更稳定的 Accio 上游 LLM 代发入口，再尝试做更深的直连适配
6. 在现有 trace store 基础上继续补 trace diff、导出 CLI 和自动复跑工具
7. 继续补充 live integration test，而不只依赖单元测试与本机手工验证
8. 将桌面壳打包为 `.app` / `.exe` / `.deb` 发布物，而不只是本地 `npm run desktop:start`
9. 管理台增加账号分组、备注标签、批量操作等高级管理功能
