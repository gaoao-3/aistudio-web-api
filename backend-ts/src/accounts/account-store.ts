import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { settings } from "../config.js";
import { AsyncMutex, readJsonFile, writeJsonFile } from "../storage/atomic-json.js";
import { isGenericProfileLabel, type AccountProfile, type AccountTier, type MembershipDateKind } from "./account-profile.js";

export type AccountAuthState = "unknown" | "healthy" | "refreshing" | "refreshed" | "still_healthy" | "reauth_required" | "challenge_required" | "refresh_failed";

export interface AccountAuthSnapshot {
  readonly state: AccountAuthState;
  readonly cookieCheckedAt?: string;
  readonly cookieSavedAt?: string;
  readonly earliestCookieExpiry?: string;
  readonly lastRefreshAt?: string;
  readonly lastRefreshError?: string | null;
  readonly reauthUrl?: string | null;
}

export interface AccountMeta {
  readonly id: string;
  name: string;
  readonly email: string | null;
  nickname: string | null;
  avatar_url: string | null;
  tier: AccountTier;
  tier_label: string | null;
  membership_next_at: string | null;
  membership_next_at_kind: MembershipDateKind | null;
  profile_updated_at: string | null;
  profile_error: string | null;
  auth_state: AccountAuthState;
  cookie_checked_at: string | null;
  cookie_saved_at: string | null;
  earliest_cookie_expiry: string | null;
  last_auth_refresh_at: string | null;
  last_auth_refresh_error: string | null;
  reauth_url: string | null;
  readonly created_at: string;
  last_used: string | null;
}

export interface BrowserStorageState {
  readonly cookies: readonly Record<string, unknown>[];
  readonly origins: readonly Record<string, unknown>[];
}

export interface StoredRotationConfig {
  readonly mode: string;
  readonly cooldown_seconds: number;
}

interface Registry {
  accounts: Record<string, AccountMeta>;
  active_account_id: string | null;
}

interface CookieInput {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "None";
  readonly expires: number;
}

const AUTH_READABLE = new Set(["SID", "APISID", "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]);
const DOMAIN_OVERRIDES: Readonly<Record<string, string>> = {
  OSID: ".youtube.com",
  "__Secure-OSID": ".youtube.com",
  "__Secure-BUCKET": ".aistudio.google.com",
  OTZ: ".google.com",
  LSID: ".google.com",
};

function safeId(id: string): boolean {
  return /^acc_[A-Za-z0-9_-]+$/u.test(id);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function parseGoogleCookies(raw: string): CookieInput[] {
  const expires = Math.floor(Date.now() / 1000) + 180 * 24 * 60 * 60;
  const cookies: CookieInput[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    const name = item.slice(0, separator).trim();
    const value = item.slice(separator + 1).trim();
    if (!name || name.startsWith("__Host-")) continue;
    const domain = DOMAIN_OVERRIDES[name] ?? ".google.com";
    const key = `${name}\0${domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cookies.push({ name, value, domain, path: "/", secure: true, httpOnly: !AUTH_READABLE.has(name), sameSite: "None", expires });
  }
  return cookies;
}

export class AccountStore {
  private readonly mutex = new AsyncMutex();
  private readonly registryPath: string;
  private readonly rotationPath: string;
  private readonly deniedPath: string;

  constructor(private readonly accountsDir = settings.accountsDir) {
    this.registryPath = join(accountsDir, "registry.json");
    this.rotationPath = join(accountsDir, "rotation.json");
    this.deniedPath = join(accountsDir, "denied-models.json");
  }

  async list(): Promise<AccountMeta[]> {
    return Object.values((await this.load()).accounts);
  }

  async active(): Promise<AccountMeta | undefined> {
    const registry = await this.load();
    return registry.active_account_id ? registry.accounts[registry.active_account_id] : undefined;
  }

  async activate(id: string): Promise<AccountMeta | undefined> {
    return this.mutex.run(async () => {
      const registry = await this.load();
      const account = registry.accounts[id];
      if (!account) return undefined;
      account.last_used = new Date().toISOString();
      registry.active_account_id = id;
      await this.save(registry);
      return account;
    });
  }

  async update(id: string, name: string): Promise<AccountMeta | undefined> {
    return this.mutex.run(async () => {
      const registry = await this.load();
      const account = registry.accounts[id];
      if (!account) return undefined;
      account.name = name;
      await writeJsonFile(join(this.accountsDir, id, "meta.json"), account);
      await this.save(registry);
      return account;
    });
  }

  async updateProfile(id: string, profile: AccountProfile, error?: string): Promise<AccountMeta | undefined> {
    return this.mutex.run(async () => {
      const registry = await this.load();
      const account = registry.accounts[id];
      if (!account) return undefined;
      const existingNickname = isGenericProfileLabel(account.nickname) ? null : account.nickname;
      const next: AccountMeta = {
        ...account,
        email: profile.email ?? account.email,
        nickname: profile.nickname ?? existingNickname,
        avatar_url: profile.avatar_url ?? account.avatar_url,
        tier: profile.tier === "unknown" ? account.tier : profile.tier,
        tier_label: profile.tier_label ?? account.tier_label,
        membership_next_at: profile.membership_next_at ?? (profile.tier === "free" ? null : account.membership_next_at),
        membership_next_at_kind: profile.membership_next_at_kind ?? (profile.tier === "free" ? null : account.membership_next_at_kind),
        profile_updated_at: new Date().toISOString(),
        profile_error: error ?? null,
      };
      registry.accounts[id] = next;
      await writeJsonFile(join(this.accountsDir, id, "meta.json"), next);
      await this.save(registry);
      return next;
    });
  }

  async updateAuthState(id: string, snapshot: AccountAuthSnapshot): Promise<AccountMeta | undefined> {
    return this.mutex.run(async () => {
      const registry = await this.load();
      const account = registry.accounts[id];
      if (!account) return undefined;
      const next: AccountMeta = {
        ...account,
        auth_state: snapshot.state,
        cookie_checked_at: snapshot.cookieCheckedAt ?? account.cookie_checked_at,
        cookie_saved_at: snapshot.cookieSavedAt ?? account.cookie_saved_at,
        earliest_cookie_expiry: snapshot.earliestCookieExpiry ?? account.earliest_cookie_expiry,
        last_auth_refresh_at: snapshot.lastRefreshAt ?? account.last_auth_refresh_at,
        last_auth_refresh_error: snapshot.lastRefreshError === undefined ? account.last_auth_refresh_error : snapshot.lastRefreshError,
        reauth_url: snapshot.reauthUrl === undefined ? account.reauth_url : snapshot.reauthUrl,
      };
      registry.accounts[id] = next;
      await writeJsonFile(join(this.accountsDir, id, "meta.json"), next);
      await this.save(registry);
      return next;
    });
  }

  async delete(id: string): Promise<boolean> {
    if (!safeId(id)) return false;
    return this.mutex.run(async () => {
      const registry = await this.load();
      if (!registry.accounts[id]) return false;
      delete registry.accounts[id];
      if (registry.active_account_id === id) registry.active_account_id = Object.keys(registry.accounts)[0] ?? null;
      await this.save(registry);
      await rm(join(this.accountsDir, id), { recursive: true, force: true }).catch(() => undefined);
      return true;
    });
  }

  async importCookies(input: Record<string, unknown>): Promise<{ account: AccountMeta; cookieCount: number; authFile: string }> {
    const cookies = parseGoogleCookies(String(input.cookies ?? ""));
    if (cookies.length === 0) throw new Error("未解析到有效 cookie");
    return this.mutex.run(async () => {
      const registry = await this.load();
      const email = typeof input.email === "string" && input.email ? input.email : null;
      const requestedId = typeof input.account_id === "string" && safeId(input.account_id) ? input.account_id : undefined;
      const existing = requestedId ?? Object.values(registry.accounts).find(item => email && item.email === email)?.id;
      const id = existing ?? `acc_${randomBytes(4).toString("hex")}`;
      const old = registry.accounts[id];
      const now = new Date().toISOString();
      const account: AccountMeta = {
        id,
        name: typeof input.name === "string" && input.name ? input.name : old?.name ?? "导入的账号",
        email: email ?? old?.email ?? null,
        nickname: old?.nickname ?? null,
        avatar_url: old?.avatar_url ?? null,
        tier: old?.tier ?? "unknown",
        tier_label: old?.tier_label ?? null,
        membership_next_at: old?.membership_next_at ?? null,
        membership_next_at_kind: old?.membership_next_at_kind ?? null,
        profile_updated_at: old?.profile_updated_at ?? null,
        profile_error: null,
        auth_state: "healthy",
        cookie_checked_at: now,
        cookie_saved_at: now,
        earliest_cookie_expiry: old?.earliest_cookie_expiry ?? null,
        last_auth_refresh_at: old?.last_auth_refresh_at ?? null,
        last_auth_refresh_error: null,
        reauth_url: null,
        created_at: old?.created_at ?? now,
        last_used: now,
      };
      const authFile = join(this.accountsDir, id, "auth.json");
      await mkdir(join(this.accountsDir, id), { recursive: true });
      await writeJsonFile(authFile, { cookies, origins: [] });
      await writeJsonFile(join(this.accountsDir, id, "meta.json"), account);
      registry.accounts[id] = account;
      registry.active_account_id ??= id;
      await this.save(registry);
      return { account, cookieCount: cookies.length, authFile };
    });
  }

  async saveStorageState(input: {
    readonly name?: string;
    readonly email?: string;
    readonly storageState: BrowserStorageState;
  }): Promise<{ account: AccountMeta; authFile: string }> {
    if (!Array.isArray(input.storageState.cookies) || input.storageState.cookies.length === 0) {
      throw new Error("登录完成但没有获得 Google cookies");
    }
    return this.mutex.run(async () => {
      const registry = await this.load();
      const id = `acc_${randomBytes(4).toString("hex")}`;
      const now = new Date().toISOString();
      const email = input.email?.trim() || null;
      const existing = email ? Object.values(registry.accounts).find(item => item.email === email) : undefined;
      const accountId = existing?.id ?? id;
      const account: AccountMeta = {
        id: accountId,
        name: input.name?.trim() || existing?.name || email || "Google 账号",
        email,
        nickname: existing?.nickname ?? null,
        avatar_url: existing?.avatar_url ?? null,
        tier: existing?.tier ?? "unknown",
        tier_label: existing?.tier_label ?? null,
        membership_next_at: existing?.membership_next_at ?? null,
        membership_next_at_kind: existing?.membership_next_at_kind ?? null,
        profile_updated_at: existing?.profile_updated_at ?? null,
        profile_error: null,
        auth_state: "healthy",
        cookie_checked_at: now,
        cookie_saved_at: now,
        earliest_cookie_expiry: existing?.earliest_cookie_expiry ?? null,
        last_auth_refresh_at: existing?.last_auth_refresh_at ?? null,
        last_auth_refresh_error: null,
        reauth_url: null,
        created_at: existing?.created_at ?? now,
        last_used: now,
      };
      const directory = join(this.accountsDir, accountId);
      const authFile = join(directory, "auth.json");
      await mkdir(directory, { recursive: true });
      await writeJsonFile(authFile, input.storageState);
      await writeJsonFile(join(directory, "meta.json"), account);
      registry.accounts[accountId] = account;
      registry.active_account_id ??= accountId;
      await this.save(registry);
      return { account, authFile };
    });
  }

  authPath(id: string): string | undefined {
    return safeId(id) ? join(this.accountsDir, id, "auth.json") : undefined;
  }

  async rotationConfig(): Promise<StoredRotationConfig | undefined> {
    const value = record(await readJsonFile(this.rotationPath));
    if (!value || typeof value.mode !== "string" || typeof value.cooldown_seconds !== "number") return undefined;
    return { mode: value.mode, cooldown_seconds: value.cooldown_seconds };
  }

  async saveRotationConfig(config: StoredRotationConfig): Promise<void> {
    await writeJsonFile(this.rotationPath, config);
  }

  /** 上游 403 Code 7 的 账号×模型 拒绝记录；重新登录或导入 Cookie 后由调用方清除。 */
  async deniedModels(): Promise<Record<string, string[]>> {
    const value = record(await readJsonFile(this.deniedPath));
    if (!value) return {};
    const result: Record<string, string[]> = {};
    for (const [accountId, models] of Object.entries(value)) {
      if (!safeId(accountId) || !Array.isArray(models)) continue;
      const list = [...new Set(models.filter((item): item is string => typeof item === "string" && item.length > 0))];
      if (list.length > 0) result[accountId] = list;
    }
    return result;
  }

  async saveDeniedModels(value: Record<string, string[]>): Promise<void> {
    await writeJsonFile(this.deniedPath, value);
  }

  private async load(): Promise<Registry> {
    const value = record(await readJsonFile(this.registryPath));
    const rawAccounts = record(value?.accounts) ?? {};
    const accounts: Record<string, AccountMeta> = {};
    for (const [id, raw] of Object.entries(rawAccounts)) {
      if (!record(raw)) continue;
      const item = raw as Partial<AccountMeta>;
      const tier = item.tier === "free" || item.tier === "pro" || item.tier === "ultra" ? item.tier : "unknown";
      const membershipDateKind = item.membership_next_at_kind === "renewal" || item.membership_next_at_kind === "expiry"
        ? item.membership_next_at_kind
        : null;
      const hasMembershipSnapshot = Object.prototype.hasOwnProperty.call(item, "membership_next_at");
      accounts[id] = {
        id,
        name: typeof item.name === "string" ? item.name : id,
        email: typeof item.email === "string" ? item.email : null,
        nickname: typeof item.nickname === "string" && !isGenericProfileLabel(item.nickname) ? item.nickname : null,
        avatar_url: typeof item.avatar_url === "string" ? item.avatar_url : null,
        tier,
        tier_label: typeof item.tier_label === "string" ? item.tier_label : null,
        membership_next_at: typeof item.membership_next_at === "string" ? item.membership_next_at : null,
        membership_next_at_kind: membershipDateKind,
        // Older registries have no membership snapshot; make the UI refresh them once after upgrade.
        profile_updated_at: hasMembershipSnapshot && typeof item.profile_updated_at === "string" ? item.profile_updated_at : null,
        profile_error: typeof item.profile_error === "string" ? item.profile_error : null,
        auth_state: ["healthy", "refreshing", "refreshed", "still_healthy", "reauth_required", "challenge_required", "refresh_failed"].includes(String(item.auth_state))
          ? item.auth_state as AccountAuthState : "unknown",
        cookie_checked_at: typeof item.cookie_checked_at === "string" ? item.cookie_checked_at : null,
        cookie_saved_at: typeof item.cookie_saved_at === "string" ? item.cookie_saved_at : null,
        earliest_cookie_expiry: typeof item.earliest_cookie_expiry === "string" ? item.earliest_cookie_expiry : null,
        last_auth_refresh_at: typeof item.last_auth_refresh_at === "string" ? item.last_auth_refresh_at : null,
        last_auth_refresh_error: typeof item.last_auth_refresh_error === "string" ? item.last_auth_refresh_error : null,
        reauth_url: typeof item.reauth_url === "string" ? item.reauth_url : null,
        created_at: typeof item.created_at === "string" ? item.created_at : new Date(0).toISOString(),
        last_used: typeof item.last_used === "string" ? item.last_used : null,
      };
    }
    return {
      accounts,
      active_account_id: typeof value?.active_account_id === "string" ? value.active_account_id : null,
    };
  }

  private async save(registry: Registry): Promise<void> {
    await writeJsonFile(this.registryPath, registry);
  }
}
