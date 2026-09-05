import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runtimeRoot, settings } from "../config.js";

export const MIN_BODY_LIMIT_BYTES = 1_024;
export const MAX_BODY_LIMIT_BYTES = 128 * 1024 * 1024;

export type SettingType = "mib" | "integer" | "boolean" | "enum" | "string";
export type SettingValue = string | number | boolean;

export interface SettingOption {
  readonly value: SettingValue;
  readonly label: string;
}

export interface RuntimeSettingView {
  readonly key: string;
  readonly env: string;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly options?: ReadonlyArray<SettingOption>;
  readonly default: SettingValue;
  readonly effective: SettingValue;
  readonly configured: SettingValue | null;
  readonly sensitive?: boolean;
  readonly restart_required: boolean;
}

export interface RuntimeConfigView {
  readonly settings: ReadonlyArray<RuntimeSettingView>;
  readonly effective_body_limit_bytes: number;
  readonly configured_body_limit_bytes: number;
  readonly body_limit_max_bytes: number;
  readonly restart_required: boolean;
}

interface SettingDef {
  readonly key: string;
  readonly env: string;
  readonly label: string;
  readonly description: string;
  readonly type: SettingType;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly options?: ReadonlyArray<SettingOption>;
  readonly defaultValue: SettingValue;
  readonly sensitive?: boolean;
  readonly readEffective: () => SettingValue;
}

function mib(value: number): number {
  return Math.round((value / 1024 / 1024) * 100) / 100;
}

const SETTING_DEFS: ReadonlyArray<SettingDef> = [
  {
    key: "body_limit_bytes",
    env: "AISTUDIO_API_BODY_LIMIT_BYTES",
    label: "请求体大小上限",
    description: "单次 API 请求允许的最大体积（含图片附件），以 MiB 为单位",
    type: "mib",
    min: 1,
    max: mib(MAX_BODY_LIMIT_BYTES),
    step: 1,
    unit: "MiB",
    defaultValue: 32,
    readEffective: () => mib(settings.bodyLimitBytes),
  },
  {
    key: "browser_headless",
    env: "AISTUDIO_BROWSER_HEADLESS",
    label: "无头运行 CloakBrowser",
    description: "关闭后浏览器会显示窗口，便于调试登录流程",
    type: "boolean",
    defaultValue: true,
    readEffective: () => settings.browserHeadless,
  },
  {
    key: "browser_timeout_ms",
    env: "AISTUDIO_BROWSER_TIMEOUT_MS",
    label: "浏览器请求超时",
    description: "CloakBrowser 上游请求的最大等待时间",
    type: "integer",
    min: 1_000,
    unit: "毫秒",
    defaultValue: 120_000,
    readEffective: () => settings.browserTimeoutMs,
  },
  {
    key: "browser_watchdog_timeout_ms",
    env: "AISTUDIO_BROWSER_WATCHDOG_TIMEOUT_MS",
    label: "浏览器看门狗超时",
    description: "单个浏览器会话操作的整体超时；超时后自动重置卡死的浏览器会话，避免后续请求被永久堵塞。0 表示禁用",
    type: "integer",
    min: 0,
    unit: "毫秒",
    defaultValue: 300_000,
    readEffective: () => settings.browserWatchdogTimeoutMs,
  },
  {
    key: "browser_idle_timeout_ms",
    env: "AISTUDIO_BROWSER_IDLE_TIMEOUT_MS",
    label: "浏览器空闲关闭时间",
    description: "API 延迟优先时建议设为 0（温热实例常驻，由保活上限控制内存）；大于 0 时空闲超时会关闭，下次请求产生冷启动",
    type: "integer",
    min: 0,
    unit: "毫秒",
    defaultValue: 0,
    readEffective: () => settings.browserIdleTimeoutMs,
  },
  {
    key: "browser_max_alive_instances",
    env: "AISTUDIO_BROWSER_MAX_ALIVE_INSTANCES",
    label: "浏览器保活实例上限",
    description: "最多同时保活几个账号浏览器实例，超出时关闭最久未用的。限流/授权过期的账号实例会被立即回收。每个实例约 500MB 内存。0 表示不限制",
    type: "integer",
    min: 0,
    defaultValue: 2,
    readEffective: () => settings.browserMaxAliveInstances,
  },
  {
    key: "browser_standby_idle_timeout_ms",
    env: "AISTUDIO_BROWSER_STANDBY_IDLE_TIMEOUT_MS",
    label: "备用浏览器空闲回收时间",
    description: "非当前激活账号的备用浏览器空闲多久后关闭上下文；账号 Profile 和 Cookie 保留，下次请求会重新启动。0 表示禁用",
    type: "integer",
    min: 0,
    unit: "毫秒",
    defaultValue: 600_000,
    readEffective: () => settings.browserStandbyIdleTimeoutMs,
  },
  {
    key: "browser_evict_grace_ms",
    env: "AISTUDIO_BROWSER_EVICT_GRACE_MS",
    label: "浏览器淘汰宽限期",
    description: "超上限时只淘汰空闲超过该时长的实例；高频轮询期间实例保持温热，避免反复冷启动",
    type: "integer",
    min: 0,
    unit: "毫秒",
    defaultValue: 60_000,
    readEffective: () => settings.browserEvictGraceMs,
  },
  {
    key: "login_timeout_ms",
    env: "AISTUDIO_LOGIN_TIMEOUT_MS",
    label: "登录流程超时",
    description: "Google 登录流程的最长等待时间",
    type: "integer",
    min: 10_000,
    unit: "毫秒",
    defaultValue: 600_000,
    readEffective: () => settings.loginTimeoutMs,
  },
  {
    key: "login_session_retention_ms",
    env: "AISTUDIO_LOGIN_SESSION_RETENTION_MS",
    label: "登录会话保留时间",
    description: "已结束登录会话状态保留时长",
    type: "integer",
    min: 0,
    unit: "毫秒",
    defaultValue: 600_000,
    readEffective: () => settings.loginSessionRetentionMs,
  },
  {
    key: "account_cooldown_seconds",
    env: "AISTUDIO_ACCOUNT_COOLDOWN_SECONDS",
    label: "账号限流冷却时间",
    description: "账号遇到 429 或配额限制后的冷却秒数",
    type: "integer",
    min: 0,
    unit: "秒",
    defaultValue: 60,
    readEffective: () => settings.accountCooldownSeconds,
  },
  {
    key: "account_auth_cooldown_seconds",
    env: "AISTUDIO_ACCOUNT_AUTH_COOLDOWN_SECONDS",
    label: "账号授权过期冷却时间",
    description: "账号 Google 授权（Cookie）过期后的冷却秒数；授权不会自行恢复，冷却期内跳过该账号，重新登录或导入 Cookie 后立即恢复",
    type: "integer",
    min: 0,
    unit: "秒",
    defaultValue: 1800,
    readEffective: () => settings.accountAuthCooldownSeconds,
  },
  {
    key: "account_max_retries",
    env: "AISTUDIO_ACCOUNT_MAX_RETRIES",
    label: "单次请求最大尝试账号数",
    description: "单个请求最多尝试的账号数量",
    type: "integer",
    min: 1,
    max: 10,
    defaultValue: 3,
    readEffective: () => settings.accountMaxRetries,
  },
  {
    key: "account_profile_refresh_ms",
    env: "AISTUDIO_ACCOUNT_PROFILE_REFRESH_MS",
    label: "账号资料刷新间隔",
    description: "账号昵称、头像、会员层级资料的刷新间隔",
    type: "integer",
    min: 60_000,
    unit: "毫秒",
    defaultValue: 21_600_000,
    readEffective: () => settings.accountProfileRefreshMs,
  },
  {
    key: "response_cache_mode",
    env: "AISTUDIO_RESPONSE_CACHE_MODE",
    label: "生成响应缓存策略",
    description: "deterministic 仅缓存 temperature=0、固定 seed、无工具/函数/外部文件的请求；exact 复用所有精确请求（含工具调用——工具由客户端重新执行，副作用不入缓存；外部文件引用除外）；off 关闭缓存",
    type: "enum",
    options: [
      { value: "off", label: "关闭" },
      { value: "deterministic", label: "确定性请求（推荐）" },
      { value: "exact", label: "所有精确请求（兼容模式）" },
    ],
    defaultValue: "deterministic",
    readEffective: () => settings.responseCacheMode,
  },
  {
    key: "proxy_url",
    env: "AISTUDIO_PROXY_URL",
    label: "浏览器代理地址",
    description: "CloakBrowser 使用的代理地址，留空使用系统代理",
    type: "string",
    defaultValue: "",
    sensitive: true,
    readEffective: () => settings.proxyUrl ?? "",
  },
];

function requireNumber(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是数字`);
  }
  return value;
}

function requireInteger(name: string, value: unknown): number {
  const number = requireNumber(name, value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} 必须是整数`);
  return number;
}

function requireString(name: string, value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`${name} 必须是字符串`);
  return value;
}

/** 用户输入值（PUT 请求体）→ 写入 .env 的字符串 */
function toEnvValue(def: SettingDef, input: unknown): string {
  switch (def.type) {
    case "mib": {
      // API 契约与 .env 单位一致：body_limit_bytes 直接传字节数（前端负责 MiB→bytes 换算）
      const bytes = requireInteger(def.key, input);
      if (bytes < MIN_BODY_LIMIT_BYTES || bytes > MAX_BODY_LIMIT_BYTES) {
        throw new RangeError(`${def.label} 必须在 ${mib(MIN_BODY_LIMIT_BYTES)} 到 ${mib(MAX_BODY_LIMIT_BYTES)} MiB 之间`);
      }
      return String(bytes);
    }
    case "integer": {
      const value = requireInteger(def.key, input);
      const min = def.min ?? Number.MIN_SAFE_INTEGER;
      const max = def.max ?? Number.MAX_SAFE_INTEGER;
      if (value < min || value > max) {
        throw new RangeError(`${def.label} 必须在 ${min} 到 ${max} 之间`);
      }
      return String(value);
    }
    case "boolean": {
      if (typeof input !== "boolean") throw new TypeError(`${def.label} 必须是布尔值`);
      return input ? "1" : "0";
    }
    case "enum": {
      const value = requireString(def.key, input);
      if (!def.options?.some((option) => String(option.value) === value)) {
        throw new RangeError(`${def.label} 的取值不受支持`);
      }
      return value;
    }
    case "string":
      return JSON.stringify(requireString(def.key, input));
  }
}

/** .env 原始字符串 → 展示值（MiB / 数字 / 布尔 / 字符串） */
function parseEnvValue(def: SettingDef, raw: string | undefined): SettingValue | null {
  if (raw === undefined) return null;
  switch (def.type) {
    case "mib": {
      const bytes = Number.parseInt(raw, 10);
      return Number.isSafeInteger(bytes) ? mib(bytes) : null;
    }
    case "integer": {
      const value = Number.parseInt(raw, 10);
      return Number.isSafeInteger(value) ? value : null;
    }
    case "boolean": {
      const v = raw.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      return null;
    }
    case "enum":
    case "string":
      return raw.trim();
  }
}

function redactProxyUrl(value: string): string {
  // 只保留连接目标，避免把代理用户名/密码通过配置接口返回给客户端。
  return value.replace(/^(\s*[a-z][a-z\d+.-]*:\/\/)([^/@\s]+)@/iu, "$1***:***@");
}

function redactSecret(value: string): string {
  return value ? "********" : "";
}

function envLineRegex(envName: string): RegExp {
  return new RegExp(`^\\s*${envName}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|.*?)\\s*(?:#.*)?$`, "mu");
}

function readEnvValue(source: string, envName: string): string | undefined {
  const match = envLineRegex(envName).exec(source);
  let raw = match?.[1];
  if (raw === undefined) return undefined;
  raw = raw.trim();
  if (raw.length >= 2 && ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'")))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function upsertEnvValue(source: string, envName: string, value: string): string {
  const regex = envLineRegex(envName);
  const line = `${envName}=${value}`;
  return regex.test(source)
    ? source.replace(regex, line)
    : `${source}${source.length === 0 || source.endsWith("\n") ? "" : "\n"}${line}\n`;
}

export class RuntimeConfigStore {
  private readonly envFile: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(envFile = join(runtimeRoot, ".env")) {
    this.envFile = envFile;
  }

  async read(): Promise<RuntimeConfigView> {
    const source = await this.readSource();
    const views: RuntimeSettingView[] = SETTING_DEFS.map((def) => {
      const parsedConfigured = parseEnvValue(def, readEnvValue(source, def.env));
      // 代理留空表示未配置并回退到系统代理。
      const configuredValue = def.key === "proxy_url" && parsedConfigured === ""
        ? null
        : parsedConfigured;
      const effectiveValue = def.readEffective();
      const sensitive = def.sensitive === true;
      const redact = def.key === "proxy_url" ? redactProxyUrl : redactSecret;
      const configured = sensitive && typeof configuredValue === "string" ? redact(configuredValue) : configuredValue;
      const effective = sensitive && typeof effectiveValue === "string" ? redact(effectiveValue) : effectiveValue;
      return {
        key: def.key,
        env: def.env,
        label: def.label,
        description: def.description,
        type: def.type,
        ...(def.min !== undefined ? { min: def.min } : {}),
        ...(def.max !== undefined ? { max: def.max } : {}),
        ...(def.step !== undefined ? { step: def.step } : {}),
        ...(def.unit !== undefined ? { unit: def.unit } : {}),
        ...(def.options ? { options: def.options } : {}),
        default: def.defaultValue,
        effective,
        configured,
        ...(sensitive ? { sensitive: true } : {}),
        restart_required: configuredValue !== null && configuredValue !== effectiveValue,
      };
    });
    const body = views.find((view) => view.key === "body_limit_bytes");
    const effectiveBytes = settings.bodyLimitBytes;
    const configuredBytes = typeof body?.configured === "number" ? Math.round(body.configured * 1024 * 1024) : effectiveBytes;
    return {
      settings: views,
      effective_body_limit_bytes: effectiveBytes,
      configured_body_limit_bytes: configuredBytes,
      body_limit_max_bytes: MAX_BODY_LIMIT_BYTES,
      restart_required: body?.restart_required ?? false,
    };
  }

  async save(updates: Record<string, unknown>): Promise<RuntimeConfigView> {
    const keys = Object.keys(updates);
    if (keys.length === 0) throw new TypeError("没有需要保存的配置项");
    const entries: Array<[string, string]> = [];
    for (const key of keys) {
      const def = SETTING_DEFS.find((item) => item.key === key);
      if (!def) throw new RangeError(`未知配置项：${key}`);
      entries.push([def.env, toEnvValue(def, updates[key])]);
    }
    let result: RuntimeConfigView | undefined;
    const operation = this.writeQueue.then(async () => {
      // 每个排队操作都重新读取，避免后一个请求覆盖前一个请求刚写入的配置。
      let source = await this.readSource();
      for (const [env, value] of entries) source = upsertEnvValue(source, env, value);
      await this.writeAtomically(source);
      result = await this.read();
    });
    // 当前请求失败不能阻塞后续保存请求。
    this.writeQueue = operation.then(() => undefined, () => undefined);
    await operation;
    return result as RuntimeConfigView;
  }

  private async writeAtomically(source: string): Promise<void> {
    const directory = dirname(this.envFile);
    await mkdir(directory, { recursive: true });
    const temporaryFile = join(
      directory,
      `.${this.envFile.split(/[\\/]/u).pop() ?? ".env"}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      await writeFile(temporaryFile, source, { encoding: "utf8", flag: "wx" });
      await rename(temporaryFile, this.envFile);
    } catch (error) {
      await unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  private async readSource(): Promise<string> {
    try {
      return await readFile(this.envFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }
}
