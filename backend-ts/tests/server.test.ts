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
    modelCatalogFile: join(directory, "model-catalog.json"),
    interactionTasksFile: join(directory, "interaction-tasks.sqlite"),
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
  const fallbackNames = fallbackResponse.json().models.map((model: { name?: string }) => model.name);
  assert.ok(fallbackNames.includes("models/gemini-3.8-flash"));
  assert.ok(fallbackNames.includes("models/gemini-3.7-flash"));
  assert.ok(fallbackNames.includes("models/gemini-3.5-flash-lite"));
  assert.equal(fallbackNames.includes("models/gemini-3.5-live-translate-preview"), false);
  assert.equal(fallback.bridge.calls.some((call) => call.method === "models"), true);
});

test("model catalog persists live results and reuses them when AI Studio is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-fastify-models-"));
  const modelCatalogFile = join(directory, "model-catalog.json");
  const liveApp = await buildApp({
    services: {
      bridge: new MockBridge([{ name: "models/gemini-auto-refresh", displayName: "Auto Refresh" }]),
      apiKeys: new ApiKeyStore(join(directory, "apikeys.json")),
    },
    logger: false,
    serveStatic: false,
    modelCatalogFile,
  });
  t.after(async () => { await liveApp.close(); });

  const liveResponse = await liveApp.inject({ method: "GET", url: "/v1beta/models" });
  assert.equal(liveResponse.json().source, "live");
  const saved = JSON.parse(await readFile(modelCatalogFile, "utf8")) as {
    updated_at?: string;
    models?: Array<{ name?: string }>;
  };
  assert.match(saved.updated_at ?? "", /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(saved.models?.[0]?.name, "models/gemini-auto-refresh");

  const offlineApp = await buildApp({
    services: {
      bridge: new MockBridge(),
      apiKeys: new ApiKeyStore(join(directory, "apikeys.json")),
    },
    logger: false,
    serveStatic: false,
    modelCatalogFile,
  });
  t.after(async () => { await offlineApp.close(); await rm(directory, { recursive: true, force: true }); });
  const offlineResponse = await offlineApp.inject({ method: "GET", url: "/v1beta/models" });
  assert.equal(offlineResponse.statusCode, 200);
  assert.equal(offlineResponse.json().source, "snapshot");
  assert.equal(offlineResponse.json().models[0].name, "models/gemini-auto-refresh");
});

test("fresh model catalog snapshot is served directly while a background refresh runs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-fastify-fresh-"));
  const modelCatalogFile = join(directory, "model-catalog.json");
  const bridge = new MockBridge([{ name: "models/gemini-fresh", displayName: "Fresh" }]);
  const app = await buildApp({
    services: {
      bridge,
      apiKeys: new ApiKeyStore(join(directory, "apikeys.json")),
    },
    logger: false,
    serveStatic: false,
    modelCatalogFile,
  });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });

  // 首次请求：无快照，现场拉取并落盘
  const first = await app.inject({ method: "GET", url: "/v1beta/models" });
  assert.equal(first.json().source, "live");

  // 第二次请求：快照 5 分钟内视为新鲜，直读返回；后台刷新会额外调用一次 bridge
  const second = await app.inject({ method: "GET", url: "/v1beta/models" });
  assert.equal(second.json().source, "snapshot");
  assert.equal(second.json().models[0].name, "models/gemini-fresh");
  const modelCalls = () => bridge.calls.filter((call) => call.method === "models").length;
  assert.equal(modelCalls(), 2); // 首次 live + 后台刷新
  assert.equal(bridge.calls.filter((call) => call.method === "models").length, modelCalls()); // 响应不等待后台任务

  // 第三个并发请求也不会重复触发后台刷新（进行中只触发一次）
  await delay(10);
  const third = await app.inject({ method: "GET", url: "/v1beta/models" });
  assert.equal(third.json().source, "snapshot");
  await delay(20);
  assert.equal(modelCalls(), 3); // 第二次请求的后台刷新已完成，第三次再触发一次
});

test("responses endpoint converts gemini output into typed items", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({
    method: "POST",
    url: "/v1/responses",
    payload: { model: "gemini-3.8-flash", input: "hi" },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.object, "response");
  assert.equal(payload.status, "completed");
  assert.equal(payload.model, "gemini-3.8-flash");
  const output = payload.output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  assert.equal(output[0]?.type, "message");
  assert.equal(output[0]?.content?.[0]?.type, "output_text");
  assert.equal(output[0]?.content?.[0]?.text, "ok");
  assert.equal(typeof payload.id, "string");
  assert.ok(String(payload.id).startsWith("resp_"));
});

test("responses endpoint streams responses events and completes", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({
    method: "POST",
    url: "/v1/responses",
    payload: { model: "gemini-3.8-flash", input: "hi", stream: true },
  });
  assert.equal(response.statusCode, 200);
  const events = response.body
    .split(/\r?\n\r?\n/u)
    .filter((line) => line.startsWith("data: ") && !line.startsWith("data: [DONE]"))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string });
  const types = events.map((event) => event.type);
  assert.ok(types.includes("response.created"));
  assert.ok(types.includes("response.in_progress"));
  assert.ok(types.includes("response.completed"));
  assert.ok(response.body.includes("data: [DONE]"));
});

test("interactions endpoint converts gemini output into steps", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({
    method: "POST",
    url: "/v1beta/interactions",
    payload: { model: "gemini-3.6-flash", input: "hi" },
  });
  assert.equal(response.statusCode, 200);
  const payload = response.json();
  assert.equal(payload.object, "interaction");
  assert.equal(payload.status, "completed");
  assert.ok(String(payload.id).startsWith("int_"));
  const steps = payload.steps as Array<{ type?: string; content?: Array<{ text?: string }> }>;
  assert.equal(steps[0]?.type, "model_output");
  assert.equal(steps[0]?.content?.[0]?.text, "ok");
});

class BackgroundBridge extends MockBridge {
  signal: AbortSignal | undefined;
  resolve?: (value: unknown) => void;
  reject?: (error: Error) => void;
  override async request<T>(method: string, params: Readonly<Record<string, unknown>> = {}, onChunk?: (chunk: string) => void, signal?: AbortSignal): Promise<T> {
    if (method !== "generate") return super.request(method, params, onChunk, signal);
    this.signal = signal;
    return new Promise<T>((resolve, reject) => { this.resolve = value => resolve(value as T); this.reject = reject; });
  }
}

test("background interactions return promptly and poll completed results", { timeout: 5000 }, async (t) => {
  const bridge = new BackgroundBridge();
  const state = await fixture(bridge);
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const created = await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: { model: "gemini-3.6-flash", input: "hi", background: true } });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().status, "in_progress");
  const url = `/v1beta/interactions/${created.json().id}`;
  assert.equal((await state.app.inject({ method: "GET", url })).json().status, "in_progress");
  assert.equal(bridge.signal?.aborted, false);
  bridge.resolve?.({ candidates: [{ content: { parts: [{ text: "finished" }] } }] });
  await delay(10);
  const completed = (await state.app.inject({ method: "GET", url })).json();
  assert.equal(completed.status, "completed");
  assert.equal(completed.id, created.json().id);
  assert.equal(completed.steps[0].content[0].text, "finished");
});

test("foreground interactions are persisted and retrievable via GET", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const created = await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: { model: "gemini-3.6-flash", input: "hi" } });
  assert.equal(created.statusCode, 200);
  const fetched = await state.app.inject({ method: "GET", url: `/v1beta/interactions/${created.json().id}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().status, "completed");
  assert.equal(fetched.json().steps[0].content[0].text, "ok");
  // store:false 不持久化
  const ephemeral = await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: { model: "gemini-3.6-flash", input: "hi", store: false } });
  assert.equal(ephemeral.statusCode, 200);
  assert.equal((await state.app.inject({ method: "GET", url: `/v1beta/interactions/${ephemeral.json().id}` })).statusCode, 404);
});

test("DELETE cancels an active background interaction", { timeout: 5000 }, async (t) => {
  const bridge = new BackgroundBridge();
  const state = await fixture(bridge);
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const created = await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: { model: "gemini-3.6-flash", input: "hi", background: true } });
  assert.equal(created.statusCode, 200);
  const url = `/v1beta/interactions/${created.json().id}`;
  const cancelled = await state.app.inject({ method: "DELETE", url });
  assert.equal(cancelled.statusCode, 200);
  assert.equal(cancelled.json().status, "failed");
  assert.equal(cancelled.json().error.code, "cancelled");
  assert.equal(bridge.signal?.aborted, true);
  // 取消后仍可查询结果，但不可重复取消
  assert.equal((await state.app.inject({ method: "GET", url })).json().error.code, "cancelled");
  assert.equal((await state.app.inject({ method: "DELETE", url })).statusCode, 404);
  // 迟到的上游完成不能覆盖取消状态
  bridge.resolve?.({ candidates: [{ content: { parts: [{ text: "late" }] } }] });
  await delay(10);
  assert.equal((await state.app.inject({ method: "GET", url })).json().status, "failed");
});

test("DELETE on unknown interaction returns 404", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  assert.equal((await state.app.inject({ method: "DELETE", url: "/v1beta/interactions/int_missing" })).statusCode, 404);
});

test("background interactions persist failure and enforce task ownership across restart", async (t) => {
  const bridge = new BackgroundBridge();
  const state = await fixture(bridge);
  const a = (await state.apiKeys.create("a")).key;
  const b = (await state.apiKeys.create("b")).key;
  const headers = { "x-api-key": a };
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const created = await state.app.inject({ method: "POST", url: "/v1beta/interactions", headers, payload: { model: "gemini-3.6-flash", input: "hi", background: true } });
  assert.equal(created.statusCode, 200);
  const url = `/v1beta/interactions/${created.json().id}`;
  assert.equal((await state.app.inject({ method: "GET", url, headers: { "x-api-key": b } })).statusCode, 404);
  bridge.reject?.(new Error("upstream failed"));
  await delay(10);
  assert.equal((await state.app.inject({ method: "GET", url, headers })).json().status, "failed");
  await state.app.close();
  const restarted = await buildApp({ services: { bridge: new MockBridge(), apiKeys: state.apiKeys }, logger: false, serveStatic: false, interactionTasksFile: join(state.directory, "interaction-tasks.sqlite") });
  try {
    const result = await restarted.inject({ method: "GET", url, headers });
    assert.equal(result.json().status, "failed");
    assert.match(result.json().error.message, /upstream failed/u);
  } finally { await restarted.close(); }
});

test("background interactions shutdown aborts without waiting for uncooperative upstream", { timeout: 5000 }, async (t) => {
  const bridge = new BackgroundBridge();
  const state = await fixture(bridge);
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: { model: "gemini-3.6-flash", input: "hi", background: true } });
  assert.equal(response.statusCode, 200);
  await state.app.close();
  assert.equal(bridge.signal?.aborted, true);
  bridge.resolve?.({ candidates: [] });
  await delay(10);
  const restarted = await buildApp({ services: { bridge: new MockBridge(), apiKeys: state.apiKeys }, logger: false, serveStatic: false, interactionTasksFile: join(state.directory, "interaction-tasks.sqlite") });
  try { assert.equal((await restarted.inject({ method: "GET", url: `/v1beta/interactions/${response.json().id}` })).json().status, "failed"); }
  finally { await restarted.close(); }
});

test("background interactions reject invalid flags and bound active work", async (t) => {
  const state = await fixture(new BackgroundBridge());
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const payload = { model: "gemini-3.6-flash", input: "hi", background: true };
  for (const flags of [{ store: false }, { stream: true }]) {
    assert.equal((await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: { ...payload, ...flags } })).statusCode, 400);
  }
  for (let i = 0; i < 4; i++) assert.equal((await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload })).statusCode, 200);
  assert.equal((await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload })).statusCode, 429);
});

test("interactions require authentication for builtin tools even with webui marker", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const payload = { model: "gemini-3.6-flash", input: "hi", tools: [{ type: "google_search" }] };
  assert.equal((await state.app.inject({ method: "POST", url: "/v1beta/interactions", headers: { "x-aistudio-webui": "1" }, payload })).statusCode, 403);
  const key = (await state.apiKeys.create("tools")).key;
  assert.equal((await state.app.inject({ method: "POST", url: "/v1beta/interactions", headers: { "x-api-key": key }, payload })).statusCode, 200);
});

test("protocol routes return error envelopes for missing bodies and interaction stream failures", async (t) => {
  class FailingBridge extends MockBridge {
    override async request<T>(method: string): Promise<T> { if (method === "generate") throw new Error("stream broke"); return super.request(method); }
  }
  const state = await fixture(new FailingBridge());
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  for (const url of ["/v1beta/interactions", "/v1/responses"]) {
    const result = await state.app.inject({ method: "POST", url });
    assert.equal(result.statusCode, 422);
    assert.equal(typeof result.json().error.message, "string");
  }
  const result = await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: { model: "gemini-3.6-flash", input: "hi", stream: true } });
  assert.match(result.body, /event: error\ndata: /u);
  const errorFrame = result.body.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6))).find(frame => frame.event_type === "error");
  assert.match(errorFrame.error.message, /stream broke/u);
});

test("interaction and response continuation IDs are isolated by key and app", async (t) => {
  const state = await fixture();
  const other = await fixture();
  t.after(async () => { await state.app.close(); await other.app.close(); await rm(state.directory, { recursive: true, force: true }); await rm(other.directory, { recursive: true, force: true }); });
  const a = (await state.apiKeys.create("a")).key;
  const b = (await state.apiKeys.create("b")).key;
  for (const [url, previous] of [["/v1beta/interactions", "previous_interaction_id"], ["/v1/responses", "previous_response_id"]]) {
    const first = await state.app.inject({ method: "POST", url: url!, headers: { "x-api-key": a }, payload: { model: "gemini-3.6-flash", input: "secret" } });
    assert.equal(first.statusCode, 200);
    const payload = { model: "gemini-3.6-flash", input: "continue", [previous!]: first.json().id };
    assert.equal((await state.app.inject({ method: "POST", url: url!, headers: { "x-api-key": b }, payload })).statusCode, 404);
    assert.equal((await other.app.inject({ method: "POST", url: url!, payload })).statusCode, 404);
    assert.equal((await state.app.inject({ method: "POST", url: url!, headers: { "x-api-key": a }, payload })).statusCode, 200);
    if (previous === "previous_interaction_id") {
      // 前台结果现也持久化：本人可查，其他 API Key 不可查
      assert.equal((await state.app.inject({ method: "GET", url: `${url}/${first.json().id}`, headers: { "x-api-key": a } })).statusCode, 200);
      assert.equal((await state.app.inject({ method: "GET", url: `${url}/${first.json().id}`, headers: { "x-api-key": b } })).statusCode, 404);
    }
    const unstored = await state.app.inject({ method: "POST", url: url!, headers: { "x-api-key": a }, payload: { model: "gemini-3.6-flash", input: "private", store: false } });
    assert.equal(unstored.statusCode, 200);
    assert.equal((await state.app.inject({ method: "POST", url: url!, headers: { "x-api-key": a }, payload: { ...payload, [previous!]: unstored.json().id } })).statusCode, 404);
  }
});

test("background interaction survives closing its HTTP client connection", { timeout: 5000 }, async (t) => {
  const bridge = new BackgroundBridge();
  const state = await fixture(bridge);
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  await state.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = state.app.server.address() as AddressInfo;
  const id = await new Promise<string>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/v1beta/interactions", headers: { "content-type": "application/json", connection: "close" } }, res => {
      let body = "";
      res.on("data", chunk => { body += String(chunk); });
      res.on("end", () => { req.destroy(); resolve(JSON.parse(body).id); });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ model: "gemini-3.6-flash", input: "hi", background: true }));
  });
  await delay(10);
  assert.equal(bridge.signal?.aborted, false);
  bridge.resolve?.({ candidates: [{ content: { parts: [{ text: "done" }] } }] });
  await delay(10);
  assert.equal((await state.app.inject({ method: "GET", url: `/v1beta/interactions/${id}` })).json().status, "completed");
});

test("interactions endpoint streams interaction events", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  const response = await state.app.inject({
    method: "POST",
    url: "/v1beta/interactions",
    payload: { model: "gemini-3.6-flash", input: "hi", stream: true },
  });
  assert.equal(response.statusCode, 200);
  const events = response.body
    .split(/\r?\n\r?\n/u)
    .filter((block) => block.startsWith("event: "))
    .map((block) => /^event: (\S+)$/mu.exec(block)?.[1] ?? "");
  assert.ok(events.includes("interaction.created"));
  assert.ok(events.includes("interaction.status_update"));
  assert.ok(events.includes("interaction.completed"));
  assert.ok(response.body.includes("data: [DONE]"));
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
test("interactions endpoint is only exposed on v1beta", async (t) => {
  const state = await fixture();
  t.after(async () => { await state.app.close(); await rm(state.directory, { recursive: true, force: true }); });
  // interactions 端点只存在于 v1beta（本地实现）；其他版本仍应 404
  for (const version of ["v1", "v1beta2"] as const) {
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const response = await state.app.inject({ method, url: `/${version}/interactions` });
      assert.equal(response.statusCode, 404);
    }
  }
  const missingParams = await state.app.inject({ method: "POST", url: "/v1beta/interactions", payload: {} });
  assert.equal(missingParams.statusCode, 400);
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
