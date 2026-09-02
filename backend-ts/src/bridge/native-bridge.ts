import { BridgeError, type BackendBridge } from "./backend-bridge.js";
import { NativeGateway, type NativeGenerationOptions, type UpstreamQuotaInfo } from "../gateway/native-gateway.js";
import { settings } from "../config.js";
import { AccountStore } from "../accounts/account-store.js";
import { AccountRotator, isAuthExpiredError, isPermissionDeniedError, isRateLimitedError, type RotationMode } from "../accounts/account-rotator.js";
import type { AccountProfile } from "../accounts/account-profile.js";
import type { AccountAuthSnapshot } from "../accounts/account-store.js";
import { StatsStore } from "../stats/stats-store.js";
import { LoginSessionManager, type LoginSessionBackend } from "../accounts/login-session-manager.js";
import { NativeBrowserSession, type AuthRefreshResult } from "../gateway/browser-session.js";
import { filterSupportedModelCatalog } from "../gateway/model-catalog.js";
import { AsyncMutex } from "../storage/atomic-json.js";
import type { ResponseCacheBackend } from "../cache/exact-response-cache.js";
import { SqliteResponseCache } from "../cache/sqlite-response-cache.js";
import { RequestLogStore, type RequestLogStatus, type RequestTrace } from "../logs/request-log-store.js";
import { NativeContinuationStore, type NativeFunctionRef } from "./native-continuation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readUpstreamQuotaInfo(error: unknown): UpstreamQuotaInfo | undefined {
  if (!isRecord(error) || !isRecord(error.quotaInfo)) return undefined;
  const info = error.quotaInfo;
  const reason = info.reason;
  if (reason !== "quota_exceeded" && reason !== "per_user_quota" && reason !== "rate_limit") return undefined;
  const retryAfterMs = info.retryAfterMs;
  const quotaMetric = info.quotaMetric;
  const quotaId = info.quotaId;
  return {
    reason,
    ...(typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
    ...(typeof quotaMetric === "string" && quotaMetric ? { quotaMetric } : {}),
    ...(typeof quotaId === "string" && quotaId ? { quotaId } : {}),
  };
}

interface GenerationRouting {
  readonly preferredAccountId?: string;
  readonly previousResponseId?: string;
  readonly clearPreviousResponseId?: boolean;
  readonly onResponseId?: (responseId: string) => void;
}

function functionResponseRefs(body: unknown): NativeFunctionRef[] {
  if (!isRecord(body) || !Array.isArray(body.contents)) return [];
  const refs: NativeFunctionRef[] = [];
  const seen = new Set<string>();
  for (const rawContent of body.contents) {
    if (!isRecord(rawContent) || !Array.isArray(rawContent.parts)) continue;
    for (const rawPart of rawContent.parts) {
      if (!isRecord(rawPart) || !isRecord(rawPart.functionResponse)) continue;
      const name = rawPart.functionResponse.name;
      const id = rawPart.functionResponse.id;
      if (typeof name !== "string" || typeof id !== "string" || !name || !id || seen.has(id)) continue;
      seen.add(id);
      refs.push({ name, id });
    }
  }
  return refs;
}

function functionCallRefs(response: unknown): NativeFunctionRef[] {
  if (!isRecord(response) || !Array.isArray(response.candidates)) return [];
  const refs: NativeFunctionRef[] = [];
  const seen = new Set<string>();
  for (const rawCandidate of response.candidates) {
    if (!isRecord(rawCandidate) || !isRecord(rawCandidate.content) || !Array.isArray(rawCandidate.content.parts)) continue;
    for (const rawPart of rawCandidate.content.parts) {
      if (!isRecord(rawPart) || !isRecord(rawPart.functionCall)) continue;
      const name = rawPart.functionCall.name;
      const id = rawPart.functionCall.id;
      if (typeof name !== "string" || typeof id !== "string" || !name || !id || seen.has(id)) continue;
      seen.add(id);
      refs.push({ name, id });
    }
  }
  return refs;
}

function nativeOptionsForAttempt(routing: GenerationRouting | undefined, accountId?: string): NativeGenerationOptions | undefined {
  if (!routing) return undefined;
  const sameAccount = routing.preferredAccountId === undefined || routing.preferredAccountId === accountId;
  const previousResponseId = sameAccount
    ? routing.previousResponseId ?? (routing.clearPreviousResponseId ? null : undefined)
    : routing.clearPreviousResponseId ? null : undefined;
  if (previousResponseId === undefined && !routing.onResponseId) return undefined;
  return {
    ...(previousResponseId !== undefined ? { previousResponseId } : {}),
    ...(routing.onResponseId ? { onResponseId: routing.onResponseId } : {}),
  };
}


/** 只重试明显属于上游/浏览器的瞬时故障；请求参数类 4xx 不重试。 */
function isRetryableGatewayError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error);
  if (isRecord(error) && error.retryable === true) return true;
  return /HTTP 5\d\d|fetch failed|network|timed? out|timeout|target closed|page closed|context closed|browser.*closed|candidate chunk|empty candidate/iu.test(message);
}

function authSnapshot(result: AuthRefreshResult): AccountAuthSnapshot {
  const now = new Date().toISOString();
  return {
    state: result.status,
    ...(result.cookie?.checkedAt ? { cookieCheckedAt: result.cookie.checkedAt } : {}),
    ...(result.status === "refreshed" || result.status === "still_healthy" ? { cookieSavedAt: now } : {}),
    ...(result.cookie?.earliestExpiry ? { earliestCookieExpiry: result.cookie.earliestExpiry } : {}),
    lastRefreshAt: now,
    lastRefreshError: result.status === "refresh_failed" ? result.message ?? "Unknown refresh failure" : null,
    reauthUrl: result.status === "reauth_required" || result.status === "challenge_required" ? result.pageUrl : null,
  };
}


export interface NativeGatewayBackend {
  warmup(): Promise<void>;
  refreshAuth?(): Promise<AuthRefreshResult>;
  close(): Promise<void>;
  switchAuth(authFile: string): Promise<void>;
  models(): Promise<Record<string, unknown>[]>;
  countTokens(model: string, body: unknown): Promise<Record<string, unknown>>;
  generate(
    model: string,
    body: unknown,
    signal?: AbortSignal,
    options?: NativeGenerationOptions,
  ): Promise<Record<string, unknown>>;
  generateStream(
    model: string,
    body: unknown,
    onResponse: (response: Record<string, unknown>) => void,
    signal?: AbortSignal,
    options?: NativeGenerationOptions,
  ): Promise<Record<string, unknown>>;
  inspectAccountProfile?(): Promise<AccountProfile>;
}

export class NativeBackendBridge implements BackendBridge {
  private running = false;
  private readonly activatedLoginSessions = new Set<string>();
  /** accountId -> gateway，按最近使用排序（Map 迭代序即 LRU 序：最旧的在前）。 */
  private readonly accountGateways = new Map<string, NativeGatewayBackend>();
  /** 正在处理请求的 gateway 计数，淘汰时跳过忙的。 */
  private readonly gatewayBusy = new Map<string, number>();
  /** 每个 gateway 的最后使用时间，用于淘汰宽限期判断。 */
  private readonly gatewayLastUsed = new Map<string, number>();
  /** 401/403 授权过期：请求收尾后必须关掉浏览器，等待重新登录。 */
  private readonly gatewayPendingClose = new Set<string>();
  /** 429/普通上游错误：不立即关闭，超出双温热池时优先淘汰。 */
  private readonly gatewayEvictPriority = new Set<string>();
  private readonly gatewayMutex = new AsyncMutex();
  private readonly rotator: AccountRotator;
  /** 相同 key 的在途上游请求：相同请求并发到达时共享同一个 Promise，不再重复发上游。 */
  private readonly inflightGenerations = new Map<string, Promise<Record<string, unknown>>>();
  private dedupHitCount = 0;

  constructor(
    private readonly gateway: NativeGatewayBackend = new NativeGateway(),
    private readonly accounts = new AccountStore(),
    private readonly stats = new StatsStore(),
    private readonly login: LoginSessionBackend = new LoginSessionManager(accounts),
    private readonly gatewayFactory: (authFile: string) => NativeGatewayBackend = (authFile) => new NativeGateway(new NativeBrowserSession(authFile)),
    private readonly responseCache: ResponseCacheBackend = new SqliteResponseCache({
      enabled: settings.responseCacheEnabled,
      mode: settings.responseCacheMode,
      ttlSeconds: settings.responseCacheTtlSeconds,
      maxBytes: settings.responseCacheMaxBytes,
      maxEntryBytes: settings.responseCacheMaxEntryBytes,
      file: settings.responseCacheFile,
    }),
    private readonly requestLogs = new RequestLogStore(settings.requestLogFile, settings.requestLogMaxEntries),
    private readonly continuations = new NativeContinuationStore(),
  ) {
    this.rotator = new AccountRotator(this.accounts, settings.accountRotationMode, settings.accountCooldownSeconds, settings.accountAuthCooldownSeconds);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const savedRotation = await this.accounts.rotationConfig();
    if (savedRotation && ["round_robin", "lru", "least_rl"].includes(savedRotation.mode) && Number.isFinite(savedRotation.cooldown_seconds)) {
      this.rotator.setConfig(savedRotation.mode as RotationMode, Math.max(0, savedRotation.cooldown_seconds));
    }
    this.rotator.setDenied(await this.accounts.deniedModels());
    const active = await this.accounts.active();
    if (active) {
      const all = await this.accounts.list();
      const warmIds = [active.id, ...all.map((account) => account.id).filter((id) => id !== active.id)]
        .slice(0, Math.max(1, settings.browserMaxAliveInstances || 1));
      // 双温热池并行预热；单个账号失败不阻塞服务启动，实际请求仍会按轮询器故障转移。
      void Promise.allSettled(warmIds.map((id) => this.withGatewayBusy(id, (gateway) => gateway.warmup())));
    } else {
      void this.gateway.warmup().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    this.continuations.clear();
    this.running = false;
    await this.login.stop();
    const gateways = [...new Set([this.gateway, ...this.accountGateways.values()])];
    await Promise.allSettled(gateways.map(gateway => gateway.close()));
    // 关闭 SQLite 句柄，避免进程退出时文件被占用（Windows 上阻碍临时目录清理）
    this.requestLogs.close();
    const cache = this.responseCache as { close?: () => void };
    cache.close?.();
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
    else if (method === "stats") result = { ...(await this.stats.snapshot()), cache: { ...this.responseCache.stats(), dedupedHits: this.dedupHitCount }, browsers_alive: this.accountGateways.size };
    else if (method === "request_logs") result = this.requestLogs.list(
      Math.max(1, Math.min(500, Number(params.limit) || 100)),
      params.before_id ? Number(params.before_id) : undefined,
    );
    else if (method === "models") {
      const active = await this.accounts.active();
      const nativeModels = active ? await this.withGatewayBusy(active.id, (gateway) => gateway.models()) : await this.gateway.models();
      result = filterSupportedModelCatalog(nativeModels);
    }
    else if (method === "countTokens") {
      const model = String(params.model ?? "");
      if (!model) throw new BridgeError(400, { message: "model 不能为空", type: "invalid_request_error" });
      const active = await this.accounts.active();
      result = active
        ? await this.withGatewayBusy(active.id, (gateway) => gateway.countTokens(model, params.body))
        : await this.gateway.countTokens(model, params.body);
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
      await this.withGatewayBusy(id, (gateway) => gateway.warmup());
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
      this.continuations.removeAccount(id);
      const gateway = this.accountGateways.get(id);
      if (gateway) {
        await gateway.close().catch(() => undefined);
        this.accountGateways.delete(id);
        this.gatewayLastUsed.delete(id);
      }
      void this.rotator.removeAccount(id);
      if (!await this.accounts.delete(id)) throw new BridgeError(404, "账号不存在");
      result = { ok: true };
    } else if (method === "accounts_refresh") {
      const id = String(params.account_id ?? "");
      const account = await this.refreshAccountProfile(id);
      result = account;
    } else if (method === "accounts_refresh_auth") {
      const id = String(params.account_id ?? "");
      if (!(await this.accounts.list()).some(account => account.id === id)) throw new BridgeError(404, "账号不存在");
      await this.accounts.updateAuthState(id, { state: "refreshing", lastRefreshError: null });
      result = await this.withGatewayBusy(id, async (gateway) => {
        if (!gateway.refreshAuth) throw new BridgeError(501, "当前网关不支持主动登录续活");
        const refreshed = await gateway.refreshAuth();
        await this.accounts.updateAuthState(id, authSnapshot(refreshed));
        if (refreshed.status === "refreshed" || refreshed.status === "still_healthy") await this.rotator.resetAccount(id);
        return refreshed;
      });
    } else if (method === "import_cookies") {
      try {
        const imported = await this.accounts.importCookies({ ...params });
        this.continuations.removeAccount(imported.account.id);
        const oldGateway = this.accountGateways.get(imported.account.id);
        if (oldGateway) {
          await oldGateway.close().catch(() => undefined);
          this.accountGateways.delete(imported.account.id);
          this.gatewayLastUsed.delete(imported.account.id);
        }
        // 新 Cookie 生效，解除该账号的授权过期冷却
        void this.rotator.resetAccount(imported.account.id);
        if ((await this.accounts.active())?.id === imported.account.id) {
          await this.withGatewayBusy(imported.account.id, (gateway) => gateway.warmup());
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
      await this.withGatewayBusy(next.id, (gateway) => gateway.warmup());
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
        const authFile = this.accounts.authPath(session.account_id);
        if (authFile) {
          this.continuations.removeAccount(session.account_id);
          await this.accounts.activate(session.account_id);
          // 重新登录成功，解除该账号的授权过期冷却
          void this.rotator.resetAccount(session.account_id);
          void this.withGatewayBusy(session.account_id, async (gateway) => {
            await gateway.switchAuth(authFile);
            await gateway.warmup();
          }).catch(() => undefined);
        }
        this.activatedLoginSessions.add(sessionId);
      }
      result = session;
    } else if (method === "login_screenshot") {
      const screenshot = await this.login.screenshot(String(params.session_id ?? ""));
      if (screenshot === "missing") throw new BridgeError(404, { message: "登录会话不存在", type: "not_found" });
      if (screenshot === "not_ready") throw new BridgeError(409, { message: "登录页面尚未准备好", type: "not_ready" });
      result = screenshot;
    } else if (method === "login_click") {
      const clicked = await this.login.click(String(params.session_id ?? ""), Number(params.x), Number(params.y));
      if (clicked === "missing") throw new BridgeError(404, { message: "登录会话不存在", type: "not_found" });
      if (clicked === "not_ready") throw new BridgeError(409, { message: "登录页面尚未准备好或坐标无效", type: "not_ready" });
      result = { ok: true };
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
      const functionResponses = settings.privateContinuationEnabled ? functionResponseRefs(params.body) : [];
      const continuation = functionResponses.length > 0
        ? this.continuations.find(model, functionResponses)
        : undefined;
      let upstreamResponseId: string | undefined;
      const routing: GenerationRouting | undefined = settings.privateContinuationEnabled ? {
        ...(continuation?.accountId ? { preferredAccountId: continuation.accountId } : {}),
        ...(continuation ? { previousResponseId: continuation.responseId } : {}),
        ...(functionResponses.length > 0 ? { clearPreviousResponseId: true } : {}),
        onResponseId: (responseId: string) => { upstreamResponseId = responseId; },
      } : undefined;
      const trace: RequestTrace = { kind: "generate", model, startedAt: performance.now(), cache: "miss", attempts: 0 };
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
          trace,
          routing,
        );
        if (settings.privateContinuationEnabled) {
          if (continuation) this.continuations.consume(model, functionResponses);
          const calls = functionCallRefs(response);
          if (upstreamResponseId && calls.length > 0) {
            this.continuations.remember(model, calls, upstreamResponseId, trace.account);
          }
        }
        const usage = !this.responseCache.wasHit(response) && isRecord(response.usageMetadata) ? response.usageMetadata : undefined;
        await this.stats.record(model, "success", usage);
        this.logRequest(trace, "success", response);
      } catch (error) {
        // rate_limited is already counted per failed attempt by onRateLimited.
        if (!isRateLimitedError(error)) await this.stats.record(model, "errors");
        this.logRequest(trace, isRateLimitedError(error) ? "rate_limited" : "error", undefined, error);
        throw error;
      }
      // Gemini SSE 协议没有 [DONE] 结束标记；发送它会让客户端（如 pi 的
      // google-generative-ai 适配器）把 "[DONE]" 当 JSON 解析而报错，流自然结束即可。
      result = response;
    } else {
      throw new BridgeError(501, { message: `${method} is not migrated to the native TypeScript gateway yet`, type: "not_implemented" });
    }
    return result as T;
  }

  private async gatewayForAccount(accountId: string): Promise<NativeGatewayBackend> {
    const existing = this.accountGateways.get(accountId);
    if (existing) {
      this.touchGateway(accountId);
      return existing;
    }
    const authFile = this.accounts.authPath(accountId);
    if (!authFile) throw new BridgeError(404, "账号不存在或 auth.json 缺失");
    return this.gatewayMutex.run(async () => {
      const cached = this.accountGateways.get(accountId);
      if (cached) {
        this.touchGateway(accountId);
        return cached;
      }
      const gateway = this.gatewayFactory(authFile);
      this.accountGateways.set(accountId, gateway);
      this.gatewayLastUsed.set(accountId, Date.now());
      this.evictOverflowGateways(accountId);
      return gateway;
    });
  }

  /** 管理操作（warmup/models/资料刷新等）也走 busy 计数，避免被 LRU 淘汰中途杀进程。 */
  private async withGatewayBusy<T>(accountId: string, fn: (gateway: NativeGatewayBackend) => Promise<T>): Promise<T> {
    this.gatewayBusy.set(accountId, (this.gatewayBusy.get(accountId) ?? 0) + 1);
    try {
      const gateway = await this.gatewayForAccount(accountId);
      return await fn(gateway);
    } finally {
      this.releaseGateway(accountId);
    }
  }

  private releaseGateway(accountId: string): void {
    const busy = (this.gatewayBusy.get(accountId) ?? 1) - 1;
    if (busy <= 0) {
      this.gatewayBusy.delete(accountId);
      // 该账号已无在途请求：若被标记为待关闭（限流/授权过期），现在关
      if (this.gatewayPendingClose.delete(accountId)) this.closeAccountGateway(accountId);
    } else {
      this.gatewayBusy.set(accountId, busy);
    }
  }

  /** 刷新 LRU 序：把刚用到的移到 Map 末尾，并记录最后使用时间。 */
  private touchGateway(accountId: string): void {
    const gateway = this.accountGateways.get(accountId);
    if (!gateway) return;
    this.accountGateways.delete(accountId);
    this.accountGateways.set(accountId, gateway);
    this.gatewayLastUsed.set(accountId, Date.now());
  }

  /**
   * 超过保活上限时关掉最久未用的实例（每个实例约 500MB 内存），但有两重保护：
   * 正在处理请求的不关；空闲未超过宽限期（browserEvictGraceMs）的不关——
   * 避免高频轮询时每个请求都冷启动。宽限期内超出的实例会留到下一轮再淘汰。
   */
  private evictOverflowGateways(keepId: string): void {
    const cap = settings.browserMaxAliveInstances;
    if (cap <= 0) return; // 0 = 不限制
    const now = Date.now();
    while (this.accountGateways.size > cap) {
      const ids = [...this.accountGateways.keys()];
      const idleCandidate = (id: string): boolean => id !== keepId && (this.gatewayBusy.get(id) ?? 0) === 0;
      // 限流/报错实例已不健康：不受宽限期保护，扩容时优先换掉它。
      const priorityVictim = ids.find((id) => idleCandidate(id) && this.gatewayEvictPriority.has(id));
      const victimId = priorityVictim ?? ids.find(
        (id) => idleCandidate(id)
          && now - (this.gatewayLastUsed.get(id) ?? 0) >= settings.browserEvictGraceMs,
      );
      if (!victimId) break; // 其余都在忙或还在宽限期内，暂时允许短时溢出
      this.closeAccountGateway(victimId);
    }
  }

  /** 请求结束落一条明细日志（类似 new-api 的日志记录）；日志失败不影响请求本身。 */
  private logRequest(trace: RequestTrace, status: RequestLogStatus, response?: Record<string, unknown>, error?: unknown): void {
    try {
      // 命中/去重的响应也带 usageMetadata：记入日志仅供展示参考；用量统计仍会跳过它（避免重复计上游消耗）。
      const usage = response && isRecord(response.usageMetadata) ? response.usageMetadata : undefined;
      const num = (value: unknown): number => Number(value) || 0;
      const detailMessage = error instanceof BridgeError && isRecord(error.detail) && typeof error.detail.message === "string"
        ? error.detail.message
        : undefined;
      const errorMessage = error
        ? detailMessage ?? String(error instanceof Error ? error.message : error)
        : undefined;
      this.requestLogs.record({
        created_at: Date.now(),
        kind: trace.kind,
        model: trace.model,
        account: trace.account,
        status,
        latency_ms: Math.round(performance.now() - trace.startedAt),
        prompt_tokens: num(usage?.promptTokenCount ?? usage?.total_input_tokens ?? usage?.prompt_tokens),
        completion_tokens: num(usage?.candidatesTokenCount ?? usage?.completion_tokens) + num(usage?.thoughtsTokenCount ?? usage?.total_thought_tokens),
        total_tokens: num(usage?.totalTokenCount ?? usage?.total_tokens),
        cache: trace.cache,
        attempts: trace.attempts,
        error: errorMessage ? errorMessage.slice(0, 500) : undefined,
      });
    } catch {
      // 日志存储故障不应影响 API 请求
    }
  }

  /** 关闭并从登记表移除某账号的浏览器实例（若存在）。 */
  private closeAccountGateway(accountId: string): void {
    this.continuations.removeAccount(accountId);
    const gateway = this.accountGateways.get(accountId);
    if (!gateway) return;
    this.accountGateways.delete(accountId);
    this.gatewayLastUsed.delete(accountId);
    this.gatewayEvictPriority.delete(accountId);
    this.gatewayPendingClose.delete(accountId);
    void gateway.close().catch(() => undefined);
  }

  /** 403 可能来自损坏的 proof/runtime；确认前必须等待旧浏览器完全退出，避免 profile 锁冲突。 */
  private async rebuildAccountGateway(accountId: string): Promise<NativeGatewayBackend> {
    this.continuations.removeAccount(accountId);
    const gateway = this.accountGateways.get(accountId);
    this.accountGateways.delete(accountId);
    this.gatewayLastUsed.delete(accountId);
    this.gatewayEvictPriority.delete(accountId);
    this.gatewayPendingClose.delete(accountId);
    if (gateway) await gateway.close().catch(() => undefined);
    return this.gatewayForAccount(accountId);
  }

  private async refreshAccountProfile(accountId: string): Promise<unknown> {
    const account = (await this.accounts.list()).find(item => item.id === accountId);
    if (!account) throw new BridgeError(404, "账号不存在");
    return this.withGatewayBusy(accountId, async (gateway) => {
      if (!gateway.inspectAccountProfile) {
        throw new BridgeError(501, "当前网关不支持账号资料读取");
      }
      try {
        const profile = await gateway.inspectAccountProfile();
        const updated = await this.accounts.updateProfile(accountId, profile);
        if (!updated) throw new Error("账号在资料刷新期间被删除");
        // 能读到资料说明授权有效，解除授权过期冷却
        void this.rotator.resetAccount(accountId);
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
    });
  }

  private async generateWithRotation(
    model: string,
    body: unknown,
    onChunk?: (chunk: Record<string, unknown>) => void,
    signal?: AbortSignal,
    onRateLimited?: () => Promise<void>,
    trace?: RequestTrace,
    routing?: GenerationRouting,
  ): Promise<Record<string, unknown>> {
    const cacheKey = this.responseCache.key(model, body);
    if (cacheKey) {
      const cached = this.responseCache.get(cacheKey);
      if (cached) {
        if (trace) trace.cache = "hit";
        onChunk?.(cached);
        return cached;
      }
      const pending = this.inflightGenerations.get(cacheKey);
      if (pending) {
        // 完全相同的请求正在上游执行：共享它的结果而不是再发一次。
        // 后加入者拿不到逐块流式进度，直接收完整响应（等同一次缓存命中）。
        this.dedupHitCount += 1;
        if (trace) trace.cache = "dedup";
        // 克隆后再标记为命中：首发那份仍要正常记上游用量，后加入者不重复记。
        const response = structuredClone(await pending);
        this.responseCache.markHit(response);
        onChunk?.(response);
        return response;
      }
    } else if (trace) {
      // 带 tools 或超限的请求不参与缓存
      trace.cache = "bypass";
    }
    const upstream = this.generateUpstream(model, body, onChunk, signal, onRateLimited, cacheKey, trace, routing);
    if (!cacheKey) return upstream;
    this.inflightGenerations.set(cacheKey, upstream);
    try {
      return await upstream;
    } finally {
      this.inflightGenerations.delete(cacheKey);
    }
  }

  private async generateUpstream(
    model: string,
    body: unknown,
    onChunk: ((chunk: Record<string, unknown>) => void) | undefined,
    signal: AbortSignal | undefined,
    onRateLimited: (() => Promise<void>) | undefined,
    cacheKey: string | undefined,
    trace?: RequestTrace,
    routing?: GenerationRouting,
  ): Promise<Record<string, unknown>> {
    if (trace) trace.attempts += 1;
    const all = await this.accounts.list();
    if (all.length === 0) {
      const options = nativeOptionsForAttempt(routing);
      const response = onChunk
        ? await this.gateway.generateStream(model, body, onChunk, signal, options)
        : await this.gateway.generate(model, body, signal, options);
      if (cacheKey) this.responseCache.set(cacheKey, response);
      return response;
    }
    const maxAttempts = Math.min(Math.max(1, settings.accountMaxRetries), all.length);
    const attempted = new Set<string>();
    const preferredAccount = routing?.preferredAccountId
      ? all.find(account => account.id === routing.preferredAccountId)
      : undefined;
    let lastError: unknown;
    let rateLimitedAttempts = 0;
    let lastQuotaInfo: UpstreamQuotaInfo | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
      const account = attempt === 0 && preferredAccount
        ? preferredAccount
        : await this.rotator.getNextAccount(signal, new Set(this.accountGateways.keys()), attempted, model);
      if (!account) {
        // 全部账号都因 403 Code 7 被该模型拒绝时，给出可操作的错误而不是泛泛的“无可用账号”。
        if (all.length > 0 && all.every(item => this.rotator.isDenied(item.id, model))) {
          throw lastError ?? new Error(`所有账号对模型 ${model} 均无权限（HTTP 403），请重新登录账号或更换模型`);
        }
        break;
      }
      if (attempted.has(account.id)) {
        attempt -= 1;
        if (attempted.size >= all.length) break;
        continue;
      }
      attempted.add(account.id);
      if (trace) trace.account = account.id;
      let emitted = false;
      const attemptStartedAt = performance.now();
      this.gatewayBusy.set(account.id, (this.gatewayBusy.get(account.id) ?? 0) + 1);
      try {
        const gateway = await this.gatewayForAccount(account.id);
        // activate() is a disk write; skip it when the account is already active.
        const active = await this.accounts.active();
        if (active?.id !== account.id) await this.accounts.activate(account.id);
        const options = nativeOptionsForAttempt(routing, account.id);
        const response = onChunk
          ? await gateway.generateStream(model, body, chunk => { emitted = true; onChunk(chunk); }, signal, options)
          : await gateway.generate(model, body, signal, options);
        this.rotator.recordSuccess(account.id, performance.now() - attemptStartedAt);
        this.gatewayEvictPriority.delete(account.id);
        if (cacheKey) this.responseCache.set(cacheKey, response);
        return response;
      } catch (error) {
        lastError = error;
        if (isRateLimitedError(error)) {
          rateLimitedAttempts += 1;
          lastQuotaInfo = readUpstreamQuotaInfo(error) ?? lastQuotaInfo;
          this.rotator.recordRateLimited(account.id);
          // 429 是账号频率问题，不重建浏览器；进入冷却，并在以后扩容时优先淘汰。
          this.gatewayEvictPriority.add(account.id);
          if (onRateLimited) await onRateLimited().catch(() => undefined);
          if (!emitted && attempt + 1 < maxAttempts) continue;
          if (!emitted) break;
        } else if (isAuthExpiredError(error)) {
          // 有现存浏览器页面时，先通过真实 ServiceLogin 主动续活；成功后固定同账号重试一次。
          if (!emitted) {
            await this.accounts.updateAuthState(account.id, { state: "refreshing", lastRefreshError: null });
            const refreshGateway = await this.gatewayForAccount(account.id);
            if (refreshGateway.refreshAuth) {
              const refreshed = await refreshGateway.refreshAuth();
              await this.accounts.updateAuthState(account.id, authSnapshot(refreshed));
              if (refreshed.status === "refreshed" || refreshed.status === "still_healthy") {
                let retryEmitted = false;
                try {
                  if (trace) trace.attempts += 1;
                  const options = nativeOptionsForAttempt(routing, account.id);
                  const response = onChunk
                    ? await refreshGateway.generateStream(model, body, chunk => { retryEmitted = true; onChunk(chunk); }, signal, options)
                    : await refreshGateway.generate(model, body, signal, options);
                  await this.rotator.resetAccount(account.id);
                  this.rotator.recordSuccess(account.id, performance.now() - attemptStartedAt);
                  if (cacheKey) this.responseCache.set(cacheKey, response);
                  return response;
                } catch (retryError) {
                  lastError = retryError;
                  if (retryEmitted || !isAuthExpiredError(retryError)) throw retryError;
                }
              }
            }
          }
          this.rotator.recordAuthExpired(account.id);
          this.gatewayPendingClose.add(account.id);
          if (!emitted && attempt + 1 < maxAttempts) continue;
        } else if (isPermissionDeniedError(error)) {
          // 首次 403 不足以证明账号缺少模型权限：proof、动态头或页面 runtime 损坏也会返回同样的 Code 7。
          // 未向客户端发出流数据时，销毁浏览器并固定同账号确认一次；只有第二次仍为 403 才持久化 denied。
          if (!emitted) {
            let confirmationEmitted = false;
            try {
              if (trace) trace.attempts += 1;
              const rebuilt = await this.rebuildAccountGateway(account.id);
              const options = nativeOptionsForAttempt(routing, account.id);
              const response = onChunk
                ? await rebuilt.generateStream(model, body, chunk => { confirmationEmitted = true; onChunk(chunk); }, signal, options)
                : await rebuilt.generate(model, body, signal, options);
              this.rotator.recordSuccess(account.id, performance.now() - attemptStartedAt);
              if (cacheKey) this.responseCache.set(cacheKey, response);
              return response;
            } catch (confirmationError) {
              lastError = confirmationError;
              if (confirmationEmitted || !isPermissionDeniedError(confirmationError)) throw confirmationError;
            }
          }
          await this.rotator.recordDenied(account.id, model);
          if (!emitted && attempt + 1 < maxAttempts) continue;
          throw lastError;
        } else {
          this.rotator.recordError(account.id);
          if (isRetryableGatewayError(error)) {
            // 5xx/网络/浏览器故障：当前会话不可信，收尾后关闭并无缝切温热备用实例。
            this.gatewayPendingClose.add(account.id);
            if (!emitted && attempt + 1 < maxAttempts) continue;
          }
        }
        throw error;
      } finally {
        this.releaseGateway(account.id);
      }
    }
    if (lastError && rateLimitedAttempts > 0 && rateLimitedAttempts === attempted.size) {
      const scope = attempted.size === all.length
        ? `all ${all.length} configured accounts`
        : `all ${attempted.size} attempted accounts`;
      const retryAfterSeconds = lastQuotaInfo?.retryAfterMs !== undefined
        ? Math.ceil(lastQuotaInfo.retryAfterMs / 1000)
        : undefined;
      const message = `AI Studio quota unavailable: ${scope} returned rate-limit responses for ${model}.`
        + (retryAfterSeconds !== undefined
          ? ` Retry after approximately ${retryAfterSeconds} seconds.`
          : " Wait for quota reset or add an account with available quota.");
      throw new BridgeError(429, {
        message,
        type: "rate_limit_error",
        ...(lastQuotaInfo ? {
          quota_reason: lastQuotaInfo.reason,
          ...(lastQuotaInfo.retryAfterMs !== undefined ? { retry_after_ms: lastQuotaInfo.retryAfterMs } : {}),
          ...(lastQuotaInfo.quotaMetric ? { quota_metric: lastQuotaInfo.quotaMetric } : {}),
          ...(lastQuotaInfo.quotaId ? { quota_id: lastQuotaInfo.quotaId } : {}),
        } : {}),
      });
    }
    throw lastError ?? new Error("没有可用的 Google 账号");
  }
}
