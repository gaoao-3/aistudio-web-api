import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface InteractionTaskStoreOptions {
  readonly ttlMs?: number;
  readonly maxRecords?: number;
  readonly now?: () => number;
}

export type InteractionTaskResponse = Record<string, unknown>;

/** Local, single-process task persistence. Owners are SHA-256 hashes, never raw credentials. */
export class InteractionTaskStore {
  private readonly db: DatabaseSync;
  private readonly ttlMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;

  constructor(filePath: string, options: InteractionTaskStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 86_400_000;
    this.maxRecords = options.maxRecords ?? 256;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) throw new RangeError("ttlMs must be positive and finite");
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords <= 0) throw new RangeError("maxRecords must be a positive safe integer");
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS interaction_tasks (
        id TEXT PRIMARY KEY,
        owner_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interaction_tasks_expiry ON interaction_tasks(expires_at);
    `);
    this.cleanup();
    for (const row of this.db.prepare("SELECT id, response FROM interaction_tasks WHERE status IN ('queued', 'in_progress')").all()) {
      const response = this.failureResponse(String(row.id), JSON.parse(String(row.response)) as InteractionTaskResponse,
        { code: "interaction_interrupted", message: "Background interaction interrupted by process restart." });
      this.db.prepare("UPDATE interaction_tasks SET status = 'failed', response = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(response), this.now(), String(row.id));
    }
  }

  create(id: string, owner: string, initialResponse: InteractionTaskResponse): InteractionTaskResponse {
    return this.insert(id, owner, { ...initialResponse, status: "in_progress" }, "in_progress");
  }

  /** Persist an already-finished foreground interaction so GET can retrieve it later. */
  save(id: string, owner: string, response: InteractionTaskResponse): InteractionTaskResponse {
    const status = typeof response.status === "string" ? response.status : "completed";
    return this.insert(id, owner, response, status);
  }

  private insert(id: string, owner: string, response: InteractionTaskResponse, status: string): InteractionTaskResponse {
    this.cleanup();
    const stored = { ...response, id, object: "interaction", status };
    const now = this.now();
    const serialized = JSON.stringify(stored);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT id FROM interaction_tasks WHERE id = ?").get(id)) {
        throw new Error("Interaction task already exists");
      }
      const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM interaction_tasks").get()!.count);
      const removeCount = Math.max(0, count - this.maxRecords + 1);
      const candidates = this.db.prepare("SELECT id FROM interaction_tasks WHERE status IN ('completed', 'requires_action', 'failed', 'incomplete') ORDER BY updated_at, rowid LIMIT ?").all(removeCount);
      if (candidates.length < removeCount) throw new Error("Interaction task store capacity exhausted by pending tasks");
      for (const candidate of candidates) this.db.prepare("DELETE FROM interaction_tasks WHERE id = ?").run(candidate.id!);
      this.db.prepare("INSERT INTO interaction_tasks VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, this.ownerHash(owner), status, serialized, now, now, now + this.ttlMs);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return JSON.parse(serialized) as InteractionTaskResponse;
  }

  get(id: string, owner: string): InteractionTaskResponse | undefined {
    this.cleanup();
    const row = this.db.prepare("SELECT response FROM interaction_tasks WHERE id = ? AND owner_hash = ?")
      .get(id, this.ownerHash(owner));
    return row ? JSON.parse(String(row.response)) as InteractionTaskResponse : undefined;
  }

  complete(id: string, owner: string, response: InteractionTaskResponse): InteractionTaskResponse | undefined {
    if (!this.get(id, owner)) return undefined;
    const result = { ...response, id, object: "interaction", status: response.status === "requires_action" ? "requires_action" : response.status === "incomplete" ? "incomplete" : "completed" };
    this.db.prepare("UPDATE interaction_tasks SET status = ?, response = ?, updated_at = ? WHERE id = ? AND owner_hash = ?")
      .run(result.status, JSON.stringify(result), this.now(), id, this.ownerHash(owner));
    return this.get(id, owner);
  }

  fail(id: string, owner: string, error: unknown): InteractionTaskResponse | undefined {
    const previous = this.get(id, owner);
    if (!previous) return undefined;
    const response = this.failureResponse(id, previous, error);
    this.db.prepare("UPDATE interaction_tasks SET status = 'failed', response = ?, updated_at = ? WHERE id = ? AND owner_hash = ?")
      .run(JSON.stringify(response), this.now(), id, this.ownerHash(owner));
    return this.get(id, owner);
  }

  private failureResponse(id: string, previous: InteractionTaskResponse, error: unknown): InteractionTaskResponse {
    const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
    return { ...previous, id, object: "interaction", status: "failed", error: {
      ...details,
      code: typeof details.code === "string" ? details.code : "interaction_failed",
      message: typeof details.message === "string" ? details.message : typeof error === "string" ? error : "Background interaction failed.",
    } };
  }

  close(): void { this.db.close(); }

  private cleanup(): void {
    this.db.prepare("DELETE FROM interaction_tasks WHERE expires_at <= ?").run(this.now());
  }

  private ownerHash(owner: string): string {
    return createHash("sha256").update(owner).digest("hex");
  }
}
