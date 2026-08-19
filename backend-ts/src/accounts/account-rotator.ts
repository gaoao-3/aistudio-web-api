import { setTimeout as delay } from "node:timers/promises";
import type { AccountMeta, AccountStore } from "./account-store.js";
import { AsyncMutex } from "../storage/atomic-json.js";

export type RotationMode = "round_robin" | "lru" | "least_rl";

interface AccountRuntimeStats {
  requests: number;
  success: number;
  rate_limited: number;
  errors: number;
  in_flight: number;
  last_used: number;
  last_rate_limited: number;
  cooldown_until: number;
}

export interface AccountRotationView {
  requests: number;
  success: number;
  rate_limited: number;
  errors: number;
  last_used: string | null;
  last_rate_limited: string | null;
  is_available: boolean;
  cooldown_remaining: number;
}

function emptyStats(): AccountRuntimeStats {
  return {
    requests: 0,
    success: 0,
    rate_limited: 0,
    errors: 0,
    in_flight: 0,
    last_used: 0,
    last_rate_limited: 0,
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

export class AccountRotator {
  private readonly stats = new Map<string, AccountRuntimeStats>();
  private readonly mutex = new AsyncMutex();
  private currentIndex = 0;
  private rotationMode: RotationMode;
  private cooldownSeconds: number;

  constructor(
    private readonly accounts: AccountStore,
    mode: RotationMode = "round_robin",
    cooldownSeconds = 60,
  ) {
    this.rotationMode = mode;
    this.cooldownSeconds = Math.max(0, Math.floor(cooldownSeconds));
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

  async getNextAccount(signal?: AbortSignal): Promise<AccountMeta | undefined> {
    for (;;) {
      if (signal?.aborted) throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
      const selection = await this.mutex.run(async () => this.selectAccount());
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

  recordSuccess(accountId: string): void {
    const stats = this.ensureStats(accountId);
    stats.requests += 1;
    stats.success += 1;
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

  removeAccount(accountId: string): void {
    this.stats.delete(accountId);
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
        last_used: isoOrNull(stats.last_used),
        last_rate_limited: isoOrNull(stats.last_rate_limited),
        is_available: now >= stats.cooldown_until,
        cooldown_remaining: Math.max(0, Math.ceil((stats.cooldown_until - now) / 1000)),
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

  private async selectAccount(): Promise<{ account?: AccountMeta; waitMs: number }> {
    const all = await this.accounts.list();
    if (all.length === 0) return { waitMs: 0 };
    const now = Date.now();
    const available = all.filter(account => now >= this.ensureStats(account.id).cooldown_until);
    if (available.length === 0) {
      const earliest = Math.min(...all.map(account => this.ensureStats(account.id).cooldown_until));
      return { waitMs: Math.max(1, earliest - now) };
    }

    const selected = this.pick(all, available);
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
      return leftStats.rate_limited - rightStats.rate_limited
        || leftStats.in_flight - rightStats.in_flight
        || (leftStats.last_used || 0) - (rightStats.last_used || 0);
    })[0];
  }
}
