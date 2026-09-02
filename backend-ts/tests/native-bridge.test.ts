import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { AccountStore } from "../src/accounts/account-store.js";
import { NativeBackendBridge, type NativeGatewayBackend } from "../src/bridge/native-bridge.js";
import { ExactResponseCache } from "../src/cache/exact-response-cache.js";
import { StatsStore } from "../src/stats/stats-store.js";
import type { LoginSessionBackend, LoginSessionView } from "../src/accounts/login-session-manager.js";
import type { NativeGenerationOptions } from "../src/gateway/native-gateway.js";

/** 每个 bridge 用独立的内存缓存：默认的 SQLite 缓存在同进程内跨测试共享文件，会互相污染。 */
function freshCache(): ExactResponseCache {
  return new ExactResponseCache({ enabled: true, ttlSeconds: 3600, maxBytes: 32 * 1024 * 1024, maxEntryBytes: 1024 * 1024 });
}

import { settings } from "../src/config.js";

class FakeGateway implements NativeGatewayBackend {
  calls: { model: string; body: unknown; options?: NativeGenerationOptions | undefined }[] = [];
  responses: Record<string, unknown>[] = [];
  responseIds: string[] = [];
  errors: Error[] = [];
  async warmup(): Promise<void> {}
  async close(): Promise<void> {}
  async switchAuth(): Promise<void> {}
  async models(): Promise<Record<string, unknown>[]> { return []; }
  async countTokens(_model: string, _body: unknown): Promise<Record<string, unknown>> { return { totalTokens: 0 }; }
  async generate(
    model: string,
    body: unknown,
    _signal?: AbortSignal,
    options?: NativeGenerationOptions,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ model, body, options });
    const error = this.errors.shift();
    if (error) throw error;
    const response = this.responses.shift() ?? {};
    const responseId = this.responseIds.shift();
    if (responseId) options?.onResponseId?.(responseId);
    return response;
  }
  async generateStream(
    model: string,
    body: unknown,
    onResponse: (response: Record<string, unknown>) => void,
    signal?: AbortSignal,
    options?: NativeGenerationOptions,
  ): Promise<Record<string, unknown>> {
    const response = await this.generate(model, body, signal, options);
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
  async screenshot(sessionId: string): Promise<{ image: string; width: number; height: number } | "missing"> {
    return sessionId === "login_test" ? { image: "data:image/jpeg;base64,test", width: 100, height: 100 } : "missing";
  }
  async click(sessionId: string, _xRatio: number, _yRatio: number): Promise<"ok" | "missing"> {
    return sessionId === "login_test" ? "ok" : "missing";
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

describe("native gateway bridge", () => {
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
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
        undefined,
        undefined,
        freshCache(),
      );
      const catalog = await bridge.request<Record<string, unknown>[]>("models");
      assert.deepEqual(catalog.map(item => item.name), ["models/gemini-native"]);
      await bridge.request("generate", { model: "gemini-native", body: {} });
      assert.equal(native.calls.length, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses an exact tool-free generation response", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-response-cache-"));
    try {
      const native = new FakeGateway();
      native.responses.push({ candidates: [{ content: { parts: [{ text: "cached" }] } }], usageMetadata: { totalTokenCount: 3 } });
      const stats = new StatsStore(join(directory, "stats.json"));
      const bridge = new NativeBackendBridge(
        native,
        new AccountStore(join(directory, "accounts")),
        stats,
        undefined,
        undefined,
        freshCache(),
      );
      const params = { model: "gemini-native", body: { contents: [{ role: "user", parts: [{ text: "same" }] }] } };
      const first = await bridge.request("generate", params);
      const second = await bridge.request("generate", params);
      assert.deepEqual(second, first);
      assert.equal(native.calls.length, 1);
      const snapshot = await stats.snapshot();
      assert.equal(snapshot.models["gemini-native"]?.requests, 2);
      assert.equal(snapshot.models["gemini-native"]?.total_tokens, 3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates identical in-flight generation requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-inflight-dedup-"));
    try {
      const native = new FakeGateway();
      let release: (value: Record<string, unknown>) => void = () => {};
      const gate = new Promise<Record<string, unknown>>((resolve) => { release = resolve; });
      native.generate = (model: string, body: unknown) => {
        native.calls.push({ model, body });
        return gate;
      };
      const bridge = new NativeBackendBridge(
        native,
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
        undefined,
        undefined,
        freshCache(),
      );
      const params = { model: "gemini-native", body: { contents: [{ role: "user", parts: [{ text: "same" }] }] } };
      const first = bridge.request("generate", params);
      const second = bridge.request("generate", params);
      // 等两个请求都穿过缓存查询进入在途表
      await new Promise((resolve) => setTimeout(resolve, 10));
      release({ candidates: [{ content: { parts: [{ text: "shared" }] } }] });
      const [a, b] = await Promise.all([first, second]);
      assert.deepEqual(a, b);
      assert.equal(native.calls.length, 1); // 上游只发了一次
      const snapshot = await bridge.request<{ cache: { dedupedHits: number } }>("stats");
      assert.equal(snapshot.cache.dedupedHits, 1);
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
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
        undefined,
        undefined,
        freshCache(),
      );
      await assert.rejects(bridge.request("models"), /ListModels returned HTTP 401/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses a warm account gateway instead of cold-starting for round-robin fairness", async () => {
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
        accountStore,
        new StatsStore(join(directory, "stats.json")),
        undefined,
        factory,
        freshCache(),
      );
      await bridge.request("generate", { model: "gemini-test", body: {} });
      await bridge.request("generate", { model: "gemini-test", body: { turn: 2 } });
      assert.equal(gateways.size, 1);
      assert.deepEqual([...gateways.values()].map(gateway => gateway.calls.length), [2]);
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
      const closed: string[] = [];
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const gateway = gateways.get(accountId) ?? new FakeGateway();
        gateway.close = async () => { closed.push(accountId); };
        if (accountId === accounts[0]?.id) gateway.errors.push(new Error("AI Studio upstream returned HTTP 429"));
        else gateway.responses.push({ candidates: [{ content: { parts: [{ text: "from-b" }] } }] });
        gateways.set(accountId, gateway);
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        accountStore,
        new StatsStore(join(directory, "stats.json")),
        undefined,
        factory,
        freshCache(),
      );
      const result = await bridge.request<Record<string, unknown>>("generate", { model: "gemini-test", body: {} });
      assert.equal((result.candidates as Record<string, unknown>[])[0]?.content !== undefined, true);
      assert.equal(gateways.size, 2);
      assert.equal(gateways.get(accounts[0]!.id)?.calls.length, 1);
      assert.equal(gateways.get(accounts[1]!.id)?.calls.length, 1);
      // 429 只冷却账号，不销毁浏览器；冷却结束后仍可零冷启动复用。
      assert.deepEqual(closed, []);
      const snapshot = await bridge.request<{ browsers_alive: number }>("stats");
      assert.equal(snapshot.browsers_alive, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails over to another account on a retryable upstream 500 and resets the bad browser", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-500-failover-"));
    try {
      const accountStore = new AccountStore(join(directory, "accounts"));
      for (const [name, email] of [["A", "a@example.com"], ["B", "b@example.com"]] as const) {
        await accountStore.saveStorageState({
          name, email,
          storageState: { cookies: [{ name: "SID", value: name, domain: ".google.com", path: "/" }], origins: [] },
        });
      }
      const accounts = await accountStore.list();
      const closed: string[] = [];
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const gateway = new FakeGateway();
        gateway.close = async () => { closed.push(accountId); };
        if (accountId === accounts[0]?.id) gateway.errors.push(new Error("AI Studio upstream returned HTTP 500"));
        else gateway.responses.push({ candidates: [{ content: { parts: [{ text: "recovered" }] } }] });
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        accountStore,
        new StatsStore(join(directory, "stats.json")), undefined, factory, freshCache(),
      );
      const result = await bridge.request<Record<string, unknown>>("generate", { model: "gemini-test", body: {} });
      assert.equal((result.candidates as Record<string, unknown>[])[0]?.content !== undefined, true);
      assert.deepEqual(closed, [accounts[0]!.id]);
      const snapshot = await bridge.request<{ browsers_alive: number }>("stats");
      assert.equal(snapshot.browsers_alive, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails over when an upstream response contains no candidate chunk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-candidate-failover-"));
    try {
      const accountStore = new AccountStore(join(directory, "accounts"));
      for (const [name, email] of [["A", "a@example.com"], ["B", "b@example.com"]] as const) {
        await accountStore.saveStorageState({
          name, email,
          storageState: { cookies: [{ name: "SID", value: name, domain: ".google.com", path: "/" }], origins: [] },
        });
      }
      const accounts = await accountStore.list();
      const gateways = new Map<string, FakeGateway>();
      const closed: string[] = [];
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const gateway = new FakeGateway();
        gateway.close = async () => { closed.push(accountId); };
        if (accountId === accounts[0]?.id) gateway.errors.push(new Error("AI Studio response did not contain a candidate chunk (0 response bytes)"));
        else gateway.responses.push({ candidates: [{ content: { parts: [{ text: "recovered" }] } }] });
        gateways.set(accountId, gateway);
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        accountStore,
        new StatsStore(join(directory, "stats.json")), undefined, factory, freshCache(),
      );
      const result = await bridge.request<Record<string, unknown>>("generate", { model: "gemini-test", body: {} });
      assert.equal((result.candidates as Record<string, unknown>[])[0]?.content !== undefined, true);
      assert.equal(gateways.get(accounts[0]!.id)?.calls.length, 1);
      assert.equal(gateways.get(accounts[1]!.id)?.calls.length, 1);
      assert.deepEqual(closed, [accounts[0]!.id]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports when all attempted accounts are quota-limited", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-quota-exhausted-"));
    try {
      const accountStore = new AccountStore(join(directory, "accounts"));
      for (const [name, email] of [["A", "a@example.com"], ["B", "b@example.com"]] as const) {
        await accountStore.saveStorageState({
          name, email,
          storageState: { cookies: [{ name: "SID", value: name, domain: ".google.com", path: "/" }], origins: [] },
        });
      }
      const factory = (): FakeGateway => {
        const gateway = new FakeGateway();
        gateway.errors.push(new Error("AI Studio upstream returned HTTP 429: quota exceeded"));
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        accountStore,
        new StatsStore(join(directory, "stats.json")), undefined, factory, freshCache(),
      );
      await assert.rejects(
        bridge.request("generate", { model: "gemini-test", body: {} }),
        (error: unknown) => {
          if (!error || typeof error !== "object" || !("statusCode" in error)) return false;
          assert.equal(error.statusCode, 429);
          assert.match(String(error), /HTTP 429/u);
          return true;
        },
      );
      const logs = await bridge.request<Record<string, unknown>[]>("request_logs");
      assert.equal(logs[0]?.status, "rate_limited");
      assert.match(String(logs[0]?.error), /quota unavailable/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("evicts the least-recently-used account browser beyond the keep-alive cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-gateway-lru-"));
    try {
      const accountStore = new AccountStore(join(directory, "accounts"));
      for (const [name, email] of [["A", "a@example.com"], ["B", "b@example.com"], ["C", "c@example.com"]] as const) {
        await accountStore.saveStorageState({
          name,
          email,
          storageState: { cookies: [{ name: "SID", value: name, domain: ".google.com", path: "/" }], origins: [] },
        });
      }
      const closed: string[] = [];
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const gateway = new FakeGateway();
        gateway.responses.push({ candidates: [{ content: { parts: [{ text: accountId }] } }] });
        gateway.close = async () => { closed.push(accountId); };
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        accountStore,
        new StatsStore(join(directory, "stats.json")),
        undefined,
        factory,
        freshCache(),
      );
      const accounts = await accountStore.list();
      // 手动激活三个账号只测试 gateway 池本身，不受“温热账号优先”选择策略影响。
      for (const account of accounts) await bridge.request("accounts_activate", { account_id: account.id });
      // 保活上限默认 2：第三个实例创建后，最旧的 A 应被淘汰关闭（测试宽限期为 0）
      assert.equal(closed.length, 1);
      const snapshot = await bridge.request<{ browsers_alive: number }>("stats");
      assert.equal(snapshot.browsers_alive, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not evict account browsers within the grace period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-gateway-grace-"));
    const originalGrace = settings.browserEvictGraceMs;
    (settings as { browserEvictGraceMs: number }).browserEvictGraceMs = 60_000;
    try {
      const accountStore = new AccountStore(join(directory, "accounts"));
      for (const [name, email] of [["A", "a@example.com"], ["B", "b@example.com"], ["C", "c@example.com"]] as const) {
        await accountStore.saveStorageState({
          name,
          email,
          storageState: { cookies: [{ name: "SID", value: name, domain: ".google.com", path: "/" }], origins: [] },
        });
      }
      const closed: string[] = [];
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const gateway = new FakeGateway();
        gateway.responses.push({ candidates: [{ content: { parts: [{ text: accountId }] } }] });
        gateway.close = async () => { closed.push(accountId); };
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        accountStore,
        new StatsStore(join(directory, "stats.json")),
        undefined,
        factory,
        freshCache(),
      );
      const accounts = await accountStore.list();
      for (const account of accounts) await bridge.request("accounts_activate", { account_id: account.id });
      // 宽限期 60s 内：第三个实例虽超上限 2，也暂时保留，避免高频时反复冷启动。
      assert.equal(closed.length, 0);
      const snapshot = await bridge.request<{ browsers_alive: number }>("stats");
      assert.equal(snapshot.browsers_alive, 3);
    } finally {
      (settings as { browserEvictGraceMs: number }).browserEvictGraceMs = originalGrace;
      await rm(directory, { recursive: true, force: true });
    }
  });


  it("pins a function response continuation to its originating account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-continuation-"));
    const originalContinuation = settings.privateContinuationEnabled;
    (settings as { privateContinuationEnabled: boolean }).privateContinuationEnabled = true;
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
      const accountA = accounts[0]!.id;
      const gateways = new Map<string, FakeGateway>();
      const factory = (authFile: string): FakeGateway => {
        const accountId = basename(dirname(authFile));
        const existing = gateways.get(accountId);
        if (existing) return existing;
        const gateway = new FakeGateway();
        if (accountId === accountA) {
          gateway.responses.push(
            { candidates: [{ content: { parts: [{ functionCall: { name: "weather", args: { city: "北京" }, id: "call_1" } }] } }] },
            { candidates: [{ content: { parts: [{ text: "晴" }] } }] },
          );
          gateway.responseIds.push("v1_response_a", "v1_final_a");
        } else {
          gateway.responses.push({ candidates: [{ content: { parts: [{ text: "from-b" }] } }] });
        }
        gateways.set(accountId, gateway);
        return gateway;
      };
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        accountStore,
        new StatsStore(join(directory, "stats.json")),
        undefined,
        factory,
        freshCache(),
      );
      await bridge.request("accounts_activate", { account_id: accountA });
      const tools = { functionDeclarations: [{ name: "weather", description: "weather", parameters: { type: "object" } }] };
      await bridge.request("generate", {
        model: "gemini-test",
        body: { contents: [{ role: "user", parts: [{ text: "北京天气" }] }], tools: [tools] },
      });
      await bridge.request("generate", {
        model: "gemini-test",
        body: {
          contents: [
            { role: "user", parts: [{ text: "北京天气" }] },
            { role: "model", parts: [{ functionCall: { name: "weather", args: { city: "北京" }, id: "call_1" } }] },
            { role: "user", parts: [{ functionResponse: { name: "weather", response: "晴", id: "call_1" } }] },
          ],
          tools: [tools],
        },
      });
      const gatewayA = gateways.get(accountA)!;
      assert.equal(gatewayA.calls.length, 2);
      assert.equal(gatewayA.calls[1]?.options?.previousResponseId, "v1_response_a");
      assert.equal(gateways.get(accounts[1]!.id)?.calls.length ?? 0, 0);
    } finally {
      (settings as { privateContinuationEnabled: boolean }).privateContinuationEnabled = originalContinuation;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards native generation configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-generation-"));
    try {
      const gateway = new FakeGateway();
      gateway.responses.push({ candidates: [{ content: { parts: [{ text: "结果" }] } }] });
      const bridge = new NativeBackendBridge(
        gateway,
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
        undefined,
        undefined,
        freshCache(),
      );
      await bridge.request("generate", {
        model: "gemini-3-flash-preview",
        body: {
          contents: [{ role: "user", parts: [{ text: "你好" }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 256 },
        },
      });
      const body = gateway.calls[0]?.body as { generationConfig?: unknown };
      assert.deepEqual(body.generationConfig, { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 256 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("dispatches native browser and remote login sessions", async () => {    const directory = await mkdtemp(join(tmpdir(), "aistudio-native-login-"));
    try {
      const login = new FakeLogin();
      const bridge = new NativeBackendBridge(
        new FakeGateway(),
        new AccountStore(join(directory, "accounts")),
        new StatsStore(join(directory, "stats.json")),
        login,
        undefined,
        freshCache(),
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
