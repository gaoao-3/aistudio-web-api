import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

function findProjectRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "backend-ts")) && existsSync(join(current, "frontend"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Unable to locate project root from ${start}`);
    current = parent;
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(process.env.AISTUDIO_PROJECT_ROOT ?? findProjectRoot(moduleDir));
export const runtimeRoot = resolve(process.env.AISTUDIO_RUNTIME_ROOT ?? projectRoot);
dotenv.config({ path: join(runtimeRoot, ".env"), quiet: true });

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return !["0", "false", "no", "off"].includes(raw);
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function envKeys(): Set<string> {
  const keys = new Set<string>();
  for (const name of ["AISTUDIO_API_KEY", "AISTUDIO_API_KEYS"]) {
    for (const value of (process.env[name] ?? "").split(/[\n,]/u)) {
      const key = value.trim();
      if (key) keys.add(key);
    }
  }
  return keys;
}

function rotationModeEnv(): "round_robin" | "lru" | "least_rl" {
  const value = process.env.AISTUDIO_ACCOUNT_ROTATION_MODE?.trim();
  return value === "lru" || value === "least_rl" ? value : "round_robin";
}
function responseCacheModeEnv(): "off" | "deterministic" | "exact" {
  const value = process.env.AISTUDIO_RESPONSE_CACHE_MODE?.trim().toLowerCase();
  return value === "off" || value === "exact" ? value : "deterministic";
}

export const settings = {
  host: process.env.AISTUDIO_HOST ?? "0.0.0.0",
  port: intEnv("AISTUDIO_PORT", 3006),
  browserHeadless: boolEnv("AISTUDIO_BROWSER_HEADLESS", true),
  // API 服务优先保证首包延迟：温热池实例常驻，由 browserMaxAliveInstances 控制内存。0 = 不自动空闲关闭。
  browserIdleTimeoutMs: Math.max(0, intEnv("AISTUDIO_BROWSER_IDLE_TIMEOUT_MS", 0)),
  // 同时保活的账号浏览器实例数上限（LRU 淘汰最久未用的）；0 = 不限制。每个实例约 500MB 内存。
  browserMaxAliveInstances: Math.max(0, intEnv("AISTUDIO_BROWSER_MAX_ALIVE_INSTANCES", 2)),
  // 非当前激活账号的备用浏览器空闲回收时间；仅关闭浏览器上下文，保留账号 Profile。0 = 禁用。
  browserStandbyIdleTimeoutMs: Math.max(0, intEnv("AISTUDIO_BROWSER_STANDBY_IDLE_TIMEOUT_MS", 10 * 60 * 1000)),
  // 淘汰宽限期：超上限时只关闭空闲超过该时长的实例，避免高频轮询时反复冷启动。
  browserEvictGraceMs: Math.max(0, intEnv("AISTUDIO_BROWSER_EVICT_GRACE_MS", 60 * 1000)),
  browserTimeoutMs: intEnv("AISTUDIO_BROWSER_TIMEOUT_MS", 120_000),
  // Overall watchdog for any single browser-session operation. The in-page
  // fetch timeout above cannot fire when the renderer itself freezes, and a
  // hung operation would otherwise block the session queue forever.
  browserWatchdogTimeoutMs: intEnv(
    "AISTUDIO_BROWSER_WATCHDOG_TIMEOUT_MS",
    intEnv("AISTUDIO_BROWSER_TIMEOUT_MS", 120_000) + 180_000,
  ),
  bodyLimitBytes: Math.max(1_024, intEnv("AISTUDIO_API_BODY_LIMIT_BYTES", 32 * 1024 * 1024)),
  loginTimeoutMs: intEnv("AISTUDIO_LOGIN_TIMEOUT_MS", 10 * 60 * 1000),
  loginSessionRetentionMs: intEnv("AISTUDIO_LOGIN_SESSION_RETENTION_MS", 10 * 60 * 1000),
  authFile: process.env.AISTUDIO_AUTH_FILE ? resolve(process.env.AISTUDIO_AUTH_FILE) : undefined,
  proxyUrl: optionalEnv("AISTUDIO_PROXY_URL") ?? optionalEnv("HTTPS_PROXY") ?? optionalEnv("HTTP_PROXY"),
  staticDir: join(projectRoot, "static"),
  apiKeysFile: resolve(process.env.AISTUDIO_APIKEYS_FILE ?? join(runtimeRoot, "data", "apikeys.json")),
  accountsDir: resolve(process.env.AISTUDIO_ACCOUNTS_DIR ?? join(runtimeRoot, "data", "accounts")),
  statsFile: resolve(process.env.AISTUDIO_STATS_FILE ?? join(runtimeRoot, "data", "stats.json")),
  // AI Studio requires the first response ID when submitting a function result.
  privateContinuationEnabled: boolEnv("AISTUDIO_PRIVATE_CONTINUATION", true),
  responseCacheEnabled: boolEnv("AISTUDIO_RESPONSE_CACHE_ENABLED", true),
  responseCacheMode: responseCacheModeEnv(),
  responseCacheTtlSeconds: Math.max(0, intEnv("AISTUDIO_RESPONSE_CACHE_TTL_SECONDS", 60 * 60)),
  responseCacheMaxBytes: Math.max(0, intEnv("AISTUDIO_RESPONSE_CACHE_MAX_BYTES", 32 * 1024 * 1024)),
  responseCacheMaxEntryBytes: Math.max(1_024, intEnv("AISTUDIO_RESPONSE_CACHE_MAX_ENTRY_BYTES", 1024 * 1024)),
  responseCacheFile: resolve(process.env.AISTUDIO_RESPONSE_CACHE_FILE ?? join(runtimeRoot, "data", "response-cache.sqlite")),
  requestLogFile: resolve(process.env.AISTUDIO_REQUEST_LOG_FILE ?? join(runtimeRoot, "data", "request-logs.sqlite")),
  requestLogMaxEntries: Math.max(100, intEnv("AISTUDIO_REQUEST_LOG_MAX_ENTRIES", 2000)),
  accountRotationMode: rotationModeEnv(),
  accountCooldownSeconds: Math.max(0, intEnv("AISTUDIO_ACCOUNT_COOLDOWN_SECONDS", 60)),
  // Google 授权（Cookie）过期后的账号冷却：授权不会自己恢复，默认 30 分钟，
  // 避免轮询反复撞到死号；重新登录或导入 Cookie 会立即解除。
  accountAuthCooldownSeconds: Math.max(0, intEnv("AISTUDIO_ACCOUNT_AUTH_COOLDOWN_SECONDS", 30 * 60)),
  accountMaxRetries: Math.max(1, intEnv("AISTUDIO_ACCOUNT_MAX_RETRIES", 3)),
  accountProfileRefreshMs: Math.max(60_000, intEnv("AISTUDIO_ACCOUNT_PROFILE_REFRESH_MS", 6 * 60 * 60 * 1000)),
  modelDefaultsFile: resolve(process.env.AISTUDIO_MODEL_DEFAULTS_FILE ?? join(runtimeRoot, "config.yaml")),
  configuredApiKeys: envKeys(),
};
