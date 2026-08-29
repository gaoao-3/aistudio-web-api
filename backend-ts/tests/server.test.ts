import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ApiKeyStore } from "../src/auth/api-key-store.js";
import { buildApp } from "../src/app.js";
import type { BackendBridge } from "../src/bridge/backend-bridge.js";
import { settings } from "../src/config.js";

class MockBridge implements BackendBridge {
  readonly calls: Array<{ method: string; params: Readonly<Record<string, unknown>> }> = [];

  constructor(private readonly modelCatalog: readonly Record<string, unknown>[] = []) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  status(): Readonly<{ running: boolean; pid?: number }> { return { running: true, pid: 1234 }; }

  async request<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    onChunk?: (chunk: string) => void,
    _signal?: AbortSignal,
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "health") return { status: "ok", busy: false } as T;
    if (method === "stats") return { models: {}, totals: { requests: 0 } } as T;
    if (method === "models") return this.modelCatalog as T;
    if (method === "generate") return { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] } }] } as T;
    return { ok: true } as T;
  }
}

class AbortBridge extends MockBridge {
  aborted = false;

  override async request<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    if (method !== "generate" || !onChunk || !signal) {
      return super.request(method, params, onChunk, signal);
    }
    onChunk("data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"partial\"}]}}]}\n\n");
    return new Promise<T>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        this.aborted = true;
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  }
}

async function fixture(bridge = new MockBridge()) {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-fastify-"));
  const apiKeys = new ApiKeyStore(join(directory, "apikeys.json"));
  const app = await buildApp({
    services: { bridge, apiKeys },
    logger: false,
    serveStatic: false,
    runtimeConfigFile: join(directory, ".env"),
  });
  return { app, bridge, apiKeys, directory };
}

test("health is public and served by the bridge", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", busy: false });
  assert.equal(state.bridge.calls[0]?.method, "health");
});

test("auth check advertises native runtime capabilities", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({ method: "GET", url: "/auth/check" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().capabilities.gateway, "native");
  assert.equal(response.json().capabilities.automatic_login, process.platform === "win32" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));
  assert.equal(response.json().capabilities.remote_login, true);
  assert.equal(response.json().capabilities.streaming, "incremental");
});

test("account login routes dispatch start, input, status, and cancellation", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  assert.equal((await state.app.inject({ method: "POST", url: "/accounts/login/start", payload: { remote: true, name: "test" } })).statusCode, 403);
  const key = (await state.apiKeys.create("login-test")).key;
  const headers = { authorization: `Bearer ${key}` };
  assert.equal((await state.app.inject({ method: "POST", url: "/accounts/login/start", headers, payload: { remote: true, name: "test" } })).statusCode, 200);
  assert.equal((await state.app.inject({ method: "GET", url: "/accounts/login/status/login_1", headers })).statusCode, 200);
  assert.equal((await state.app.inject({ method: "POST", url: "/accounts/login/input", headers, payload: { session_id: "login_1", value: "123456" } })).statusCode, 200);
  assert.equal((await state.app.inject({ method: "DELETE", url: "/accounts/login/login_1", headers })).statusCode, 200);
  assert.deepEqual(state.bridge.calls.slice(-4).map(call => call.method), ["login_start", "login_status", "login_input", "login_cancel"]);
});

test("system status identifies Fastify and the native backend", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({ method: "GET", url: "/system/status" });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().server, "fastify");
  assert.deepEqual(response.json().bridge, { running: true, pid: 1234 });
});

test("model catalog reports whether it came from AI Studio or the fallback", async (t) => {
  const liveBridge = new MockBridge([{ name: "models/gemini-3.6-flash", displayName: "Gemini 3.6 Flash" }]);
  const live = await fixture(liveBridge);
  t.after(async () => { await live.app.close(); await rm(live.directory, { recursive: true, force: true }); });
  const liveResponse = await live.app.inject({ method: "GET", url: "/v1beta/models" });
  assert.equal(liveResponse.statusCode, 200);
  assert.equal(liveResponse.json().source, "live");
  assert.equal(liveResponse.json().models[0].name, "models/gemini-3.6-flash");

  const fallback = await fixture();
  t.after(async () => { await fallback.app.close(); await rm(fallback.directory, { recursive: true, force: true }); });
  const fallbackResponse = await fallback.app.inject({ method: "GET", url: "/v1beta/models" });
  assert.equal(fallbackResponse.statusCode, 200);
  assert.equal(fallbackResponse.json().source, "fallback");
  assert.ok(fallbackResponse.json().models.length > 0);
  assert.equal(fallbackResponse.json().models.some((model: { name?: string }) => model.name?.endsWith("-web")), false);
  assert.equal(fallback.bridge.calls.some((call) => call.method === "models"), true);
});

test("runtime config exposes settings and can be configured from the API", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const initial = await state.app.inject({ method: "GET", url: "/config/runtime" });
  assert.equal(initial.statusCode, 200);
  const initialPayload = initial.json();
  assert.ok(Array.isArray(initialPayload.settings));
  const body = initialPayload.settings.find((s: { key: string }) => s.key === "body_limit_bytes");
  assert.ok(body);
  assert.equal(body.restart_required, false);
  assert.equal(body.configured, null);
  assert.equal(initialPayload.effective_body_limit_bytes, initialPayload.configured_body_limit_bytes);
  assert.equal(initialPayload.restart_required, false);

  const saved = await state.app.inject({
    method: "PUT",
    url: "/config/runtime",
    payload: { body_limit_bytes: 64 * 1024 * 1024 },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().configured_body_limit_bytes, 64 * 1024 * 1024);
  assert.equal(saved.json().effective_body_limit_bytes, initialPayload.effective_body_limit_bytes);
  assert.equal(saved.json().restart_required, true);

  const reread = await state.app.inject({ method: "GET", url: "/config/runtime" });
  const rereadBody = reread.json().settings.find((s: { key: string }) => s.key === "body_limit_bytes");
  assert.equal(rereadBody.configured, 64);
  assert.equal(rereadBody.restart_required, true);

  // 布尔配置项
  const savedHeadless = await state.app.inject({
    method: "PUT",
    url: "/config/runtime",
    payload: { browser_headless: false },
  });
  assert.equal(savedHeadless.statusCode, 200);
  const headless = (await state.app.inject({ method: "GET", url: "/config/runtime" }))
    .json().settings.find((s: { key: string }) => s.key === "browser_headless");
  assert.equal(headless.configured, false);
  assert.equal(headless.effective, true);
  assert.equal(headless.restart_required, true);

  // 并发保存必须合并到同一个 .env，不能互相覆盖或产生半截文件。
  const [savedTimeout, savedRetries] = await Promise.all([
    state.app.inject({ method: "PUT", url: "/config/runtime", payload: { browser_timeout_ms: 123456 } }),
    state.app.inject({ method: "PUT", url: "/config/runtime", payload: { account_max_retries: 7 } }),
  ]);
  assert.equal(savedTimeout.statusCode, 200);
  assert.equal(savedRetries.statusCode, 200);
  const source = await readFile(join(state.directory, ".env"), "utf8");
  assert.match(source, /^AISTUDIO_BROWSER_TIMEOUT_MS=123456$/mu);
  assert.match(source, /^AISTUDIO_ACCOUNT_MAX_RETRIES=7$/mu);
  const concurrent = (await state.app.inject({ method: "GET", url: "/config/runtime" })).json().settings as Array<{ key: string; configured: unknown }>;
  assert.equal(concurrent.find((s) => s.key === "browser_timeout_ms")?.configured, 123456);
  assert.equal(concurrent.find((s) => s.key === "account_max_retries")?.configured, 7);

  const savedProxy = await state.app.inject({
    method: "PUT",
    url: "/config/runtime",
    payload: { proxy_url: "http://alice:super-secret@example.test:8080" },
  });
  assert.equal(savedProxy.statusCode, 200);
  const proxy = (await state.app.inject({ method: "GET", url: "/config/runtime" }))
    .json().settings.find((s: { key: string }) => s.key === "proxy_url");
  assert.equal(proxy.sensitive, true);
  assert.match(proxy.configured, /^http:\/\/\*\*\*:\*\*\*@example\.test:8080$/u);
  assert.doesNotMatch(proxy.configured, /super-secret/u);
  assert.doesNotMatch(proxy.configured, /alice/u);

  const clearedProxy = await state.app.inject({
    method: "PUT",
    url: "/config/runtime",
    payload: { proxy_url: "" },
  });
  assert.equal(clearedProxy.statusCode, 200);
  const clearedProxyView = (await state.app.inject({ method: "GET", url: "/config/runtime" }))
    .json().settings.find((s: { key: string }) => s.key === "proxy_url");
  assert.equal(clearedProxyView.configured, null);
  assert.equal(clearedProxyView.restart_required, false);

  // 非法值
  assert.equal((await state.app.inject({ method: "PUT", url: "/config/runtime", payload: { body_limit_bytes: 512 } })).statusCode, 422);
  assert.equal((await state.app.inject({ method: "PUT", url: "/config/runtime", payload: { body_limit_bytes: "64MiB" } })).statusCode, 422);
  assert.equal((await state.app.inject({ method: "PUT", url: "/config/runtime", payload: { browser_timeout_ms: -1 } })).statusCode, 422);
  assert.equal((await state.app.inject({ method: "PUT", url: "/config/runtime", payload: { browser_timeout_ms: 1000.5 } })).statusCode, 422);
  assert.equal((await state.app.inject({ method: "PUT", url: "/config/runtime", payload: { body_limit_bytes: 1024.5 } })).statusCode, 422);
  assert.equal((await state.app.inject({ method: "PUT", url: "/config/runtime", payload: { unknown_setting: 1 } })).statusCode, 422);
  assert.equal((await state.app.inject({ method: "PUT", url: "/config/runtime", payload: {} })).statusCode, 422);
});

test("creating the first API key enables authentication immediately", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const created = await state.app.inject({ method: "POST", url: "/api-keys", payload: { name: "test" } });
  assert.equal(created.statusCode, 201);
  const key = created.json().key as string;
  assert.match(key, /^ask_[a-f0-9]{32}$/u);

  const rejected = await state.app.inject({ method: "GET", url: "/stats" });
  assert.equal(rejected.statusCode, 401);
  const invalidVerify = await state.app.inject({ method: "GET", url: "/auth/verify", headers: { authorization: "Bearer wrong" } });
  assert.equal(invalidVerify.statusCode, 401);
  const validVerify = await state.app.inject({ method: "GET", url: "/auth/verify", headers: { authorization: `Bearer ${key}` } });
  assert.equal(validVerify.statusCode, 200);
  assert.deepEqual(validVerify.json(), { ok: true });
  const accepted = await state.app.inject({ method: "GET", url: "/stats", headers: { authorization: `Bearer ${key}` } });
  assert.equal(accepted.statusCode, 200);
});

test("API keys do not configure built-in tools; native tools are WebUI-only", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const legacyCreate = await state.app.inject({
    method: "POST",
    url: "/api-keys",
    payload: { name: "legacy", permissions: { builtin_tools: false } },
  });
  assert.equal(legacyCreate.statusCode, 422);

  const created = await state.app.inject({
    method: "POST",
    url: "/api-keys",
    payload: { name: "mobile" },
  });
  assert.equal(created.statusCode, 201);
  const createdBody = created.json() as { id: string; key: string; permissions?: unknown };
  assert.equal("permissions" in createdBody, false);
  const headers = { authorization: `Bearer ${createdBody.key}` };

  const deniedNative = await state.app.inject({
    method: "POST",
    url: "/v1beta/models/gemini-3-flash-preview:generateContent",
    headers,
    payload: { contents: [{ role: "user", parts: [{ text: "search" }] }], tools: [{ googleSearch: {} }] },
  });
  assert.equal(deniedNative.statusCode, 200);
  const nativeCall = [...state.bridge.calls].reverse().find((call) => call.method === "generate");
  assert.deepEqual((nativeCall?.params.body as { tools?: unknown[] } | undefined)?.tools, []);

  const allowedLocalFunction = await state.app.inject({
    method: "POST",
    url: "/v1beta/models/gemini-3-flash-preview:generateContent",
    headers,
    payload: {
      contents: [{ role: "user", parts: [{ text: "call my function" }] }],
      tools: [{ functionDeclarations: [{ name: "local_function", description: "local" }] }],
    },
  });
  assert.equal(allowedLocalFunction.statusCode, 200);
  const localFunctionCall = [...state.bridge.calls].reverse().find((call) => call.method === "generate");
  assert.equal(((localFunctionCall?.params.body as { tools?: unknown[] } | undefined)?.tools || []).length, 1);

  const deniedPermissionUpdate = await state.app.inject({
    method: "PUT",
    url: `/api-keys/${createdBody.id}`,
    headers,
    payload: { permissions: { builtin_tools: true } },
  });
  assert.equal(deniedPermissionUpdate.statusCode, 422);

  const allowedWebUiNative = await state.app.inject({
    method: "POST",
    url: "/v1beta/models/gemini-3-flash-preview:generateContent",
    headers: { ...headers, "x-aistudio-webui": "1" },
    payload: { contents: [{ role: "user", parts: [{ text: "search" }] }], tools: [{ googleSearch: {} }] },
  });
  assert.equal(allowedWebUiNative.statusCode, 200);
});

test("Gemini generateContent is dispatched without FastAPI", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({
    method: "POST",
    url: "/v1beta/models/gemini-3-flash-preview:generateContent",
    payload: { contents: [{ role: "user", parts: [{ text: "hello" }] }] },
  });
  assert.equal(response.statusCode, 200);
  const call = state.bridge.calls.find((item) => item.method === "generate");
  assert.equal(call?.params.model, "models/gemini-3-flash-preview");
  assert.equal(call?.params.stream, false);
});

test("independent Embedding endpoints are not exposed", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const native = await state.app.inject({
    method: "POST",
    url: "/v1beta/models/gemini-embedding-001:embedContent",
    payload: { content: { parts: [{ text: "hello" }] } },
  });
  const openai = await state.app.inject({
    method: "POST",
    url: "/v1/embeddings",
    payload: { model: "gemini-embedding-001", input: "hello" },
  });
  assert.equal(native.statusCode, 404);
  assert.equal(openai.statusCode, 404);
  assert.equal(state.bridge.calls.length, 0);
});
test("Interactions endpoints are not exposed", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  for (const version of ["v1", "v1beta", "v1beta2"] as const) {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const response = await state.app.inject({ method, url: `/${version}/interactions` });
      assert.equal(response.statusCode, 404);
    }
  }
  assert.equal(state.bridge.calls.length, 0);
});

test("disconnecting an SSE client aborts the bridge request", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-fastify-abort-"));
  const bridge = new AbortBridge();
  const app = await buildApp({
    services: {
      bridge,
      apiKeys: new ApiKeyStore(join(directory, "apikeys.json")),
    },
    logger: false,
    serveStatic: false,
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as AddressInfo;

  await new Promise<void>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path: "/v1beta/models/gemini-3-flash-preview:streamGenerateContent",
      headers: { "content-type": "application/json" },
    }, (response) => {
      response.once("data", () => {
        response.destroy();
        resolve();
      });
    });
    request.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve();
      else reject(error);
    });
    request.end(JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }));
  });

  await delay(50);
  assert.equal(bridge.aborted, true);
});
