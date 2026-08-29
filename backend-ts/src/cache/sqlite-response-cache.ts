import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  computeResponseCacheKey,
  type ExactResponseCacheOptions,
  type ExactResponseCacheStats,
  type ResponseCacheBackend,
} from "./exact-response-cache.js";

export interface SqliteResponseCacheOptions extends ExactResponseCacheOptions {
  readonly file: string;
}

interface CacheRow {
  readonly response: string;
  readonly bytes: number;
  readonly expires_at: number;
}

/**
 * SQLite 持久化的精确响应缓存：与内存版同一套键和统计口径，
 * 但条目落盘，进程重启后缓存仍然有效。计数器本身是进程级的（重启清零）。
 */
export class SqliteResponseCache implements ResponseCacheBackend {
  private readonly db: DatabaseSync;
  private readonly hits = new WeakSet<Record<string, unknown>>();
  private totalBytes = 0;
  private hitCount = 0;
  private missCount = 0;
  private storeCount = 0;
  private skipCount = 0;
  private expirationCount = 0;
  private evictionCount = 0;

  constructor(private readonly options: SqliteResponseCacheOptions) {
    mkdirSync(dirname(options.file), { recursive: true });
    this.db = new DatabaseSync(options.file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS response_cache (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_response_cache_expires_at ON response_cache(expires_at);
    `);
    this.totalBytes = this.sumBytes();
  }

  key(model: string, body: unknown): string | undefined {
    return computeResponseCacheKey(this.options, model, body);
  }

  get(key: string): Record<string, unknown> | undefined {
    const row = this.db
      .prepare(
        "SELECT response, bytes, expires_at FROM response_cache WHERE key = ?",
      )
      .get(key) as unknown as CacheRow | undefined;
    if (!row) {
      this.missCount += 1;
      return undefined;
    }
    const now = Date.now();
    if (row.expires_at <= now) {
      this.deleteRow(key, row.bytes);
      this.expirationCount += 1;
      this.missCount += 1;
      return undefined;
    }
    this.db
      .prepare("UPDATE response_cache SET accessed_at = ? WHERE key = ?")
      .run(now, key);
    let response: Record<string, unknown>;
    try {
      response = JSON.parse(row.response) as Record<string, unknown>;
    } catch {
      // 落盘数据损坏：按未命中处理并删掉坏行
      this.deleteRow(key, row.bytes);
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
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
    const serialized = JSON.stringify(response);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.options.maxEntryBytes || bytes > this.options.maxBytes) {
      this.skipCount += 1;
      return;
    }
    const now = Date.now();
    const previous = this.db
      .prepare("SELECT bytes FROM response_cache WHERE key = ?")
      .get(key) as unknown as { bytes: number } | undefined;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO response_cache (key, response, bytes, accessed_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(key, serialized, bytes, now, now + this.options.ttlSeconds * 1000);
    this.totalBytes += bytes - (previous?.bytes ?? 0);
    this.storeCount += 1;
    this.evict();
  }

  stats(): ExactResponseCacheStats {
    const lookups = this.hitCount + this.missCount;
    const entries = this.db
      .prepare("SELECT COUNT(*) AS count FROM response_cache")
      .get() as unknown as { count: number };
    return {
      enabled: this.options.enabled && (this.options.mode ?? "exact") !== "off",
      mode: this.options.mode ?? "exact",
      entries: entries.count,
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
    this.db.exec("DELETE FROM response_cache");
    this.totalBytes = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.storeCount = 0;
    this.skipCount = 0;
    this.expirationCount = 0;
    this.evictionCount = 0;
  }

  close(): void {
    this.db.close();
  }

  /** 先删过期条目；仍超容量则按最久未访问（LRU）淘汰。 */
  private evict(): void {
    const now = Date.now();
    const expired = this.db
      .prepare(
        "SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM response_cache WHERE expires_at <= ?",
      )
      .get(now) as unknown as { count: number; bytes: number };
    if (expired.count > 0) {
      this.db
        .prepare("DELETE FROM response_cache WHERE expires_at <= ?")
        .run(now);
      this.totalBytes = Math.max(0, this.totalBytes - expired.bytes);
      this.evictionCount += expired.count;
    }
    while (this.totalBytes > this.options.maxBytes) {
      const oldest = this.db
        .prepare(
          "SELECT key, bytes FROM response_cache ORDER BY accessed_at ASC LIMIT 1",
        )
        .get() as unknown as { key: string; bytes: number } | undefined;
      if (!oldest) break;
      this.deleteRow(oldest.key, oldest.bytes);
      this.evictionCount += 1;
    }
  }

  private deleteRow(key: string, bytes: number): void {
    this.db.prepare("DELETE FROM response_cache WHERE key = ?").run(key);
    this.totalBytes = Math.max(0, this.totalBytes - bytes);
  }

  private sumBytes(): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM response_cache")
      .get() as unknown as { bytes: number };
    return row.bytes;
  }
}
