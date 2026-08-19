<div align="center">

# ✨ aistudio-web-api

**Turn the Google AI Studio web playground into your own callable Gemini API service.**

Exposes both the **Gemini-native API** and the **Interactions API** — with multimodal input, tool calling, thinking chains, multi-account rotation, and an AI Studio-style WebUI built for desktop and mobile.

![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=for-the-badge&logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?style=for-the-badge&logo=fastify&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=node.js&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11-F69220?style=for-the-badge&logo=pnpm&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**[中文](./README.md)** · [English](./README_EN.md)

</div>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#api-usage">API Usage</a> ·
  <a href="#webui">WebUI</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#architecture">Architecture</a>
</p>

---

> [!IMPORTANT]
> Model discovery and generation run through a logged-in Google AI Studio browser session. Only run it with Google accounts and network environments you are authorized to use.
>
> This project provides the Gemini-native API, Interactions API, multimodal input, tool calling, multi-account rotation, and an AI Studio-style WebUI. Model access credentials come from the AI Studio session.

---

## ✨ Features

|  | Capability | Description |
|:---:|---|---|
| ⚡ | **Gemini-native API** | `/v1beta/models/{model}:generateContent`, `:streamGenerateContent`, `/v1beta/models` |
| 💬 | **Interactions API** | `/v1/interactions`, `/v1beta/interactions`, and `/v1beta2/interactions` (create / get / delete / list / cancel), locally emulated `previous_interaction_id` server state, standard-SSE events (`interaction.created` → `interaction.completed` / `interaction.requires_action`), client-disconnect abort |
| 🖥️ | **Native TypeScript backend** | Fastify, CloakBrowser, BotGuard hooks, wire codec, response parsing, and Interactions state all run in Node.js |
| 🌐 | **WebUI** | AI Studio-style interface: chat, history, accounts, usage stats; mobile drawer layout |
| 📡 | **Live model catalog** | Reads the AI Studio panel through the logged-in browser session, with a built-in fallback list on failure |
| 🛠️ | **Native tools** | WebUI and API support explicit Google Search, Code Execution, Google Maps, URL Context, and custom `functionCall` / `functionResponse` replay with `thought_signature` passthrough |
| 🧠 | **Thinking** | Thought steps / streaming text deltas, `thinking_signature` passthrough, `total_thought_tokens` accounting |
| 🖼️ | **Multimodal** | The Chat page reads images, audio, video, PDF, text, and code files; the native API accepts `inlineData` and existing Google Files `fileData` |
| 🛡️ | **Anti-detection** | CloakBrowser fingerprint-evasion Chromium, BotGuard snapshot auto-location via feature matching |
| 🔁 | **Multi-account management** | Local browser login, remote assisted login, cookie import, request-level round-robin / LRU / least-rate-limited rotation, and automatic cooldown after 429s |
| 👤 | **Account profile** | Best-effort sync of nickname, avatar, and Free/Pro/Ultra tier from AI Studio / Google Account pages, with manual refresh and stale-data fallback |

## 🚀 Quick Start

<details open>
<summary><b>Install & start</b></summary>

```bash
# 1. Clone the repository
git clone https://github.com/gaoao-3/aistudio-api.git
cd aistudio-api

# 2. Install frontend and backend dependencies
pnpm run setup

# 3. Build frontend static assets and the TypeScript backend
pnpm run build

# 4. Start the service (default: 0.0.0.0:3006)
pnpm start:fast
```

</details>

Open **<http://localhost:3006>** and follow these steps:

> [!NOTE]
> **First-time setup:**
>
> 1. Go to the **Accounts** page.
> 2. Sign in through a local browser, use remote assisted login, or import Google cookies.
> 3. Chat in the **Chat** page, or use the API below.

> [!WARNING]
> Remote assisted login requires API authentication. When the service is not accessed only from localhost, put it behind HTTPS. Passwords and verification codes are forwarded only to the current one-time CloakBrowser session and are not written to logs or account metadata.

## 🔑 Authentication

Once `AISTUDIO_API_KEY` is set, use `Authorization: Bearer <key>`, `x-api-key`, `x-goog-api-key`, or the `?key=` query parameter. The official google-genai SDK can point its `base_url` at this service directly.

API keys only authenticate external requests. Built-in Google tools are WebUI-only: native tool declarations are removed from external API requests before they reach AI Studio, while local custom function tools remain available.

## 📚 API Usage

### 💬 Interactions API (recommended)

The service accepts the current official `/v1beta/interactions`, stable `/v1/interactions`, and the `/v1beta2/interactions` path used by the migration guide. The examples below use the migration-guide path.

```bash
# Basic chat
curl http://localhost:3006/v1beta2/interactions \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"model": "gemini-3-flash-preview", "input": "Hello!"}'

# Streaming
curl http://localhost:3006/v1beta2/interactions \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "input": "Explain quantum entanglement in three sentences.",
    "stream": true
  }'

# Multi-turn with server-side state (emulated locally)
curl http://localhost:3006/v1beta2/interactions \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "input": "What about tomorrow?",
    "previous_interaction_id": "v1_xxx"
  }'
```

# Generation parameters use snake_case and are mapped to the
# generateContent camelCase wire names automatically
curl http://localhost:3006/v1beta2/interactions \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-3-flash-preview",
    "input": "Draw an image",
    "generation_config": {
      "thinking_level": "low",
      "image_config": { "aspect_ratio": "1:1", "image_size": "1K" }
    }
  }'

Streaming responses use standard SSE framing (`event:` + `data:` lines):

```text
event: interaction.created    # carries the interaction object
event: interaction.in_progress
event: step.start             # declares the step type via index / step
event: step.delta             # text / image / audio increments
event: step.stop
event: interaction.completed  # or interaction.requires_action (awaiting a function call)
event: done
data: [DONE]
```

Thinking text and body text both arrive as `step.delta`; the index→type mapping from `step.start` tells them apart, and tool round-trips end with `requires_action`. Disconnecting the client aborts the upstream browser request and releases the account.

**Official SDK:**

```python
from google import genai

client = genai.Client(
    api_key="your-secret-token",
    http_options={"base_url": "http://localhost:3006"},
)
r = client.interactions.create(model="gemini-3-flash-preview", input="Hello")
```

### ⚡ Gemini-native API

```bash
curl http://localhost:3006/v1beta/models/gemini-3-flash-preview:generateContent \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Hello"}]}],
    "tools": [{"googleSearchRetrieval": {}}]
  }'

# Model list (live with a logged-in AI Studio account; built-in fallback otherwise)
curl http://localhost:3006/v1beta/models -H "Authorization: Bearer your-secret-token"
```

## 🌐 WebUI

| Page | Description |
|:---:|---|
| 💬 **Chat** | streaming, collapsible thinking, multimedia/file upload, image generation, Google Search / Code Execution / Google Maps / URL Context, tool-call cards, and run settings |
| 🕘 **History** | stored interactions; click to load and continue, deletable |
| 👤 **Accounts** | multi-account login, request-level rotation, rate-limit cooldown, activate/delete, profile and tier refresh |
| 🔑 **API keys** | create, inspect, and delete local service keys used for API authentication |
| ⚙️ **Service settings** | Adjust request size, browser/login timeouts, Interaction retention, account throttling, and proxy settings, with restart status |
| 📊 **Stats** | per-model requests, rate limits, token usage |

## 🔧 Configuration

Via environment variables or a `.env` file (see `.env.example`). Common options:

| Variable | Default | Description |
|----------|---------|-------------|
| `AISTUDIO_PORT` | `3006` | API port |
| `AISTUDIO_HOST` | `0.0.0.0` | Listen address |
| `AISTUDIO_API_KEY` | empty | Enables auth when set |
| `AISTUDIO_BROWSER_HEADLESS` | `true` | Run CloakBrowser headlessly |
| `AISTUDIO_BROWSER_TIMEOUT_MS` | `120000` | Browser upstream timeout in milliseconds |
| `AISTUDIO_API_BODY_LIMIT_BYTES` | `33554432` | Maximum API request body size in bytes (32 MiB by default) |
| `AISTUDIO_LOGIN_TIMEOUT_MS` | `600000` | Google login flow timeout in milliseconds |
| `AISTUDIO_LOGIN_SESSION_RETENTION_MS` | `600000` | Retention period for completed login session status in milliseconds |
| `AISTUDIO_PROXY_URL` | system proxy | Browser proxy URL |
| `AISTUDIO_RUNTIME_ROOT` | project root | Runtime directory containing accounts, keys, interactions, and stats |
| `AISTUDIO_AUTH_FILE` | active account | Playwright storage state used by CloakBrowser |
| `AISTUDIO_INTERACTIONS_DIR` | `data/interactions` | Interaction state directory |
| `AISTUDIO_INTERACTIONS_MAX_COUNT` | `30` | Keep only the newest interactions; `0` disables the count limit |
| `AISTUDIO_INTERACTIONS_TTL_SECONDS` | `0` | Optional time-based cleanup in seconds; `0` disables time expiration |
| `AISTUDIO_ACCOUNT_ROTATION_MODE` | `round_robin` | Account rotation mode: `round_robin` / `lru` / `least_rl` |
| `AISTUDIO_ACCOUNT_COOLDOWN_SECONDS` | `60` | Cooldown after a 429/quota-limit response, in seconds |
| `AISTUDIO_ACCOUNT_MAX_RETRIES` | `3` | Maximum accounts attempted for one request |
| `AISTUDIO_ACCOUNT_PROFILE_REFRESH_MS` | `21600000` | Suggested account-profile refresh interval in milliseconds |

> [!NOTE]
> Per-model defaults (thinking, safety, default tools, ...) live in `config.yaml`.
>
> The WebUI service settings page reads and writes the runtime settings through `GET/PUT /config/runtime`. Values are persisted to the runtime `.env`; an already running Fastify process keeps the values loaded at startup, so settings marked for restart must be followed by a service restart.

## 🧱 Architecture

```text
Client (Gemini SDK / WebUI / curl)
    │
    ▼
┌──────────────────────────┐
│   Fastify server          │  Gemini-native + Interactions routes
│   /v1beta/...            │  rotation / state store / live catalog
└───────────┬──────────────┘
            ▼
┌──────────────────────────┐
│   TypeScript Gateway      │  API format → AI Studio wire body
│   + BotGuard snapshot     │  feature-matched snapshot function
└───────────┬──────────────┘
            ▼
┌──────────────────────────┐
│   CloakBrowser            │  anti-fingerprint Chromium + cookies
│   (headless)              │  streaming fetch sends requests
└───────────┬──────────────┘
            ▼
      Google AI Studio
```

> [!NOTE]
> **BotGuard** — every request needs an encrypted snapshot proving a real browser. The snapshot generator is hooked at runtime and located by feature matching (`.snapshot({` + `content` + `yield`), so Google renaming the function in bundle updates does not break it.
>
> **Live model catalog** — the logged-in AI Studio browser session supplies the credentials for model discovery and generation.

## 🙏 Acknowledgements

- [chrysoljq/aistudio-api](https://github.com/chrysoljq/aistudio-api) — upstream project
- [LuanRT/BgUtils](https://github.com/LuanRT/BgUtils)
- [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI)
- [linux.do](https://linux.do)

## 📄 License

MIT

---

<p align="center">
  <sub>Built with ❤️ & TypeScript · If this project helps you, give it a ⭐</sub>
</p>
