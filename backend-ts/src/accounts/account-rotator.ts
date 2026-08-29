import { setTimeout as delay } from "node:timers/promises";
import type { AccountMeta, AccountStore } from "./account-store.js";
import { AsyncMutex } from "../storage/atomic-json.js";

export type RotationMode = "round_robin" | "lru" | "least_rl";

interface AccountRuntimeStats {
  requests: number;
  success: number;
  rate_limited: number;
  errors: number;
  auth_expired: number;
  in_flight: number;
  latency_ewma_ms: number;
  last_used: number;
  last_rate_limited: number;
  last_auth_expired: number;
  // 授权过期冷却独立于限流冷却，前端据此区分两种状态
  auth_cooldown_until: number;
  cooldown_until: number;
}

export interface AccountRotationView {
  requests: number;
  success: number;
  rate_limited: number;
  errors: number;
  auth_expired: number;
  in_flight: number;
  latency_ewma_ms: number | null;
  error_rate: number;
  last_used: string | null;
  last_rate_limited: string | null;
  last_auth_expired: string | null;
  auth_expired_active: boolean;
  is_available: boolean;
  cooldown_remaining: number;
  denied_models: string[];
}

function emptyStats(): AccountRuntimeStats {
  return {
    requests: 0,
    success: 0,
    rate_limited: 0,
    errors: 0,
    auth_expired: 0,
    in_flight: 0,
    latency_ewma_ms: 0,
    last_used: 0,
    last_rate_limited: 0,
    last_auth_expired: 0,
    auth_cooldown_until: 0,
    cooldown_until: 0,
  };
}

function isoOrNull(value: number): string | null {
  return value > 0 ? new Date(value).toISOString() : null;
}

export function isRateLimitedError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return /(?:\b429\b|too many requests|rate[ -]?limit|resource exhausted|quota exceeded|配额|限流)/u.test(message);
}

/**
 * Google 授权（Cookie）过期：浏览器被重定向到登录页。与限流不同，这种错误
 * 不会自行恢复，需要更长的冷却，直到用户重新登录或导入 Cookie。
 */
export function isAuthExpiredError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return /cookies are expired|accountchooser|servicelogin|v3\/signin|登录已过期/u.test(message);
}

/**
 * 上游明确拒绝当前 账号×模型 组合（HTTP 403 + 协议 Code 7）。与限流不同，
 * 重试不会改变结果；调用方应长效记录该组合并在调度时跳过，直到重新登录。
 */
export function isPermissionDeniedError(error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  return /\b403\b/u.test(message) && /permission|denied|forbidden/u.test(message);
}

function normalizeModelId(model: string): string {
  return model.trim().replace(/^models\//u, "").toLowerCase();
}

export class AccountRotator {
  private readonly stats = new Map<string, AccountRuntimeStats>();
  /** 账号 × 模型 的 403 Code 7 拒绝记录；重新登录或导入 Cookie 时清除。 */
  private readonly denied = new Map<string, Set<string>>();
  private readonly mutex = new AsyncMutex();
  private currentIndex = 0;
  private rotationMode: RotationMode;
  private cooldownSeconds: number;
  private readonly authCooldownSeconds: number;
  constructor(
    private readonly accounts: AccountStore,
    mode: RotationMode = "round_robin",
    cooldownSeconds = 60,
    authCooldownSeconds = 30 * 60,
  ) {
    this.rotationMode = mode;
    this.cooldownSeconds = Math.max(0, Math.floor(cooldownSeconds));
    this.authCooldownSeconds = Math.max(0, Math.floor(authCooldownSeconds));
  }

  get mode(): RotationMode {
    return this.rotationMode;
  }

  get cooldown(): number {
    return this.cooldownSeconds;
  }

  setConfig(mode: RotationMode, cooldownSeconds: number): void {
    this.rotationMode = mode;
    this.cooldownSeconds = Math.max(0, Math.floor(cooldownSeconds));
  }

  async getNextAccount(
    signal?: AbortSignal,
    preferredIds?: ReadonlySet<string>,
    excludedIds?: ReadonlySet<string>,
    model?: string,
  ): Promise<AccountMeta | undefined> {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
      const selection = await this.mutex.run(async () => this.selectAccount(preferredIds, excludedIds, model));
      if (selection.account) return selection.account;
      if (selection.waitMs <= 0) return undefined;
      // Rejects with an AbortError when the client disconnects mid-cooldown.
      await delay(selection.waitMs, undefined, { signal });
    }
  }

  async getManualNextAccount(): Promise<AccountMeta | undefined> {
    return this.mutex.run(async () => {
      const all = await this.accounts.list();
      if (all.length < 2) return undefined;
      const active = await this.accounts.active();
      const activeIndex = all.findIndex(item => item.id === active?.id);
      const index = activeIndex >= 0 ? activeIndex : Math.max(0, this.currentIndex - 1);
      const nextIndex = (index + 1) % all.length;
      this.currentIndex = (nextIndex + 1) % all.length;
      return all[nextIndex];
    });
  }

  recordSuccess(accountId: string, latencyMs?: number): void {
    const stats = this.ensureStats(accountId);
    stats.requests += 1;
    stats.success += 1;
    if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
      stats.latency_ewma_ms = stats.latency_ewma_ms > 0
        ? stats.latency_ewma_ms * 0.75 + latencyMs * 0.25
        : latencyMs;
    }
    stats.in_flight = Math.max(0, stats.in_flight - 1);
  }

  recordRateLimited(accountId: string): void {
    const now = Date.now();
    const stats = this.ensureStats(accountId);
    stats.requests += 1;
    stats.rate_limited += 1;
    stats.last_rate_limited = now;
    stats.cooldown_until = now + this.cooldownSeconds * 1000;
    stats.in_flight = Math.max(0, stats.in_flight - 1);
  }

  recordError(accountId: string): void {
    const stats = this.ensureStats(accountId);
    stats.requests += 1;
    stats.errors += 1;
    stats.in_flight = Math.max(0, stats.in_flight - 1);
  }

  recordAuthExpired(accountId: string): void {
    const now = Date.now();
    const stats = this.ensureStats(accountId);
    stats.requests += 1;
    stats.errors += 1;
    stats.auth_expired += 1;
    stats.last_auth_expired = now;
    stats.auth_cooldown_until = Math.max(stats.auth_cooldown_until, now + this.authCooldownSeconds * 1000);
    stats.in_flight = Math.max(0, stats.in_flight - 1);
  }

  isDenied(accountId: string, model: string): boolean {
    return this.denied.get(accountId)?.has(normalizeModelId(model)) ?? false;
  }

  /** 上游 403 Code 7：长效记录 账号×模型 拒绝组合，之后的调度直接跳过。 */
  async recordDenied(accountId: string, model: string): Promise<void> {
    const modelId = normalizeModelId(model);
    let models = this.denied.get(accountId);
    if (!models) {
      models = new Set();
      this.denied.set(accountId, models);
    }
    if (!models.has(modelId)) {
      models.add(modelId);
      await this.persistDenied();
    }
    const stats = this.ensureStats(accountId);
    stats.requests += 1;
    stats.errors += 1;
    stats.in_flight = Math.max(0, stats.in_flight - 1);
  }

  /** 服务启动时从磁盘恢复拒绝记录。 */
  setDenied(models: Record<string, string[]>): void {
    this.denied.clear();
    for (const [accountId, list] of Object.entries(models)) {
      const set = new Set(list.map(normalizeModelId).filter(Boolean));
      if (set.size > 0) this.denied.set(accountId, set);
    }
  }

  deniedSnapshot(): Record<string, string[]> {
    return Object.fromEntries([...this.denied.entries()].map(([id, set]) => [id, [...set].sort()]));
  }

  private async persistDenied(): Promise<void> {
    await this.accounts.saveDeniedModels(this.deniedSnapshot()).catch(() => undefined);
  }
  removeAccount(accountId: string): Promise<void> {
    this.stats.delete(accountId);
    return this.denied.delete(accountId) ? this.persistDenied() : Promise.resolve();
  }

  // 重新登录 / 导入 Cookie / 手动刷新成功后调用：立即解除授权过期冷却与模型拒绝记录。
  resetAccount(accountId: string): Promise<void> {
    this.stats.delete(accountId);
    return this.denied.delete(accountId) ? this.persistDenied() : Promise.resolve();
  }
  async getAllStats(): Promise<Record<string, AccountRotationView>> {
    const now = Date.now();
    const all = await this.accounts.list();
    const result: Record<string, AccountRotationView> = {};
    for (const account of all) {
      const stats = this.ensureStats(account.id);
      result[account.id] = {
        requests: stats.requests,
        success: stats.success,
        rate_limited: stats.rate_limited,
        errors: stats.errors,
        auth_expired: stats.auth_expired,
        in_flight: stats.in_flight,
        latency_ewma_ms: stats.latency_ewma_ms > 0 ? Math.round(stats.latency_ewma_ms) : null,
        error_rate: stats.requests > 0 ? Number((stats.errors / stats.requests).toFixed(4)) : 0,
        last_used: isoOrNull(stats.last_used),
        last_rate_limited: isoOrNull(stats.last_rate_limited),
        last_auth_expired: isoOrNull(stats.last_auth_expired),
        auth_expired_active: now < stats.auth_cooldown_until,
        is_available: now >= stats.cooldown_until && now >= stats.auth_cooldown_until,
        cooldown_remaining: Math.max(0, Math.ceil((Math.max(stats.cooldown_until, stats.auth_cooldown_until) - now) / 1000)),
        denied_models: [...(this.denied.get(account.id) ?? [])].sort(),
      };
    }
    return result;
  }

  private ensureStats(accountId: string): AccountRuntimeStats {
    let stats = this.stats.get(accountId);
    if (!stats) {
      stats = emptyStats();
      this.stats.set(accountId, stats);
    }
    return stats;
  }

  private async selectAccount(
    preferredIds?: ReadonlySet<string>,
    excludedIds?: ReadonlySet<string>,
    model?: string,
  ): Promise<{ account?: AccountMeta; waitMs: number }> {
    const all = await this.accounts.list();
    if (all.length === 0) return { waitMs: 0 };
    const notExcluded = excludedIds?.size ? all.filter((account) => !excludedIds.has(account.id)) : all;
    // 403 Code 7 的 账号×模型 组合不参与调度；该账号的其他模型不受影响。
    const eligible = model ? notExcluded.filter((account) => !this.isDenied(account.id, model)) : notExcluded;
    if (eligible.length === 0) return { waitMs: 0 };
    const now = Date.now();
    const available = eligible.filter((account) => {
      const stats = this.ensureStats(account.id);
      return now >= stats.cooldown_until && now >= stats.auth_cooldown_until;
    });
    if (available.length === 0) {
      const earliest = Math.min(...eligible.map((account) => {
        const stats = this.ensureStats(account.id);
        return Math.max(stats.cooldown_until, stats.auth_cooldown_until);
      }));
      return { waitMs: Math.max(1, earliest - now) };
    }

    // API 延迟优先：已有温热浏览器的账号只要可用，就不为了公平轮询主动冷启动新账号。
    const preferred = preferredIds?.size
      ? available.filter((account) => preferredIds.has(account.id))
      : [];
    const selected = this.pick(all, preferred.length > 0 ? preferred : available);
    if (!selected) return { waitMs: 0 };
    const stats = this.ensureStats(selected.id);
    // Reserve the account at selection time so concurrent requests do not all pick the same idle account.
    stats.in_flight += 1;
    stats.last_used = now;
    return { account: selected, waitMs: 0 };
  }

  private pick(all: AccountMeta[], available: AccountMeta[]): AccountMeta | undefined {
    if (this.rotationMode === "round_robin") {
      const availableIds = new Set(available.map(item => item.id));
      for (let offset = 0; offset < all.length; offset += 1) {
        const index = (this.currentIndex + offset) % all.length;
        const candidate = all[index];
        if (candidate && availableIds.has(candidate.id)) {
          this.currentIndex = (index + 1) % all.length;
          return candidate;
        }
      }
    }
    if (this.rotationMode === "lru") {
      return [...available].sort((left, right) => {
        const leftStats = this.ensureStats(left.id);
        const rightStats = this.ensureStats(right.id);
        return (leftStats.last_used || 0) - (rightStats.last_used || 0) || leftStats.in_flight - rightStats.in_flight;
      })[0];
    }
    return [...available].sort((left, right) => {
      const leftStats = this.ensureStats(left.id);
      const rightStats = this.ensureStats(right.id);
      const leftErrorRate = leftStats.requests > 0 ? leftStats.errors / leftStats.requests : 0;
      const rightErrorRate = rightStats.requests > 0 ? rightStats.errors / rightStats.requests : 0;
      const leftLatency = leftStats.latency_ewma_ms || 750;
      const rightLatency = rightStats.latency_ewma_ms || 750;
      return leftStats.rate_limited - rightStats.rate_limited
        || (leftStats.in_flight * 10_000 + leftErrorRate * 5_000 + leftLatency)
          - (rightStats.in_flight * 10_000 + rightErrorRate * 5_000 + rightLatency)
        || (leftStats.last_used || 0) - (rightStats.last_used || 0);
    })[0];
  }
}
