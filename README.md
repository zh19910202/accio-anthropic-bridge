# Accio Anthropic Bridge

把 Anthropic / OpenAI 风格请求桥接到 Accio 本地登录态与本地网关。

当前定位：

- 对外暴露 `Anthropic Messages`、`OpenAI Chat Completions`、`OpenAI Responses` 最小可用子集
- 同一个 bridge 同时服务 `Claude Code` 与 `Codex` 两个主题
- `Claude Code` 走 Accio / Claude 账号池，`Codex` 走独立 Codex 凭证池
- 优先走主题内主号池，失败后只在同主题内尝试外部上游
- 支持多账号、额度预检、账号冷却、快照切换、外部兜底渠道
- 提供 Web 管理台和 Electron 桌面壳

## 风险说明

- 这是非官方、基于本地行为分析实现的桥接方案
- Accio 本地接口、认证字段、模型映射、网关行为都可能随版本变化而失效
- 本项目会复用你机器上的 Accio 登录态，日志、trace、调试输出可能包含敏感信息
- 是否允许这样使用登录态、是否会触发风控或封禁，需要你自己判断并承担风险
- 只建议用于本地研究、个人实验和协议验证

## 快速开始

要求：

- Node.js >= 22
- 本机已安装并可正常启动 Accio 桌面端

启动 bridge：

```bash
git clone <this-repo>
cd accio-anthropic-bridge
npm start
```

首次启动如果没有 `.env`，会自动执行 `npm run setup` 扫描本机 `~/.accio` 并生成配置。

默认地址：

- Bridge: `http://127.0.0.1:8082`
- 管理台: `http://127.0.0.1:8082/admin`

## 接入客户端

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
export ANTHROPIC_API_KEY=dummy
claude
```

`ANTHROPIC_API_KEY` 仅用于通过客户端本地校验，bridge 不校验这个值。

### Codex

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8082/v1
export OPENAI_API_KEY=dummy
codex
```

`Codex` 主题主入口是 `POST /v1/responses`，账号来自独立的 `config/codex-accounts.json`。

### Curl 示例

Anthropic Messages:

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"accio-bridge","max_tokens":256,"messages":[{"role":"user","content":"请只回复 OK"}]}'
```

OpenAI Chat Completions:

```bash
curl http://127.0.0.1:8082/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"accio-bridge","messages":[{"role":"user","content":"请只回复 OK"}]}'
```

## 管理台

打开方式：

```bash
npm run manager:open
```

或直接访问 `http://127.0.0.1:8082/admin`。

当前管理台支持：

- 查看本地网关状态、当前登录账号、最近一次请求实际出口
- 添加账号登录、保存当前账号、删除账号、切换账号
- 查看每个账号的额度状态、刷新时间、冷却状态、最近失败原因
- 通过 `Claude Code` / `Codex` 两个主标签管理两套主题
- 为 `Codex` 手动导入登录凭证包并管理独立账号池
- 分主题配置多个外部兜底渠道并调整优先级
- 外部兜底渠道保存后会持久化写入 `.env`，重启后仍会自动加载
- 外部渠道 `API Key` 在表单里默认隐藏，可通过右侧“眼睛”按钮切换显示或隐藏
- 测试外部渠道是否可用
- 通过 SSE 实时同步状态，常见操作不需要手动刷新

## 桌面壳

开发态启动：

```bash
npm run desktop:install
npm run desktop:start
```

打包：

```bash
npm run desktop:pack
npm run desktop:dist
```

当前已补齐的桌面能力：

- 可将管理台嵌入 Electron 窗口
- 可打包为 macOS 应用
- 打包后 bridge 从应用资源启动，不依赖仓库源码目录
- 运行时配置、账号池、session、trace 写入 Electron `userData`
- 桌面壳启动阶段优先用 `/healthz` 做 bridge 存活探测，避免用管理台重接口阻塞启动
- 已修复打包态下的路径、图标、Accio 自动拉起、账号快照写入等问题

## 当前支持

### Anthropic

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- 流式 SSE
- `tool_use` / `tool_result`

### OpenAI

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- 基础 streaming
- 基础 tools / tool_calls 适配

### 双主题路由

- `POST /v1/messages` -> `Claude Code` 主题
- `POST /v1/responses` -> `Codex` 主题
- `POST /v1/chat/completions` -> `Codex` 兼容入口，内部仍统一走 OpenAI / Responses 执行链

### 外部兜底渠道

管理台中的“协议”支持：

- `OpenAI Auto`
- `OpenAI Chat Completions`
- `OpenAI Responses`
- `Anthropic Messages`

说明：

- `OpenAI Auto` 只在首次探测一次可用端点，并按渠道缓存结果
- 已明确配置为 `Chat Completions` 或 `Responses` 的渠道不会再试错
- Anthropic 渠道会兼容根路径、`/v1`、`/messages`、`/v1/messages`

## 已知限制

- 当前兼容层是“协议适配 + Accio 上游执行”，不是完整官方实现
- `/v1/responses` 仍是最小子集，不覆盖全部 item / event 语义
- 图片、复杂 tool 语义、reasoning 细节不保证跨协议完全一致
- `thinking` 只在部分链路可用，外部上游是否真实支持 reasoning 也取决于上游本身
- 外部 fallback 主要用于文本兜底，不建议把复杂多模态或强工具链路完全寄托在它上面

## 认证与账号

`ACCIO_AUTH_MODE`：

- `auto`: 文件账号池 -> 环境变量 -> 本地网关
- `file`: 只使用账号池文件
- `env`: 只使用单 token
- `gateway`: 强制复用 Accio 本地登录态

账号快照命令：

```bash
npm run auth:state -- status
npm run auth:state -- list
npm run auth:state -- snapshot acct_a
npm run auth:state -- activate acct_a
```

其他辅助命令：

```bash
npm run capture-token -- --write-file --account-id acct_primary
npm run auth:relogin -- --write-file --account-id acct_primary --snapshot-alias acct_primary
npm run accounts:list
npm run accounts:probe
npm run accounts:activate -- acct_backup
npm run accounts:validate
```

## 常用环境变量

```bash
ACCIO_TRANSPORT=auto                     # auto | direct-llm | local-ws
ACCIO_AUTH_MODE=auto                     # auto | file | env | gateway
ACCIO_AUTH_STRATEGY=round_robin

ACCIO_ACCOUNTS_CONFIG_PATH=config/accounts.json
ACCIO_CODEX_ACCOUNTS_CONFIG_PATH=config/codex-accounts.json
ACCIO_ACCESS_TOKEN=
ACCIO_AUTH_ACCOUNT_ID=env-default

ACCIO_GATEWAY_AUTOSTART=1
ACCIO_APP_PATH=/Applications/Accio.app
ACCIO_GATEWAY_WAIT_MS=20000
ACCIO_GATEWAY_POLL_MS=500

ACCIO_FALLBACKS_JSON=
ACCIO_FALLBACK_PROTOCOL=openai           # openai | openai-chat-completions | openai-responses | anthropic
ACCIO_FALLBACK_OPENAI_BASE_URL=
ACCIO_FALLBACK_OPENAI_API_KEY=
ACCIO_FALLBACK_OPENAI_MODEL=
ACCIO_FALLBACK_ANTHROPIC_VERSION=2023-06-01
ACCIO_FALLBACK_OPENAI_TIMEOUT_MS=60000

ACCIO_CODEX_BASE_URL=https://api.openai.com/v1
ACCIO_CODEX_AUTH_STATE_PATH=.data/codex-auth-provider-state.json
ACCIO_CODEX_FALLBACKS_JSON=
ACCIO_CODEX_FALLBACK_BASE_URL=
ACCIO_CODEX_FALLBACK_API_KEY=
ACCIO_CODEX_FALLBACK_MODEL=
ACCIO_CODEX_FALLBACK_PROTOCOL=openai-responses
ACCIO_CODEX_FALLBACK_TIMEOUT_MS=60000
```

## 调试

健康检查：

```bash
curl http://127.0.0.1:8082/healthz
curl http://127.0.0.1:8082/admin/api/state
```

说明：

- `/healthz` 用于轻量判活，适合桌面壳启动探测和外部监控
- `/admin/api/state` 会构建完整管理台状态，信息更全，但开销明显更高

语法检查与测试：

```bash
npm run check
npm test
npm run desktop:check
```

## 项目结构

```text
src/
  server.js
  direct-llm.js
  external-fallback.js
  gateway-manager.js
  routes/
  stream/
scripts/
desktop/
config/
```

核心文件：

- `src/server.js`: HTTP 入口
- `src/routes/anthropic.js`: Anthropic 接口适配
- `src/routes/openai.js`: OpenAI 接口适配
- `src/direct-llm.js`: Accio 上游直连
- `src/external-fallback.js`: 外部兜底渠道
- `src/routes/admin.js`: 管理台与账号管理
- `desktop/main.js`: Electron 桌面壳主进程

## 当前状态

这个仓库现在更像一个“可用的本地桥 + 管理台 + 桌面应用”，不是一个追求完整官方协议覆盖的通用网关。

如果你只关心使用，优先记住这几件事：

1. 先让 Accio 本机可正常登录
2. 启动 bridge 后先看 `/admin`
3. 外部渠道优先用管理台配置，不要手改多份散落配置
4. 已知支持 `Responses` 的 OpenAI 渠道就直接指定，不要留给 `Auto`
