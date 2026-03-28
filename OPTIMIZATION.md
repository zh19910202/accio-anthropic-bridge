# Accio Anthropic Bridge — 优化状态

> 本文件已从“纯建议清单”更新为“已完成 / 剩余缺口”状态表，避免和当前实现脱节。

## 已完成

### 安全与健壮性

- 请求体大小限制已实现
  - `src/middleware/body-parser.js`
  - 通过 `ACCIO_MAX_BODY_BYTES` 配置
- 请求体读取超时已实现
  - 通过 `ACCIO_BODY_READ_TIMEOUT_MS` 配置
- 上游错误 token 脱敏已实现
  - `src/direct-llm.js`
- 网关 token 内存缓存已实现
  - 通过 `ACCIO_AUTH_CACHE_TTL_MS` 配置
- graceful shutdown 已实现
  - `src/server.js`

### 可观测性

- 结构化日志已实现
  - 请求开始/结束
  - 请求失败
  - direct-llm 决策日志
  - 模型解析与 transport 选择日志
- 健康检查已包含更多状态
  - 账号池摘要
  - models source
  - session store 摘要
  - body/auth cache 配置摘要

### 会话与状态管理

- session 过期清理已实现
  - `src/session-store.js`
  - 默认 7 天 TTL
- session 到 conversation 的持久化映射已实现
- session 级账号粘性已实现
  - 保存 `accountId` / `accountName`
- 可识别错误下的账号 failover 已实现
  - 401/403/429/503/529 等

### 协议与接口

- OpenAI `GET /v1/models` 已支持 `static | gateway | hybrid`
- OpenAI `POST /v1/responses` 已支持最小非流式子集
- Anthropic / OpenAI 工具请求结构校验已补齐
  - 非法 `tool_result`
  - 非法 `tool_call_id`
- thinking 基础支持已补齐
  - 仅 `direct-llm` 路径
  - 不支持路径会明确报错

### 工程化

- 单元测试已覆盖核心新增行为
  - body parser
  - models registry
  - tooling validation
  - auth provider active account
  - responses input conversion
  - thinking config

## 部分完成

### 多模态

已完成：
- URL / base64 到内部消息结构的最小映射

未完成：
- 真正的上传桥接
- 更完整的多模态响应映射

### `/v1/responses`

已完成：
- 最小非流式输入转换与响应输出

未完成：
- streaming responses
- 更完整的 output item 子集
- 更细粒度的 reasoning / tool item 对齐

### 日志

已完成：
- 请求级模型、transport、账号、失败分类日志

未完成：
- 更细的 trace replay
- 请求样本采样
- 问题复现辅助工具

## 仍然值得继续做

1. 完整的 tool loop 协议兼容，而不只是结构校验与基础映射。
2. `/v1/responses` streaming 与更完整 schema。
3. 图片上传与更多多模态格式桥接。
4. Electron helper 在显式授权前提下读取本地加密凭证。
5. 更深的直连适配，减少对当前上游私有网关形态的假设。
6. live integration tests，覆盖真实本地网关与上游交互。
