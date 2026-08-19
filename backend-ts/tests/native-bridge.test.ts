import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { AccountStore } from "../src/accounts/account-store.js";
import { NativeBackendBridge, type NativeGatewayBackend } from "../src/bridge/native-bridge.js";
import { InteractionStore } from "../src/interactions/store.js";
import { StatsStore } from "../src/stats/stats-store.js";
import type { LoginSessionBackend, LoginSessionView } from "../src/accounts/login-session-manager.js";

class FakeGateway implements NativeGatewayBackend {
  calls: { model: string; body: unknown }[] = [];
  responses: Record<string, unknown>[] = [];
  errors: Error[] = [];
  async warmup(): Promise<void> {}
  async close(): Promise<void> {}
  async switchAuth(): Promise<void> {}
  async models(): Promise<Record<string, unknown>[]> { return []; }
  async generate(model: string, body: unknown): Promise<Record<string, unknown>> {
    this.calls.push({ model, body });
    const error = this.errors.shift();
    if (error) throw error;
    return this.responses.shift() ?? {};
  }
  async generateStream(model: string, body: unknown, onResponse: (response: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const response = await this.generate(model, body);
    onResponse(response);
    return response;
  }
}

class FakeLogin implements LoginSessionBackend {
  started: { name?: string; remote: boolean } | undefined;
  submitted: { id: string; value: string } | undefined;
  cancelled: string | undefined;
  async start(input: { readonly name?: string; readonly remote: boolean }): Promise<{ session_id: string }> {
    this.started = { ...input };
    return { session_id: "login_test" };
  }
  status(sessionId: string): LoginSessionView | undefined {
    return sessionId === "login_test" ? {
      session_id: sessionId,
      status: "pending",
      remote: true,
      created_at: "2026-08-09T00:00:00.000Z",
      step: { kind: "email", prompt: "请输入邮箱" },
    } : undefined;
  }
  submit(sessionId: string, value: string): "ok" | "missing" | "not_waiting" {
    this.submitted = { id: sessionId, value };
    return sessionId === "login_test" ? "ok" : "missing";
  }
  async cancel(sessionId: string): Promise<"ok" | "missing"> {
    this.cancelled = sessionId;
    return sessionId === "login_test" ? "ok" : "missing";
  }
  async stop(): Promise<void> {}
}

describe("native Interactions bridge", () => {
  it("uses only the AI Studio session for model discovery and generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-session-routing-"));
    try {
      const native = new FakeGateway();
      native.models = async () => [
        { name: "models/gemini-native", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-only", supportedGenerationMethods: ["embedContent"] },
      ];
      native.responses.push({ candidates: [{ content: { parts: [{ text: "native" }] } }] });
      const bridge = new NativeBackendBridge(
        native,
        new InteractionStore(directory, 0),
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
      );
      const catalog = await bridge.request<Record<string, unknown>[]>("models");
      assert.deepEqual(catalog.map(item => item.name), ["models/gemini-native"]);
      await bridge.request("generate", { model: "gemini-native", body: {} });
      assert.equal(native.calls.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not fall back to an official catalog when AI Studio discovery fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-catalog-failure-"));
    try {
      const native = new FakeGateway();
      native.models = async () => { throw new Error("ListModels returned HTTP 401"); };
      const bridge = new NativeBackendBridge(
        native,
        new InteractionStore(directory, 0),
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
      );
      await assert.rejects(bridge.request("models"), /ListModels returned HTTP 401/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses separate account gateways for request-level rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-rotation-"));
    try {
      const accountStore = new AccountStore(join(directory, "accounts"));
      await accountStore.saveStorageState({
        name: "A",
        email: "a@example.com",
        storageState: { cookies: [{ name: "SID", value: "a", domain: ".google.com", path: "/" }], origins: [] },
      });
      await accountStore.saveStorageState({
        name: "B",
        email: "b@example.com",
        storageState: { cookies: [{ name: "SID", value: "b", domain: ".google.com", path: "/" }], origins: [] },
      });
      const gateways = new Map<string, FakeGateway>();
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const gateway = gateways.get(accountId) ?? new FakeGateway();
        gateway.responses.push({ candidates: [{ content: { parts: [{ text: accountId }] } }] });
        gateways.set(accountId, gateway);
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        new InteractionStore(directory, 0),
        accountStore,
        new StatsStore(join(directory, "stats.json")),
        undefined,
        factory,
      );
      await bridge.request("generate", { model: "gemini-test", body: {} });
      await bridge.request("generate", { model: "gemini-test", body: {} });
      assert.equal(gateways.size, 2);
      assert.deepEqual([...gateways.values()].map(gateway => gateway.calls.length), [1, 1]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retries a rate-limited request on another account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-rate-limit-"));
    try {
      const accountStore = new AccountStore(join(directory, "accounts"));
      await accountStore.saveStorageState({
        name: "A",
        email: "a@example.com",
        storageState: { cookies: [{ name: "SID", value: "a", domain: ".google.com", path: "/" }], origins: [] },
      });
      await accountStore.saveStorageState({
        name: "B",
        email: "b@example.com",
        storageState: { cookies: [{ name: "SID", value: "b", domain: ".google.com", path: "/" }], origins: [] },
      });
      const accounts = await accountStore.list();
      const gateways = new Map<string, FakeGateway>();
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const gateway = gateways.get(accountId) ?? new FakeGateway();
        if (accountId === accounts[0]?.id) gateway.errors.push(new Error("AI Studio upstream returned HTTP 429"));
        else gateway.responses.push({ candidates: [{ content: { parts: [{ text: "from-b" }] } }] });
        gateways.set(accountId, gateway);
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        new InteractionStore(directory, 0),
        accountStore,
        new StatsStore(join(directory, "stats.json")),
        undefined,
        factory,
      );
      const result = await bridge.request<Record<string, unknown>>("generate", { model: "gemini-test", body: {} });
      assert.equal((result.candidates as Record<string, unknown>[])[0]?.content !== undefined, true);
      assert.equal(gateways.size, 2);
      assert.equal(gateways.get(accounts[0]!.id)?.calls.length, 1);
      assert.equal(gateways.get(accounts[1]!.id)?.calls.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores and rebuilds a signed two-round tool interaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-bridge-"));
    try {
      const gateway = new FakeGateway();
      gateway.responses.push({
        candidates: [{ content: { parts: [{ functionCall: { name: "weather", args: { city: "上海" }, id: "call_1" }, thoughtSignature: "sig" }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 6 },
      }, {
        candidates: [{ content: { parts: [{ text: "晴，28°C" }] } }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, thoughtsTokenCount: 0, totalTokenCount: 12 },
      });
      const bridge = new NativeBackendBridge(
        gateway,
        new InteractionStore(directory, 0),
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
      );
      const first = await bridge.request<Record<string, unknown>>("interaction_create", { body: {
        model: "gemma-4-31b-it",
        input: "上海天气",
        tools: [{ type: "function", name: "weather", parameters: { type: "object" } }],
      } });
      assert.equal(first.status, "requires_action");
      const firstSteps = first.steps as Record<string, unknown>[];
      assert.equal(firstSteps[0]?.id, "call_1");
      assert.equal(firstSteps[0]?.signature, "sig");

      const second = await bridge.request<Record<string, unknown>>("interaction_create", { body: {
        model: "gemma-4-31b-it",
        previous_interaction_id: first.id,
        input: { type: "function_result", call_id: "call_1", result: { temperature: 28 } },
      } });
      assert.equal(second.status, "completed");
      assert.deepEqual(second.usage, {
        total_input_tokens: 8,
        total_output_tokens: 4,
        total_thought_tokens: 0,
        total_tokens: 12,
      });
      const secondRequest = gateway.calls[1]?.body as { contents: { parts: Record<string, unknown>[] }[] };
      assert.equal(secondRequest.contents.length, 3);
      assert.deepEqual(secondRequest.contents[1]?.parts[0]?.functionCall, { name: "weather", args: { city: "上海" }, id: "call_1" });
      assert.deepEqual(secondRequest.contents[2]?.parts[0]?.functionResponse, {
        name: "weather",
        response: { result: { temperature: 28 } },
        id: "call_1",
      });

      gateway.responses.push({ candidates: [{ content: { parts: [{ text: "流式答案" }] } }] });
      const chunks: string[] = [];
      await bridge.request("interaction_create", { body: { model: "gemma-4-31b-it", input: "stream", stream: true, store: false } }, chunk => chunks.push(chunk));
      const sse = chunks.join("");
      assert.match(sse, /"event_type":"step\.delta"/u);
      assert.match(sse, /"text":"流式答案"/u);
      // The 2026-05 steps schema renames the terminal event and requires a
      // named SSE event line alongside the data payload.
      assert.match(sse, /event: interaction\.created\ndata: /u);
      assert.match(sse, /event: interaction\.completed\ndata: /u);
      assert.doesNotMatch(sse, /interaction\.complete"/u);
      assert.match(sse, /event: done\ndata: \[DONE\]/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("converts Interactions built-in tools to Gemini-native declarations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-builtins-"));
    try {
      const gateway = new FakeGateway();
      gateway.responses.push({ candidates: [{ content: { parts: [{ text: "结果" }] } }] });
      const bridge = new NativeBackendBridge(
        gateway,
        new InteractionStore(directory, 0),
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
      );
      await bridge.request("interaction_create", { body: {
        model: "gemini-3-flash-preview",
        input: "搜索并计算",
        tools: [{ type: "google_search" }, { type: "code_execution" }],
      } });
      const body = gateway.calls[0]?.body as { tools?: unknown[] };
      assert.deepEqual(body.tools, [{ googleSearch: {} }, { codeExecution: {} }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards generation_config and rejects unusable media content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-generation-"));
    try {
      const gateway = new FakeGateway();
      gateway.responses.push({ candidates: [{ content: { parts: [{ text: "结果" }] } }] });
      const bridge = new NativeBackendBridge(
        gateway,
        new InteractionStore(directory, 0),
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
      );
      await bridge.request("interaction_create", { body: {
        model: "gemini-3-flash-preview",
        input: "你好",
        store: false,
        generation_config: { thinking_level: "low", max_output_tokens: 256 },
      } });
      const body = gateway.calls[0]?.body as { generationConfig?: unknown };
      assert.deepEqual(body.generationConfig, { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 256 });

      await assert.rejects(
        bridge.request("interaction_create", { body: {
          model: "gemini-3-flash-preview",
          input: [{ type: "image", image_url: "data:image/png;base64,AAAA" }],
          store: false,
        } }),
        (error: unknown) => (error as { statusCode?: number }).statusCode === 400,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("dispatches native browser and remote login sessions", async () => {    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-login-"));
    try {
      const login = new FakeLogin();
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        new InteractionStore(directory, 0),
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
        login,
      );
      assert.deepEqual(await bridge.request("login_start", { name: "新账号", remote: true }), { session_id: "login_test" });
      assert.deepEqual(login.started, { name: "新账号", remote: true });
      const status = await bridge.request<LoginSessionView>("login_status", { session_id: "login_test" });
      assert.equal(status.step?.kind, "email");
      assert.deepEqual(await bridge.request("login_input", { session_id: "login_test", value: "user@example.com" }), { ok: true });
      assert.deepEqual(login.submitted, { id: "login_test", value: "user@example.com" });
      assert.deepEqual(await bridge.request("login_cancel", { session_id: "login_test" }), { ok: true });
      assert.equal(login.cancelled, "login_test");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
