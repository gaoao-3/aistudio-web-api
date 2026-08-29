import { createHash } from "node:crypto";

interface CacheEntry {
  readonly response: Record<string, unknown>;
  readonly expiresAt: number;
  readonly bytes: number;
}

export interface ExactResponseCacheOptions {
  readonly enabled: boolean;
  readonly mode?: "off" | "deterministic" | "exact";
  readonly ttlSeconds: number;
  readonly maxBytes: number;
  readonly maxEntryBytes: number;
}

export interface ExactResponseCacheStats {
  readonly enabled: boolean;
  readonly mode: "off" | "deterministic" | "exact";
  readonly entries: number;
  readonly totalBytes: number;
  readonly maxBytes: number;
  readonly ttlSeconds: number;
  readonly hits: number;
  readonly misses: number;
  readonly stores: number;
  readonly skippedStores: number;
  readonly expirations: number;
  readonly evictions: number;
  readonly hitRate: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function hasTools(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const tools = (body as Record<string, unknown>).tools;
  return Array.isArray(tools) && tools.length > 0;
}

function containsDynamicPart(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsDynamicPart);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (["functionCall", "functionResponse", "function_call", "function_response", "fileData", "file_data", "cachedContent", "cached_content"]
    .some(key => key in record)) return true;
  return Object.values(record).some(containsDynamicPart);
}

function deterministicRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body) || containsDynamicPart(body)) return false;
  const request = body as Record<string, unknown>;
  const generation = request.generationConfig ?? request.generation_config;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)) return false;
  const config = generation as Record<string, unknown>;
  const temperature = config.temperature;
  const seed = config.seed;
  return temperature === 0 && typeof seed === "number" && Number.isSafeInteger(seed);
}

/** 精确响应缓存的统一键：规范化后的 {model, body} 的 SHA-256。带 tools / 超限 / 禁用返回 undefined。 */
export function computeResponseCacheKey(options: ExactResponseCacheOptions, model: string, body: unknown): string | undefined {
  const mode = options.mode ?? "exact";
  if (
    !options.enabled ||
    mode === "off" ||
    options.ttlSeconds <= 0 ||
    options.maxBytes <= 0 ||
    hasTools(body) ||
    (mode === "deterministic" && !deterministicRequest(body))
  ) return undefined;
  const canonical = JSON.stringify(canonicalize({ model, body }));
  if (Buffer.byteLength(canonical) > options.maxEntryBytes)
    return undefined;
  return createHash("sha256").update(canonical).digest("hex");
}

/** 精确响应缓存后端（内存 / SQLite 都实现此接口）。 */
export interface ResponseCacheBackend {
  key(model: string, body: unknown): string | undefined;
  get(key: string): Record<string, unknown> | undefined;
  set(key: string, response: Record<string, unknown>): void;
  /** 把响应标记为"来自缓存/去重"：用量统计会跳过它（上游只消耗了一次）。 */
  markHit(response: Record<string, unknown>): void;
  wasHit(response: Record<string, unknown>): boolean;
  stats(): ExactResponseCacheStats;
  clear(): void;
}

/** Bounded in-memory cache for exact, tool-free generation requests. */
export class ExactResponseCache implements ResponseCacheBackend {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly hits = new WeakSet<Record<string, unknown>>();
  private totalBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  private storeCount = 0;
  private skipCount = 0;
  private expirationCount = 0;
  private evictionCount = 0;

  constructor(private readonly options: ExactResponseCacheOptions) {}

  key(model: string, body: unknown): string | undefined {
    return computeResponseCacheKey(this.options, model, body);
  }

  get(key: string): Record<string, unknown> | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount += 1;
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.expirationCount += 1;
      this.missCount += 1;
      this.delete(key, entry);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hitCount += 1;
    const response = structuredClone(entry.response);
    this.hits.add(response);
    return response;
  }

  markHit(response: Record<string, unknown>): void {
    this.hits.add(response);
  }

  wasHit(response: Record<string, unknown>): boolean {
    return this.hits.has(response);
  }

  set(key: string, response: Record<string, unknown>): void {
    const stored = structuredClone(response);
    const bytes = Buffer.byteLength(JSON.stringify(stored));
    if (bytes > this.options.maxEntryBytes || bytes > this.options.maxBytes) {
      this.skipCount += 1;
      return;
    }
    const previous = this.entries.get(key);
    if (previous) this.delete(key, previous);
    this.entries.set(key, {
      response: stored,
      bytes,
      expiresAt: Date.now() + this.options.ttlSeconds * 1000,
    });
    this.totalBytes += bytes;
    this.storeCount += 1;
    this.evict();
  }

  stats(): ExactResponseCacheStats {
    const lookups = this.hitCount + this.missCount;
    return {
      enabled: this.options.enabled && (this.options.mode ?? "exact") !== "off",
      mode: this.options.mode ?? "exact",
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      maxBytes: this.options.maxBytes,
      ttlSeconds: this.options.ttlSeconds,
      hits: this.hitCount,
      misses: this.missCount,
      stores: this.storeCount,
      skippedStores: this.skipCount,
      expirations: this.expirationCount,
      evictions: this.evictionCount,
      hitRate: lookups > 0 ? this.hitCount / lookups : 0,
    };
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.storeCount = 0;
    this.skipCount = 0;
    this.expirationCount = 0;
    this.evictionCount = 0;
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now || this.totalBytes > this.options.maxBytes) {
        this.evictionCount += 1;
        this.delete(key, entry);
      }
    }
  }

  private delete(key: string, entry: CacheEntry): void {
    if (!this.entries.delete(key)) return;
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
  }
}
