import { randomBytes } from "node:crypto";
import { BridgeError, type BackendBridge } from "./backend-bridge.js";
import { NativeGateway } from "../gateway/native-gateway.js";
import { InteractionStore } from "../interactions/store.js";
import { interactionToGeminiRequest, outputToSteps } from "../interactions/normalize.js";
import type { BuiltinToolName, GeminiGenerateRequest, InteractionContent, InteractionCreateRequest, InteractionStep, JsonValue, ModelOutput } from "../interactions/types.js";
import { parseInteractionCreateRequest } from "../interactions/validate.js";
import { settings } from "../config.js";
import { AccountStore } from "../accounts/account-store.js";
import { AccountRotator, isRateLimitedError, type RotationMode } from "../accounts/account-rotator.js";
import type { AccountProfile } from "../accounts/account-profile.js";
import { StatsStore } from "../stats/stats-store.js";
import { LoginSessionManager, type LoginSessionBackend } from "../accounts/login-session-manager.js";
import { NativeBrowserSession } from "../gateway/browser-session.js";
import { filterSupportedModelCatalog } from "../gateway/model-catalog.js";
import { AsyncMutex } from "../storage/atomic-json.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function interactionId(): string {
  return `v1_${randomBytes(24).toString("base64url")}`;
}

function currentInputSteps(input: InteractionCreateRequest["input"]): InteractionStep[] {
  let steps: InteractionStep[];
  if (typeof input === "string") {
    steps = [{ type: "user_input", status: "done", content: [{ type: "text", text: input }] }];
  } else if (Array.isArray(input)) {
    if (input.length === 0) return [];
    const first = input[0];
    steps = isRecord(first) && ["text", "image", "audio", "document"].includes(String(first.type))
      ? [{ type: "user_input", status: "done", content: input as readonly InteractionContent[] }]
      : [...(input as readonly InteractionStep[])];
  } else {
    const single = input as InteractionContent | InteractionStep;
    steps = ["text", "image", "audio", "document"].includes(single.type)
      ? [{ type: "user_input", status: "done", content: [single as InteractionContent] }]
      : [single as InteractionStep];
  }
  // A client-provided function_call whose function_result rides along in the
  // same input is already answered; only unmatched calls stay waiting.
  const answered = new Set(steps.flatMap(step => step.type === "function_result" ? [step.call_id] : []));
  return steps.map(step => ({
    ...step,
    status: step.type === "function_call" && !answered.has(step.id) ? "waiting" : "done",
  }) as InteractionStep);
}

function geminiOutput(response: Record<string, unknown>): ModelOutput {
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const candidate = isRecord(candidates[0]) ? candidates[0] : {};
  const content = isRecord(candidate.content) ? candidate.content : {};
  const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
  const functionCalls = parts.flatMap(part => {
    if (!isRecord(part.functionCall) || typeof part.functionCall.name !== "string") return [];
    return [{
      name: part.functionCall.name,
      args: (isRecord(part.functionCall.args) ? part.functionCall.args : {}) as Record<string, JsonValue>,
      ...(typeof part.functionCall.id === "string" ? { call_id: part.functionCall.id } : {}),
      ...(typeof part.thoughtSignature === "string" ? { thought_signature: part.thoughtSignature } : {}),
    }];
  });
  const thinkingSignature = parts.find(part => part.thought === true && typeof part.thoughtSignature === "string")?.thoughtSignature as string | undefined;
  return {
    thinking: parts.filter(part => part.thought === true && typeof part.text === "string").map(part => part.text).join(""),
    ...(thinkingSignature ? { thinking_signature: thinkingSignature } : {}),
    text: parts.filter(part => part.thought !== true && typeof part.text === "string").map(part => part.text).join(""),
    function_calls: functionCalls,
    images: parts.flatMap(part => {
      if (!isRecord(part.inlineData) || typeof part.inlineData.data !== "string") return [];
      const mime = typeof part.inlineData.mimeType === "string" ? part.inlineData.mimeType : "application/octet-stream";
      if (!mime.startsWith("image/")) return [];
      return [{ type: "image" as const, data: part.inlineData.data, mime_type: mime }];
    }),
    audio: parts.flatMap(part => {
      if (!isRecord(part.inlineData) || typeof part.inlineData.data !== "string") return [];
      const mime = typeof part.inlineData.mimeType === "string" ? part.inlineData.mimeType : "application/octet-stream";
      if (!mime.startsWith("audio/")) return [];
      return [{ type: "audio" as const, data: part.inlineData.data, mime_type: mime }];
    }),
  };
}

const BUILTIN_TOOL_PAYLOADS: Readonly<Record<BuiltinToolName, Record<string, unknown>>> = {
  google_search: { googleSearch: {} },
  code_execution: { codeExecution: {} },
  google_maps: { googleMaps: {} },
  url_context: { urlContext: {} },
};

function interactionTools(request: InteractionCreateRequest): Record<string, unknown>[] | undefined {
  return request.tools?.map(tool => {
    if (tool.type !== "function") return BUILTIN_TOOL_PAYLOADS[tool.type];
    return {
      functionDeclarations: [{
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      }],
    };
  });
}

class InteractionStreamEmitter {
  private sequence = 0;
  private index = -1;
  private activeType: "thought" | "model_output" | undefined;
  private interactionId = "";
  private started = false;

  constructor(private readonly onChunk: (chunk: string) => void) {}

  created(id: string, model: string): void {
    this.interactionId = id;
    this.send("interaction.created", { interaction: { id, object: "interaction", model, status: "in_progress" } });
  }

  push(response: Record<string, unknown>): void {
    if (!this.started) {
      this.started = true;
      this.send("interaction.in_progress", { interaction_id: this.interactionId });
    }
    for (const step of outputToSteps(geminiOutput(response))) {
      if (step.type === "function_call") {
        this.stopActive();
        const index = ++this.index;
        this.send("step.start", { index, step });
        this.send("step.stop", { index, status: step.status ?? "done" });
        continue;
      }
      if (step.type !== "thought" && step.type !== "model_output") continue;
      if (this.activeType !== step.type) {
        this.stopActive();
        this.activeType = step.type;
        this.index += 1;
        const emptyStep = step.type === "thought"
          ? { type: "thought", status: "in_progress", summary: [] }
          : { type: "model_output", status: "in_progress", content: [] };
        this.send("step.start", { index: this.index, step: emptyStep });
      }
      if (step.type === "thought") {
        for (const item of step.summary ?? []) {
          if (item.type === "text") this.send("step.delta", { index: this.index, delta: { type: "text", text: item.text } });
        }
      } else {
        for (const item of step.content) {
          if (item.type === "text") this.send("step.delta", { index: this.index, delta: { type: "text", text: item.text } });
          else if (item.type === "image" && item.data) {
            this.send("step.delta", { index: this.index, delta: { type: "image", data: item.data, mime_type: item.mime_type } });
          } else if (item.type === "audio" && item.data) {
            this.send("step.delta", { index: this.index, delta: { type: "audio", data: item.data, mime_type: item.mime_type } });
          }
        }
      }
    }
  }

  complete(interaction: Record<string, unknown>): void {
    if (!this.started) {
      // No delta ever pushed (e.g. an immediate function_call): still emit the
      // in_progress event so the sequence created → in_progress → terminal holds.
      this.started = true;
      this.send("interaction.in_progress", { interaction_id: this.interactionId });
    }
    this.stopActive();
    const terminal = interaction.status === "requires_action" ? "interaction.requires_action" : "interaction.completed";
    this.send(terminal, { interaction });
    this.onChunk("event: done\ndata: [DONE]\n\n");
  }

  private stopActive(): void {
    if (!this.activeType) return;
    this.send("step.stop", { index: this.index, status: "done" });
    this.activeType = undefined;
  }

  private send(eventType: string, payload: Record<string, unknown>): void {
    const data = JSON.stringify({ event_id: `evt_${++this.sequence}`, event_type: eventType, ...payload });
    this.onChunk(`event: ${eventType}\ndata: ${data}\n\n`);
  }
}

export interface NativeGatewayBackend {
  warmup(): Promise<void>;
  close(): Promise<void>;
  switchAuth(authFile: string): Promise<void>;
  models(): Promise<Record<string, unknown>[]>;
  generate(model: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>>;
  generateStream(model: string, body: unknown, onResponse: (response: Record<string, unknown>) => void, signal?: AbortSignal): Promise<Record<string, unknown>>;
  inspectAccountProfile?(): Promise<AccountProfile>;
}

export class NativeBackendBridge implements BackendBridge {
  private running = false;
  private readonly activatedLoginSessions = new Set<string>();
  private readonly accountGateways = new Map<string, NativeGatewayBackend>();
  private readonly gatewayMutex = new AsyncMutex();
  private readonly rotator: AccountRotator;

  constructor(
    private readonly gateway: NativeGatewayBackend = new NativeGateway(),
    private readonly interactions = new InteractionStore(),
    private readonly accounts = new AccountStore(),
    private readonly stats = new StatsStore(),
    private readonly login: LoginSessionBackend = new LoginSessionManager(accounts),
    private readonly gatewayFactory: (authFile: string) => NativeGatewayBackend = (authFile) => new NativeGateway(new NativeBrowserSession(authFile)),
  ) {
    this.rotator = new AccountRotator(this.accounts, settings.accountRotationMode, settings.accountCooldownSeconds);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const savedRotation = await this.accounts.rotationConfig();
    if (savedRotation && ["round_robin", "lru", "least_rl"].includes(savedRotation.mode) && Number.isFinite(savedRotation.cooldown_seconds)) {
      this.rotator.setConfig(savedRotation.mode as RotationMode, Math.max(0, savedRotation.cooldown_seconds));
    }
    const active = await this.accounts.active();
    const gateway = active ? await this.gatewayForAccount(active.id) : this.gateway;
    void gateway.warmup().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.login.stop();
    const gateways = [...new Set([this.gateway, ...this.accountGateways.values()])];
    await Promise.allSettled(gateways.map(gateway => gateway.close()));
  }

  status(): Readonly<{ running: boolean; pid?: number }> {
    return { running: this.running, pid: process.pid };
  }

  async request<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
    let result: unknown;
    if (method === "health") result = { status: "ok", backend: "typescript", browser: "cloakbrowser" };
    else if (method === "stats") result = await this.stats.snapshot();
    else if (method === "models") {
      const active = await this.accounts.active();
      const nativeModels = active ? await (await this.gatewayForAccount(active.id)).models() : await this.gateway.models();
      result = filterSupportedModelCatalog(nativeModels);
    }
    else if (method === "reload_model_defaults") result = { ok: true };
    else if (method === "accounts_list") result = await this.accounts.list();
    else if (method === "accounts_active") {
      const active = await this.accounts.active();
      if (!active) throw new BridgeError(404, "没有活跃账号");
      result = active;
    } else if (method === "accounts_activate") {
      const id = String(params.account_id ?? "");
      const target = (await this.accounts.list()).find(item => item.id === id);
      if (!target || !this.accounts.authPath(id)) throw new BridgeError(404, "账号不存在");
      await (await this.gatewayForAccount(id)).warmup();
      const account = await this.accounts.activate(id);
      if (!account) throw new BridgeError(404, "账号不存在");
      result = account;
    } else if (method === "accounts_update") {
      const account = await this.accounts.update(String(params.account_id ?? ""), String(params.name ?? ""));
      if (!account) throw new BridgeError(404, "账号不存在");
      result = account;
    } else if (method === "accounts_delete") {
      const id = String(params.account_id ?? "");
      if ((await this.accounts.active())?.id === id) throw new BridgeError(409, "请先切换到其他账号，再删除当前活跃账号");
      const gateway = this.accountGateways.get(id);
      if (gateway) {
        await gateway.close().catch(() => undefined);
        this.accountGateways.delete(id);
      }
      this.rotator.removeAccount(id);
      if (!await this.accounts.delete(id)) throw new BridgeError(404, "账号不存在");
      result = { ok: true };
    } else if (method === "accounts_refresh") {
      const id = String(params.account_id ?? "");
      const account = await this.refreshAccountProfile(id);
      result = account;
    } else if (method === "import_cookies") {
      try {
        const imported = await this.accounts.importCookies({ ...params });
        const oldGateway = this.accountGateways.get(imported.account.id);
        if (oldGateway) {
          await oldGateway.close().catch(() => undefined);
          this.accountGateways.delete(imported.account.id);
        }
        if ((await this.accounts.active())?.id === imported.account.id) {
          await (await this.gatewayForAccount(imported.account.id)).warmup();
        }
        result = {
          account_id: imported.account.id,
          name: imported.account.name,
          cookie_count: imported.cookieCount,
          domain_summary: { ".google.com": imported.cookieCount },
        };
      } catch (error) {
        throw new BridgeError(400, { message: String(error), type: "bad_request" });
      }
    } else if (method === "rotation_status" || method === "rotation_accounts") {
      const accounts = await this.accounts.list();
      const stats = await this.rotator.getAllStats();
      const views = Object.fromEntries(accounts.map(account => [account.id, { ...account, ...(stats[account.id] ?? {}) }]));
      result = method === "rotation_accounts" ? Object.values(views) : {
        enabled: true,
        mode: this.rotator.mode,
        cooldown_seconds: this.rotator.cooldown,
        profile_refresh_ms: settings.accountProfileRefreshMs,
        accounts: views,
      };
    } else if (method === "rotation_mode") {
      const mode = String(params.mode ?? "");
      if (!["round_robin", "lru", "least_rl"].includes(mode)) throw new BridgeError(400, `无效的轮询模式: ${mode}`);
      const cooldown = params.cooldown_seconds === undefined ? this.rotator.cooldown : Number(params.cooldown_seconds);
      if (!Number.isFinite(cooldown) || cooldown < 0) throw new BridgeError(400, "冷却时间必须是非负数字");
      this.rotator.setConfig(mode as RotationMode, cooldown);
      await this.accounts.saveRotationConfig({ mode, cooldown_seconds: this.rotator.cooldown });
      result = { ok: true, mode, cooldown_seconds: this.rotator.cooldown };
    } else if (method === "rotation_next") {
      const next = await this.rotator.getManualNextAccount();
      if (!next) throw new BridgeError(404, "没有其他可用账号");
      await (await this.gatewayForAccount(next.id)).warmup();
      await this.accounts.activate(next.id);
      result = { ok: true, account: next };
    } else if (method === "login_start") {
      try {
        result = await this.login.start({
          ...(typeof params.name === "string" ? { name: params.name } : {}),
          remote: params.remote === true,
        });
      } catch (error) {
        throw new BridgeError(409, { message: error instanceof Error ? error.message : String(error), type: "login_in_progress" });
      }
    } else if (method === "login_status") {
      const sessionId = String(params.session_id ?? "");
      const session = this.login.status(sessionId);
      if (!session) throw new BridgeError(404, { message: "登录会话不存在", type: "not_found" });
      if (session.status === "completed" && session.account_id && !this.activatedLoginSessions.has(sessionId)) {
        if (this.accounts.authPath(session.account_id)) {
          await (await this.gatewayForAccount(session.account_id)).warmup();
          await this.accounts.activate(session.account_id);
        }
        this.activatedLoginSessions.add(sessionId);
      }
      result = session;
    } else if (method === "login_input") {
      const submitted = this.login.submit(String(params.session_id ?? ""), String(params.value ?? ""));
      if (submitted === "missing") throw new BridgeError(404, { message: "登录会话不存在", type: "not_found" });
      if (submitted === "not_waiting") throw new BridgeError(409, { message: "当前登录步骤不接受输入", type: "conflict" });
      result = { ok: true };
    } else if (method === "login_cancel") {
      const cancelled = await this.login.cancel(String(params.session_id ?? ""));
      if (cancelled === "missing") throw new BridgeError(404, { message: "登录会话不存在", type: "not_found" });
      result = { ok: true };
    }
    else if (method === "generate") {
      const model = String(params.model ?? "");
      let response: Record<string, unknown>;
      try {
        const streamResponse = params.stream === true && onChunk
          ? (chunk: Record<string, unknown>) => onChunk(`data: ${JSON.stringify(chunk)}\n\n`)
          : undefined;
        response = await this.generateWithRotation(
          model,
          params.body,
          streamResponse,
          signal,
          () => this.stats.record(model, "rate_limited"),
        );
        await this.stats.record(model, "success", isRecord(response.usageMetadata) ? response.usageMetadata : undefined);
      } catch (error) {
        // rate_limited is already counted per failed attempt by onRateLimited.
        if (!isRateLimitedError(error)) await this.stats.record(model, "errors");
        throw error;
      }
      // Gemini SSE 协议没有 [DONE] 结束标记；发送它会让客户端（如 pi 的
      // google-generative-ai 适配器）把 "[DONE]" 当 JSON 解析而报错，流自然结束即可。
      result = response;
    } else if (method === "interaction_validate") {
      await this.prepareInteraction(isRecord(params.body) ? params.body : {});
      result = { ok: true };
    } else if (method === "interaction_create") {
      result = await this.createInteraction(isRecord(params.body) ? params.body : {}, onChunk, signal);
    } else {
      throw new BridgeError(501, { message: `${method} is not migrated to the native TypeScript gateway yet`, type: "not_implemented" });
    }
    return result as T;
  }

  private async gatewayForAccount(accountId: string): Promise<NativeGatewayBackend> {
    const existing = this.accountGateways.get(accountId);
    if (existing) return existing;
    const authFile = this.accounts.authPath(accountId);
    if (!authFile) throw new BridgeError(404, "账号不存在或 auth.json 缺失");
    return this.gatewayMutex.run(async () => {
      const cached = this.accountGateways.get(accountId);
      if (cached) return cached;
      const gateway = this.gatewayFactory(authFile);
      this.accountGateways.set(accountId, gateway);
      return gateway;
    });
  }

  private async refreshAccountProfile(accountId: string): Promise<unknown> {
    const account = (await this.accounts.list()).find(item => item.id === accountId);
    if (!account) throw new BridgeError(404, "账号不存在");
    const gateway = await this.gatewayForAccount(accountId);
    if (!gateway.inspectAccountProfile) {
      throw new BridgeError(501, "当前网关不支持账号资料读取");
    }
    try {
      const profile = await gateway.inspectAccountProfile();
      const updated = await this.accounts.updateProfile(accountId, profile);
      if (!updated) throw new Error("账号在资料刷新期间被删除");
      return updated;
    } catch (error) {
      await this.accounts.updateProfile(accountId, {
        email: null,
        nickname: null,
        avatar_url: null,
        tier: "unknown",
        tier_label: null,
        membership_next_at: null,
        membership_next_at_kind: null,
      }, String(error));
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(502, { message: `读取 Google 账号资料失败: ${String(error)}`, type: "account_profile_unavailable" });
    }
  }

  private async generateWithRotation(
    model: string,
    body: unknown,
    onChunk?: (chunk: Record<string, unknown>) => void,
    signal?: AbortSignal,
    onRateLimited?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const all = await this.accounts.list();
    if (all.length === 0) {
      return onChunk
        ? this.gateway.generateStream(model, body, onChunk, signal)
        : this.gateway.generate(model, body, signal);
    }
    const maxAttempts = Math.min(Math.max(1, settings.accountMaxRetries), all.length);
    const attempted = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
      const account = await this.rotator.getNextAccount(signal);
      if (!account) break;
      if (attempted.has(account.id)) {
        attempt -= 1;
        if (attempted.size >= all.length) break;
        continue;
      }
      attempted.add(account.id);
      let emitted = false;
      try {
        const gateway = await this.gatewayForAccount(account.id);
        // activate() is a disk write; skip it when the account is already active.
        const active = await this.accounts.active();
        if (active?.id !== account.id) await this.accounts.activate(account.id);
        const response = onChunk
          ? await gateway.generateStream(model, body, chunk => { emitted = true; onChunk(chunk); }, signal)
          : await gateway.generate(model, body, signal);
        this.rotator.recordSuccess(account.id);
        return response;
      } catch (error) {
        lastError = error;
        if (isRateLimitedError(error)) {
          this.rotator.recordRateLimited(account.id);
          if (onRateLimited) await onRateLimited().catch(() => undefined);
          if (!emitted && attempt + 1 < maxAttempts) continue;
        } else {
          this.rotator.recordError(account.id);
        }
        throw error;
      }
    }
    throw lastError ?? new Error("没有可用的 Google 账号");
  }

  // Request-side validation shared by the stream and non-stream paths. The
  // streaming route calls this before sending SSE headers so bad requests get
  // a real 4xx status instead of an HTTP 200 error frame.
  private async prepareInteraction(body: Record<string, unknown>): Promise<{
    request: InteractionCreateRequest;
    generationBody: Record<string, unknown>;
  }> {
    let request: InteractionCreateRequest;
    try { request = parseInteractionCreateRequest(body); }
    catch (error) { throw new BridgeError(400, { message: String(error), type: "bad_request" }); }
    if (request.store === false && request.previous_interaction_id) {
      throw new BridgeError(400, { message: "previous_interaction_id cannot be used when store is false", type: "bad_request" });
    }
    let history: InteractionStep[] = [];
    if (request.previous_interaction_id) {
      try { history = await this.interactions.loadHistorySteps(request.previous_interaction_id); }
      catch { throw new BridgeError(404, { message: `Interaction not found: ${request.previous_interaction_id}`, type: "not_found" }); }
    }
    let gemini: GeminiGenerateRequest;
    try { gemini = interactionToGeminiRequest(request, history); }
    catch (error) { throw new BridgeError(400, { message: String(error), type: "bad_request" }); }
    const tools = interactionTools(request);
    return {
      request,
      generationBody: { ...gemini, ...(tools ? { tools } : {}) },
    };
  }

  private async createInteraction(body: Record<string, unknown>, onChunk?: (chunk: string) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const { request, generationBody } = await this.prepareInteraction(body);
    const id = interactionId();
    const model = request.model.replace(/^models\//u, "");
    const stream = body.stream === true && onChunk ? new InteractionStreamEmitter(onChunk) : undefined;
    stream?.created(id, model);
    let response: Record<string, unknown>;
    try {
      response = await this.generateWithRotation(
        request.model,
        generationBody,
        stream ? chunk => stream.push(chunk) : undefined,
        signal,
        () => this.stats.record(request.model, "rate_limited"),
      );
      await this.stats.record(request.model, "success", isRecord(response.usageMetadata) ? response.usageMetadata : undefined);
    } catch (error) {
      // rate_limited is already counted per failed attempt by onRateLimited.
      if (!isRateLimitedError(error)) await this.stats.record(request.model, "errors");
      throw error;
    }
    let outputSteps: InteractionStep[];
    try {
      outputSteps = outputToSteps(geminiOutput(response));
    } catch (error) {
      await this.stats.record(request.model, "errors");
      throw new BridgeError(502, { message: `Failed to parse upstream response: ${String(error)}`, type: "upstream_error" });
    }
    const created = new Date().toISOString();
    const usageMetadata = isRecord(response.usageMetadata) ? response.usageMetadata : {};
    const interaction: Record<string, unknown> = {
      id,
      object: "interaction",
      model,
      status: outputSteps.some(step => step.type === "function_call") ? "requires_action" : "completed",
      created,
      previous_interaction_id: request.previous_interaction_id ?? null,
      steps: [...currentInputSteps(request.input), ...outputSteps],
      usage: {
        total_input_tokens: Number(usageMetadata.promptTokenCount ?? 0),
        total_output_tokens: Number(usageMetadata.candidatesTokenCount ?? 0),
        total_thought_tokens: Number(usageMetadata.thoughtsTokenCount ?? 0),
        total_tokens: Number(usageMetadata.totalTokenCount ?? 0),
      },
    };
    if (request.store !== false) await this.interactions.save(id, { interaction, previous_interaction_id: request.previous_interaction_id ?? null });
    const responseInteraction = { ...interaction, steps: outputSteps };
    stream?.complete(responseInteraction);
    return responseInteraction;
  }
}
