<div align="center">

<img src="assets/logo.svg" width="132" alt="aistudio-web-api logo" />

# aistudio-web-api

**Turn the Google AI Studio web playground into your own callable Gemini API service.**

Exposes the **Gemini-native `generateContent` API** through a logged-in AI Studio session, with multimodal input, tool calling, thinking chains, multi-account rotation, and an AI Studio-style WebUI built for desktop and mobile.

Ciallo～(∠・ω< )⌒☆

<p>
  <img src="assets/badge-typescript.svg" alt="TypeScript" />
  &nbsp;
  <img src="assets/badge-fastify.svg" alt="Fastify" />
  &nbsp;
  <img src="assets/badge-node.svg" alt="Node.js" />
  &nbsp;
  <img src="assets/badge-pnpm.svg" alt="pnpm" />
  &nbsp;
  <img src="assets/badge-license.svg" alt="MIT License" />
</p>

**[中文](./README.md)** · [English](./README_EN.md)

</div>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#api-usage">API Usage</a> ·
  <a href="#webui">WebUI</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#faq">FAQ</a> ·
  <a href="#-docker-deployment">Docker</a>
</p>

---

> [!IMPORTANT]
> Model discovery and generation run through a logged-in Google AI Studio browser session. Only run it with Google accounts and network environments you are authorized to use.
>
> This project provides the Gemini-native generation API, multimodal input, tool calling, multi-account rotation, and an AI Studio-style WebUI. Model access credentials come from the AI Studio session.

---

## ✨ Features

|  | Capability | Description |
|:---:|---|---|
| ⚡ | **Gemini-native API** | `/v1` and `/v1beta` model routes for `generateContent`, `streamGenerateContent`, authoritative `countTokens`, and model discovery |
| 🤝 | **OpenAI-compatible API** | `/v1/chat/completions` (non-streaming + SSE streaming with `data: [DONE]`) and `/v1/models`, so OpenAI SDK / One-API / New-API clients can point `base_url` straight at this service |
| 🖥️ | **Native TypeScript backend** | Fastify, CloakBrowser, BotGuard hooks, wire codec, response parsing, and native request routing all run in Node.js |
| 🌐 | **WebUI** | AI Studio-style interface: chat, history, accounts, usage stats; mobile drawer layout |
| 📡 | **Live model catalog** | Reads the AI Studio panel through the logged-in browser session, refreshes about every 15 minutes, and keeps a last-known-good snapshot plus a built-in fallback |
| 🛠️ | **Native tools** | WebUI can use Google Search, Code Execution, Google Maps, and URL Context; the API supports the full native Function Calling loop (declaration → `functionCall` → client-side execution → `functionResponse` → final answer) |
| 🧠 | **Thinking** | Thought steps / streaming text deltas, `thinking_signature` passthrough, `total_thought_tokens` accounting |
| 🖼️ | **Multimodal** | The Chat page reads images, audio, video, PDF, text, and code files; the native API accepts `inlineData` and existing Google Files `fileData` |
| 🛡️ | **Anti-detection** | CloakBrowser fingerprint-evasion Chromium, BotGuard snapshot auto-location via feature matching |
| 🔁 | **Multi-account management** | Local browser login, remote assisted login, cookie import, request-level round-robin / LRU / least-rate-limited rotation, automatic cooldown after 429s, and long-lived account×model skip after upstream 403 permission errors |
| 👤 | **Account profile** | Best-effort sync of nickname, avatar, and Free/Pro/Ultra tier from AI Studio / Google Account pages, with manual refresh and stale-data fallback |
| 🧰 | **Reliability** | Automatic retry on network-level streaming failures, browser idle auto-close with startup watchdog, and self-healing of corrupted request templates |
| 🐳 | **Docker deployment** | Multi-stage image with frontend build, backend compile, and CloakBrowser Chromium baked in; data persisted via volume |

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

> [!TIP]
> Prefer Docker? A multi-stage image with everything baked in is available — see [Docker Deployment](#-docker-deployment).

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

API keys only authenticate external requests. Built-in Google tools are WebUI-only: native tool declarations are removed from external API requests, while local custom function declarations are retained for the client to execute and answer with `functionResponse`.

## 📚 API Usage

### ⚡ Gemini-native API

The service exposes the Gemini `generateContent` contract through both `/v1` and `/v1beta`. Requests use the native `contents` / `parts` schema and can include multimodal data, thinking configuration, tools, structured output, safety settings, and custom function declarations.

`POST /v1beta/models/{model}:countTokens` returns the authoritative input token count (`{"totalTokens": N}`) without consuming generation quota. `generationConfig` is validated against the live ListModels catalog: `maxOutputTokens` beyond the model limit, out-of-range `temperature`/`topP`/`topK`, or an unsupported `thinkingLevel` fail fast with HTTP 400.

For native Function Calling, keep the model part (including `thoughtSignature`) from the first response, then append a `functionResponse` user part with the same call `id`; the service automatically re-attaches the first-turn `responseId` and pins the original account, so clients never handle continuation IDs. Scalar results must be wrapped as `{ "response": <value> }`.

```bash
# Export the key created in the WebUI; avoid putting credentials in shell history.
export AISTUDIO_API_KEY="<key-created-in-webui>"

# Non-streaming
curl http://localhost:3006/v1beta/models/gemini-3.8-flash:generateContent \
  -H "Authorization: Bearer ${AISTUDIO_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Hello"}]}]}'

# Streaming
curl http://localhost:3006/v1beta/models/gemini-3.8-flash:streamGenerateContent \
  -H "Authorization: Bearer ${AISTUDIO_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"Explain quantum entanglement."}]}]}'

# Model list
curl http://localhost:3006/v1beta/models -H "Authorization: Bearer ${AISTUDIO_API_KEY}"
```

For Gemini 3 multi-turn requests, preserve returned `thought` parts and `thoughtSignature` values. Native `functionResponse` failures are returned unchanged: the gateway never rewrites tool history as text or masks an upstream failure with a fallback prompt.

### 🤝 OpenAI-compatible API

The service also exposes OpenAI protocol endpoints (adapter approach modeled on AIStudio2API), so OpenAI SDK / One-API / New-API clients can point `base_url` directly at this service:

| Method | Path | Description |
| :---: | --- | --- |
| `GET` | `/v1/models` | Model list as `{"object": "list", "data": [...]}` |
| `POST` | `/v1/chat/completions` | Chat completion; with `"stream": true` returns SSE `chat.completion.chunk` frames terminated by `data: [DONE]` |

```bash
# Non-streaming
curl http://localhost:3006/v1/chat/completions \
  -H "Authorization: Bearer ${AISTUDIO_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.8-flash","messages":[{"role":"user","content":"Hello"}],"temperature":0.7}'

# Streaming (OpenAI SDK)
from openai import OpenAI
client = OpenAI(api_key="${AISTUDIO_API_KEY}", base_url="http://localhost:3006/v1")
stream = client.chat.completions.create(
    model="gemini-3.8-flash",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

Supported request fields:

- `messages`: `system`/`developer`, `user` (text, `image_url` data URIs, `file` data URIs), `assistant` (with `tool_calls`), and `tool` result messages (function name resolved via `tool_call_id`).
- Sampling/output: `temperature`, `top_p`, `top_k`, `max_tokens`/`max_completion_tokens`, `stop`, `response_format` (`json_object` / `json_schema`), `reasoning_effort` (mapped to the Gemini thinkingLevel).
- Tools: `tools` (function declarations) and `tool_choice` (`auto`/`none`/`required`/specific function).
- Streaming: `stream` and `stream_options.include_usage` (the final frame carries `usage`).
- Gemini 3 tool calls return the opaque thought signature in `tool_calls[].extra_content.google.thought_signature`; clients must preserve it unchanged in the next request.

Notes: thinking content is returned in `reasoning_content` (incremental frames when streaming); errors use the OpenAI envelope `{"error": {"message", "type", "code"}}`; authentication matches the Gemini routes (`Authorization: Bearer` or `x-api-key`). Remote image URLs are not supported — use data URIs instead.

## 🌐 WebUI

| Page | Description |
|:---:|---|
| 💬 **Chat** | streaming, collapsible thinking, multimedia/file upload, image generation, Google Search / Code Execution / Google Maps / URL Context, tool-call cards, and run settings |
| 🕘 **History** | current conversation stored locally in the browser; open or clear it |
| 👤 **Accounts** | multi-account login, request-level rotation, rate-limit cooldown, activate/delete, profile and tier refresh |
| 🔑 **API keys** | create, inspect, and delete local service keys used for API authentication |
| ⚙️ **Service settings** | Adjust request size, browser/login timeouts, account throttling, and proxy settings, with restart status |
| 📊 **Stats** | per-model requests, rate limits, token usage |

## 🔧 Configuration

Via environment variables or a `.env` file (see `.env.example`). Common options:

| Variable | Default | Description |
|----------|---------|-------------|
| `AISTUDIO_PORT` | `3006` | API port |
| `AISTUDIO_HOST` | `0.0.0.0` | Listen address |
| `AISTUDIO_API_KEY` | empty | Enables auth when set |
| `AISTUDIO_BROWSER_HEADLESS` | `true` | Run CloakBrowser headlessly |
| `AISTUDIO_BROWSER_IDLE_TIMEOUT_MS` | `1800000` | Close a browser after this many milliseconds of inactivity; `0` disables idle close |
| `AISTUDIO_BROWSER_MAX_ALIVE_INSTANCES` | `2` | Keep a two-account warm pool; evict the least recently used account when exceeded; `0` disables the cap |
| `AISTUDIO_BROWSER_STANDBY_IDLE_TIMEOUT_MS` | `600000` | Close an inactive non-active account context while preserving its Profile; `0` disables standby eviction |
| `AISTUDIO_BROWSER_EVICT_GRACE_MS` | `60000` | Grace period before evicting an over-cap account to avoid repeated cold starts |
| `AISTUDIO_BROWSER_TIMEOUT_MS` | `120000` | Browser upstream timeout in milliseconds |
| `AISTUDIO_API_BODY_LIMIT_BYTES` | `33554432` | Maximum API request body size in bytes (32 MiB by default) |
| `AISTUDIO_LOGIN_TIMEOUT_MS` | `600000` | Google login flow timeout in milliseconds |
| `AISTUDIO_LOGIN_SESSION_RETENTION_MS` | `600000` | Retention period for completed login session status in milliseconds |
| `AISTUDIO_PROXY_URL` | system proxy | Browser proxy URL |
| `AISTUDIO_RUNTIME_ROOT` | project root | Runtime directory containing accounts, keys, and stats |
| `AISTUDIO_AUTH_FILE` | active account | Playwright storage state used by CloakBrowser |
| `AISTUDIO_PRIVATE_CONTINUATION` | `true` | Function-result turns reuse the first-turn `responseId` and pin the original account; disabling it usually makes the web upstream reject `functionResponse` |
| `AISTUDIO_RESPONSE_CACHE_ENABLED` | `true` | Enable SQLite generation-response caching |
| `AISTUDIO_RESPONSE_CACHE_MODE` | `deterministic` | `deterministic` requires `temperature=0`, a fixed `seed`, and no tools/functions/external files; `exact` restores legacy behavior; `off` disables caching |
| `AISTUDIO_RESPONSE_CACHE_TTL_SECONDS` | `3600` | Response-cache lifetime in seconds; `0` disables it |
| `AISTUDIO_RESPONSE_CACHE_MAX_BYTES` | `33554432` | Total response-cache limit in bytes |
| `AISTUDIO_RESPONSE_CACHE_MAX_ENTRY_BYTES` | `1048576` | Maximum cached request or response size |
| `AISTUDIO_ACCOUNT_ROTATION_MODE` | `round_robin` | Account rotation mode: `round_robin` / `lru` / `least_rl` |
| `AISTUDIO_ACCOUNT_COOLDOWN_SECONDS` | `60` | Cooldown after a 429/quota-limit response, in seconds |
| `AISTUDIO_ACCOUNT_MAX_RETRIES` | `3` | Maximum accounts attempted for one request |
| `AISTUDIO_ACCOUNT_PROFILE_REFRESH_MS` | `21600000` | Suggested account-profile refresh interval in milliseconds |

> [!NOTE]
> Per-model defaults (thinking, safety, default tools, ...) live in `config.yaml`.
> `cachedContent` is rejected with HTTP 400 because this browser-session gateway does not provide the official Gemini Context Cache service; use the official Gemini API when server-side context caching is required.

> The WebUI service settings page reads and writes the runtime settings through `GET/PUT /config/runtime`. Values are persisted to the runtime `.env`; an already running Fastify process keeps the values loaded at startup, so settings marked for restart must be followed by a service restart.

## 🧱 Architecture

```text
Client (Gemini SDK / WebUI / curl)
    │
    ▼
┌──────────────────────────┐
│   Fastify server          │  Gemini-native routes
│   /v1/ and /v1beta/      │  rotation / live catalog
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
> **Live model catalog** — the logged-in AI Studio browser session supplies the credentials for model discovery and generation. The server refreshes the catalog every 15 minutes and stores only model metadata in `data/model-catalog.json`; no login credentials are written there.

---

## 🐳 Docker Deployment

A multi-stage `Dockerfile` and `docker-compose.yml` are included: the image builds the frontend, compiles the backend, and pre-downloads the CloakBrowser stealth Chromium, so the container needs no extra downloads on first start.

```bash
# Build and start (data persisted to ./data)
docker compose up -d --build

# Follow logs
docker compose logs -f
```

> [!IMPORTANT]
> The in-container browser needs a proxy to reach Google. Note that `127.0.0.1` inside the container is not the host: point `AISTUDIO_PROXY_URL` in `.env` to the **host's LAN IP** (with the proxy allowing LAN connections), or switch the service to `network_mode: host` and keep using `127.0.0.1`.

First-time login works exactly like a local run: open `http://<host>:3006`, go to the Accounts page, and complete local login, remote assisted login, or cookie import. Account data persists via the `./data` volume.

## ❓ FAQ

**Requests fail with `AI Studio streaming request failed: TypeError: Failed to fetch`?**

This means the in-browser `fetch()` failed before a response arrived. Common causes: an unstable proxy for long-lived connections, expired cookies, account risk-control, or a stale captured request template. Troubleshoot in order:

1. Open AI Studio manually with the service's browser profile and confirm you are logged in and can generate content.
2. Re-login or import cookies, then restart the service so it re-captures the request template.
3. Make sure the proxy applies to the backend-launched browser process, not only the system browser.
4. If failures cluster on long requests, increase `AISTUDIO_BROWSER_TIMEOUT_MS`.

**Model catalog returns `snapshot` or `fallback`?**

`snapshot` means the live catalog request failed and the service is using the last successful catalog saved in `data/model-catalog.json`. `fallback` means no usable snapshot exists; the browser session is logged out, cookies expired, the page protocol changed, or the network failed. Generation still requires an active AI Studio session — activate an account before requesting.

**Hitting 429 / quota limits?**

Account rotation automatically cools down the current account and fails over to other available accounts. With a single account, wait for the cooldown or lower the request rate.

---

## 🙏 Acknowledgements

- [chrysoljq/aistudio-api](https://github.com/chrysoljq/aistudio-api) — upstream project
- [LuanRT/BgUtils](https://github.com/LuanRT/BgUtils)
- [iBUHub/AIStudioToAPI](https://github.com/iBUHub/AIStudioToAPI)
- [linux.do](https://linux.do)

## 📄 License

MIT

---

<p align="center">
  <sub>Built with ❤️ & TypeScript · Ciallo～(∠・ω< )⌒☆ · If this project helps you, give it a ⭐</sub>
</p>
