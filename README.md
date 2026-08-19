<div align="center">

# ✨ aistudio-web-api

**只通过 Google AI Studio 网页会话，为自托管应用提供可调用的 Gemini API 服务。**

服务使用 TypeScript、Fastify 和 CloakBrowser，把已登录的 AI Studio 账号封装成 Gemini 原生接口与 Interactions API，并提供一套适配桌面端和移动端的 WebUI。

![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?style=for-the-badge&logo=fastify&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11-F69220?style=for-the-badge&logo=pnpm&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**[English](./README_EN.md)** · [中文](./README.md)

</div>

<p align="center">
  <a href="#项目定位">项目定位</a> ·
  <a href="#功能特性">功能特性</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#首次登录">首次登录</a> ·
  <a href="#api-用法">API 用法</a> ·
  <a href="#配置">配置</a>
</p>

---

## 项目定位

本项目把 **Google AI Studio 网页版**转换成一个可自托管的 API 服务：

```text
你的应用 / SDK / WebUI
          │
          ▼
   本地 Fastify 服务
          │  鉴权、路由、统计、账号轮询
          ▼
   CloakBrowser 浏览器会话
          │  登录 Cookie、BotGuard、AI Studio 页面请求
          ▼
      Google AI Studio
```

> [!IMPORTANT]
> 模型目录和生成请求都通过已登录的 Google AI Studio 浏览器会话执行，请只使用你有权使用的 Google 账号和网络环境。
>
> 本项目提供 Gemini 原生生成接口、Interactions API、多模态输入、工具调用、多账号轮询和 WebUI；模型访问凭据由 AI Studio 登录会话提供。

## 功能特性

| 能力 | 说明 |
|---|---|
| Gemini 原生接口 | `generateContent` 非流式生成、`streamGenerateContent` SSE 流式生成 |
| Interactions API | `/v1/interactions`、`/v1beta/interactions`、`/v1beta2/interactions` 的创建、查询、列表、删除和流式事件 |
| Interactions API | `/v1/interactions`、`/v1beta/interactions`、`/v1beta2/interactions` 的创建、查询、列表、删除和标准 SSE 流式事件 |
| 多模态输入 | 图片、音频、视频、PDF、文本和常见代码文件；支持 `inlineData` 与 Google Files `fileData` |
| 原生工具 | WebUI 和 API 可显式使用 Google 搜索、代码执行、Google Maps、URL Context；自定义函数调用保留多轮所需的 `thought_signature` |
| 思考与统计 | 思考摘要、SSE 增量、token 用量和按模型统计 |
| 多账号轮询 | `round_robin`、`lru`、`least_rl`；遇到 429 或配额限制时自动冷却并切换账号 |
| WebUI | 对话、历史、账号、API 密钥、统计和服务设置，适配桌面端与移动端 |
| 安全转发 | CloakBrowser 管理浏览器会话，HTTP 层支持本地 API Key 鉴权 |

## 运行前提

- [Node.js](https://nodejs.org/) 22 或兼容版本
- [pnpm](https://pnpm.io/) 11
- 一个可以正常访问 [Google AI Studio](https://aistudio.google.com/) 的 Google 账号
- 本机登录、远程辅助登录或 Cookie 导入方式三选一
- 如果部署在局域网或公网，建议配置 API Key 并使用 HTTPS 反向代理

## 快速开始

```bash
# 1. 克隆项目并进入目录
git clone https://github.com/gaoao-3/aistudio-api.git
cd aistudio-api

# 2. 安装前后端依赖
pnpm run setup

# 3. 可选：复制环境变量示例
cp .env.example .env

# 4. 构建前端静态资源和 TypeScript 后端
pnpm run build

# 5. 启动服务，默认监听 0.0.0.0:3006
pnpm start:fast
```

启动后访问：<http://localhost:3006/>

Windows PowerShell 可以使用：

```powershell
Copy-Item .env.example .env
pnpm run build
pnpm start:fast
```

只修改后端时可以运行 `pnpm start`，它会重新编译 backend-ts；修改前端后仍需重新执行根目录的 `pnpm run build`。

### 运行目录

默认情况下，账号、Cookie、API 密钥、统计、Interactions 和 `.env` 位于项目目录的 `data/` 及配置文件中。也可以把运行数据放到其他目录：

```powershell
powershell -File backend-ts/start.ps1 `
  -RuntimeRoot "D:/path/to/aistudio-runtime" `
  -Port 3006 `
  -SkipBuild
```

或者在 `.env` 中设置：

```dotenv
AISTUDIO_RUNTIME_ROOT=D:/path/to/aistudio-runtime
```

## 首次登录

启动后按以下顺序操作：

1. 打开 WebUI 的「账号」页面。
2. 选择本机登录、远程辅助登录，或导入 Google Cookie。
3. 激活一个能正常访问 AI Studio 的账号。
4. 回到「对话」页面，选择模型并开始请求。

服务会在托管浏览器中复用登录状态。请求 `/v1beta/models` 时，浏览器会从 AI Studio 页面取得页面内部凭据，再读取面板模型目录；服务不会要求用户填写 Google Gemini API Key。

> [!WARNING]
> 远程辅助登录必须先配置本地 API Key。密码和验证码只在一次性登录会话中转发，不会写入项目文件、日志或账号资料。

## 鉴权

未配置 API Key 时，接口默认不要求鉴权，适合本机临时使用。配置 `AISTUDIO_API_KEY` 或 `AISTUDIO_API_KEYS` 后，可以使用以下任一形式：

```text
Authorization: Bearer <key>
x-api-key: <key>
x-goog-api-key: <key>
?key=<key>
```

也可以在 WebUI 的「API 密钥」页面创建和删除密钥。API 密钥只用于本地接口鉴权；Google 搜索、代码执行、Google Maps、URL Context 等内置原生工具仅供 WebUI 会话使用。

> [!NOTE]
> `AISTUDIO_API_KEY` / `AISTUDIO_API_KEYS` 是保护本项目 HTTP 接口的**本地服务密钥**，不是 Google Gemini API Key，也不参与 AI Studio 模型请求。

> [!WARNING]
> 完整密钥只在创建时显示一次。不要提交 `.env`、`data/accounts`、`data/apikeys.json` 或包含运行日志的目录。

API 请求中的内置原生工具声明会被移除，不会发送到 AI Studio；本地自定义函数工具会保留并继续执行。内置原生工具不会通过 API 密钥授权或配置。

## API 用法

### 常用路由

| 方法 | 路径 | 说明 |
|:---:|---|---|
| `GET` | `/health` | 服务健康检查 |
| `GET` | `/auth/check` | 鉴权状态和运行能力 |
| `GET` | `/v1beta/models` | AI Studio 实时模型目录；失败时返回内置兜底目录 |
| `GET` | `/v1beta/models/{model}` | 查询单个模型 |
| `POST` | `/v1beta/models/{model}:generateContent` | Gemini 原生非流式生成 |
| `POST` | `/v1beta/models/{model}:streamGenerateContent` | Gemini 原生 SSE 流式生成 |
| `POST` / `GET` / `DELETE` | `/v1/interactions` 等 | Interactions 创建、查询和删除 |
| `GET` / `POST` / `PUT` / `DELETE` | `/api-keys` | 创建、查看、更新权限和删除本地服务密钥 |
| `GET` | `/stats` | 用量统计 |
| `GET` / `PUT` | `/config/runtime` | 运行时配置 |
| `GET` / `POST` | `/rotation` 相关接口 | 账号轮询状态和切换 |

### 读取模型目录

```bash
curl http://localhost:3006/v1beta/models
```

开启本地鉴权时：

```bash
curl http://localhost:3006/v1beta/models \
  -H "Authorization: Bearer <AISTUDIO_API_KEY>"
```

响应中的 `source` 有两种值：

- `live`：从已登录的 AI Studio 面板读取成功。
- `fallback`：浏览器未登录、Cookie 失效、页面协议变化或网络失败，暂时使用内置目录。

兜底目录只用于保持接口可发现性；实际生成仍需要可用的 AI Studio 登录会话。

### Gemini 原生生成

普通生成：

```bash
curl http://localhost:3006/v1beta/models/gemini-3-flash-preview:generateContent \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [{"text": "你好，请介绍一下你自己。"}]
    }]
  }'
```

流式生成：

```bash
curl http://localhost:3006/v1beta/models/gemini-3-flash-preview:streamGenerateContent \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{
      "role": "user",
      "parts": [{"text": "请分三步解释这个问题。"}]
    }]
  }'
```

多模态内容使用 Gemini 原生格式，例如：

```json
{
  "contents": [{
    "role": "user",
    "parts": [
      { "text": "请总结这个 PDF。" },
      { "inlineData": { "mimeType": "application/pdf", "data": "JVBERi0x..." } }
    ]
  }]
}
```

已有 Google Files 可以使用 `fileData`：

```json
{
  "contents": [{
    "role": "user",
    "parts": [{
      "fileData": {
        "mimeType": "application/pdf",
        "fileUri": "https://generativelanguage.googleapis.com/v1beta/files/FILE_ID"
      }
    }]
  }]
}
```

### Interactions API

推荐使用 `/v1beta/interactions`；`/v1/interactions` 和 `/v1beta2/interactions` 使用同一套本地实现。

```bash
curl http://localhost:3006/v1beta/interactions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "input": "你好，请介绍一下你自己。",
    "store": true
  }'
```

常用字段：

| 字段 | 说明 |
|---|---|
| `model` | AI Studio 模型名 |
| `input` | 文本、数组或多模态输入 |
| `stream` | `true` 时返回 SSE |
| `store` | 是否保存 Interaction，默认为保存 |
| `previous_interaction_id` | 继续已有多轮 Interaction |
| `generation_config` | 生成参数（蛇形命名）：`top_p`、`top_k`、`max_output_tokens`、`stop_sequences`、`temperature`、`thinking_level`、`image_config` 等，自动映射为 Gemini 的 camelCase 名称 |

Interactions 会保存到运行目录。默认只保留最新 30 条；`AISTUDIO_INTERACTIONS_MAX_COUNT=0` 表示不限制条数，也可以使用 `AISTUDIO_INTERACTIONS_TTL_SECONDS` 启用按时间清理。

流式请求（`stream: true`）返回标准 SSE 事件序列：

```text
event: interaction.created    # 创建成功，携带 interaction 对象
event: interaction.in_progress
event: step.start             # index / step 声明步骤类型
event: step.delta             # text / image / audio 增量
event: step.stop
event: interaction.completed  # 或 interaction.requires_action（等待函数调用）
event: done
data: [DONE]
```

思考文本和正文都通过 `step.delta` 下发，用 `step.start` 里的 index → 类型区分；函数调用结果以 `requires_action` 结束。客户端断开连接时，服务会中止对应的上游浏览器请求并释放账号。

## WebUI

| 页面 | 能力 |
|---|---|
| 对话 | 流式输出、思考摘要、Google 搜索、代码执行、Google Maps、URL Context、工具调用卡片、生图和多模态附件 |
| 历史 | 查看、继续和删除已保存的 Interactions；当前对话也会保存在浏览器本地缓存 |
| 账号 | 本机登录、远程登录、Cookie 导入、激活、删除和账号资料刷新 |
| API 密钥 | 创建、查看前缀和删除本地服务密钥；密钥仅用于接口鉴权 |
| 统计 | 查看模型请求数、成功率、限流、错误和 token 用量 |
| 服务设置 | 调整请求体上限、浏览器/登录超时、历史保留、账号轮询和代理 |

附件通过浏览器读取并转换为 base64，不会把手机本地路径发送给后端。当前 WebUI 限制为单文件 15 MiB、总大小 16 MiB；服务默认 JSON 请求体上限为 32 MiB。

## 账号轮询

账号页面支持多个 Google 账号。可选策略：

| 策略 | 说明 |
|---|---|
| `round_robin` | 按顺序轮换 |
| `lru` | 优先较久未使用的账号 |
| `least_rl` | 优先近期被限流较少的账号 |

请求遇到 429 或配额限制时，当前账号会进入冷却，并在剩余重试次数内尝试其他可用账号。账号资料刷新是尽力行为，页面结构变化或 Cookie 失效时会保留上一次成功资料。

## 配置

配置可以放在运行目录的 `.env` 文件，也可以使用环境变量。完整示例见 [.env.example](./.env.example)。

### 服务与浏览器

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `AISTUDIO_PROJECT_ROOT` | 自动查找 | 项目根目录 |
| `AISTUDIO_RUNTIME_ROOT` | 项目目录 | 账号、状态、统计和 `.env` 所在目录 |
| `AISTUDIO_HOST` | `0.0.0.0` | 监听地址 |
| `AISTUDIO_PORT` | `3006` | 监听端口 |
| `AISTUDIO_API_KEY` / `AISTUDIO_API_KEYS` | 空 | 一个或多个本地 HTTP API Key |
| `AISTUDIO_APIKEYS_FILE` | `data/apikeys.json` | WebUI 创建的密钥存储文件 |
| `AISTUDIO_BROWSER_HEADLESS` | `true` | 是否无头运行 CloakBrowser |
| `AISTUDIO_BROWSER_TIMEOUT_MS` | `120000` | 浏览器请求超时，单位毫秒 |
| `AISTUDIO_API_BODY_LIMIT_BYTES` | `33554432` | 请求体上限，默认 32 MiB |
| `AISTUDIO_PROXY_URL` | 系统代理 | 浏览器使用的代理地址 |
| `AISTUDIO_AUTH_FILE` | 自动选择 | Playwright storage state 文件 |

### 登录与历史

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `AISTUDIO_LOGIN_TIMEOUT_MS` | `600000` | 登录流程最长等待时间 |
| `AISTUDIO_LOGIN_SESSION_RETENTION_MS` | `600000` | 已结束登录会话保留时间 |
| `AISTUDIO_INTERACTIONS_DIR` | `data/interactions` | Interaction JSON 存储目录 |
| `AISTUDIO_INTERACTIONS_MAX_COUNT` | `30` | 只保留最新记录条数，`0` 表示不限制 |
| `AISTUDIO_INTERACTIONS_TTL_SECONDS` | `0` | 按时间清理秒数，`0` 表示不按时间删除 |

### 账号轮询与模型默认值

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `AISTUDIO_ACCOUNTS_DIR` | `data/accounts` | 账号和 Cookie 存储目录 |
| `AISTUDIO_ACCOUNT_ROTATION_MODE` | `round_robin` | `round_robin` / `lru` / `least_rl` |
| `AISTUDIO_ACCOUNT_COOLDOWN_SECONDS` | `60` | 429 或配额错误后的冷却时间 |
| `AISTUDIO_ACCOUNT_MAX_RETRIES` | `3` | 单次请求最多尝试账号数 |
| `AISTUDIO_ACCOUNT_PROFILE_REFRESH_MS` | `21600000` | 账号资料建议刷新间隔 |
| `AISTUDIO_STATS_FILE` | `data/stats.json` | 用量统计文件 |
| `AISTUDIO_MODEL_DEFAULTS_FILE` | `config.yaml` | 模型默认参数 YAML |

> [!NOTE]
> 模型访问使用 AI Studio 账号的浏览器会话；`AISTUDIO_API_KEY` / `AISTUDIO_API_KEYS` 仅用于保护本地 HTTP 服务。

## 开发与验证

```bash
# 类型检查
pnpm typecheck

# 后端测试
pnpm test

# 构建前端和后端
pnpm build

# 后端开发模式
pnpm dev:backend

# 前端开发模式
pnpm dev:frontend
```

## 安全说明

- 本项目不会把 Google 密码写入项目文件。
- 账号 Cookie、API 密钥、`.env` 和运行日志都属于敏感数据，请限制文件和端口访问权限。
- 公网部署时请使用 HTTPS 反向代理，并始终启用本地 API Key 鉴权。
- 请遵守 Google AI Studio 的服务条款、账号权限和所在地区网络法规。

## 致谢

- [chrysoljq/aistudio-api](https://github.com/chrysoljq/aistudio-api)
- [LuanRT/BgUtils](https://github.com/LuanRT/BgUtils)
- [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI)
- [linux.do](https://linux.do)

## License

MIT

---

<p align="center">
  <sub>Built with ❤️ & TypeScript · If this project helps you, give it a ⭐</sub>
</p>
