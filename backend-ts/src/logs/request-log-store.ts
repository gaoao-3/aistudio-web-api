import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type RequestLogStatus = "success" | "rate_limited" | "error";
export type RequestLogCache = "hit" | "dedup" | "miss" | "bypass";
export type RequestLogKind = "generate";

export interface RequestLogEntry {
  readonly created_at: number;
  readonly kind: RequestLogKind;
  readonly model: string;
  readonly account?: string | undefined;
  readonly status: RequestLogStatus;
  readonly latency_ms: number;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
  readonly cache: RequestLogCache;
  readonly attempts: number;
  readonly error?: string | undefined;
}

export interface RequestLogRow extends RequestLogEntry {
  readonly id: number;
}

/** 单次请求的追踪上下文：bridge 各层往里填，最终落库。 */
export interface RequestTrace {
  kind: RequestLogKind;
  model: string;
  readonly startedAt: number;
  account?: string | undefined;
  cache: RequestLogCache;
  attempts: number;
}

/** API 请求明细日志（类似 new-api 的日志页）：SQLite 持久化，滚动保留最近 N 条。 */
export class RequestLogStore {
  private readonly db: DatabaseSync;
  private insertsSincePrune = 0;

  constructor(
    file: string,
    private readonly maxEntries = 2000,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        model TEXT NOT NULL,
        account TEXT,
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        cache TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_logs_id ON request_logs(id DESC);
    `);
  }

  record(entry: RequestLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_logs
         (created_at, kind, model, account, status, latency_ms, prompt_tokens, completion_tokens, total_tokens, cache, attempts, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.created_at,
        entry.kind,
        entry.model,
        entry.account ?? null,
        entry.status,
        entry.latency_ms,
        entry.prompt_tokens,
        entry.completion_tokens,
        entry.total_tokens,
        entry.cache,
        entry.attempts,
        entry.error ?? null,
      );
    this.insertsSincePrune += 1;
    if (this.insertsSincePrune >= 100) this.prune();
  }

  /** 最新在前。beforeId 用于向前翻页。 */
  list(limit = 100, beforeId?: number): RequestLogRow[] {
    const rows = (beforeId
      ? this.db
          .prepare(
            "SELECT * FROM request_logs WHERE id < ? ORDER BY id DESC LIMIT ?",
          )
          .all(beforeId, limit)
      : this.db
          .prepare("SELECT * FROM request_logs ORDER BY id DESC LIMIT ?")
          .all(limit)) as unknown as RequestLogRow[];
    return rows;
  }

  private prune(): void {
    this.insertsSincePrune = 0;
    this.db
      .prepare(
        "DELETE FROM request_logs WHERE id < (SELECT COALESCE(MIN(id), 0) FROM (SELECT id FROM request_logs ORDER BY id DESC LIMIT ?))",
      )
      .run(this.maxEntries);
  }

  close(): void {
    this.db.close();
  }
}
