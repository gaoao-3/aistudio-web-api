import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RequestLogStore } from "../src/logs/request-log-store.js";

function tempStore(maxEntries = 2000) {
  const directory = mkdtempSync(join(tmpdir(), "aistudio-request-logs-"));
  return { store: new RequestLogStore(join(directory, "logs.sqlite"), maxEntries), directory };
}

test("request log store records and lists newest-first with pagination", () => {
  const { store, directory } = tempStore();
  try {
    for (let i = 1; i <= 5; i++) {
      store.record({
        created_at: 1700000000000 + i,
        kind: "generate",
        model: "gemini-test",
        account: i % 2 ? "acc_a" : undefined,
        status: i === 3 ? "rate_limited" : "success",
        latency_ms: i * 100,
        prompt_tokens: i,
        completion_tokens: i * 2,
        total_tokens: i * 3,
        cache: i === 4 ? "hit" : "miss",
        attempts: 1,
        error: i === 5 ? "boom" : undefined,
      });
    }
    const rows = store.list(3);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(r => r.total_tokens), [15, 12, 9]); // 最新在前
    assert.equal(rows[0]?.error, "boom");      // i=5：错误记录
    assert.equal(rows[1]?.cache, "hit");      // i=4：缓存命中
    assert.equal(rows[0]?.cache, "miss");
    const older = store.list(3, rows[2]!.id);
    assert.deepEqual(older.map(r => r.total_tokens), [6, 3]);
    assert.equal(older[1]?.account, "acc_a");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("request log store prunes old entries beyond the cap", () => {
  const { store, directory } = tempStore(150);
  try {
    for (let i = 0; i < 260; i++) {
      store.record({
        created_at: i, kind: "generate", model: "m", status: "success",
        latency_ms: 1, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
        cache: "miss", attempts: 1,
      });
    }
    const rows = store.list(500);
    // 每 100 条批量 prune 一次到 150，条数在 [150, 249] 之间振荡
    assert.ok(rows.length <= 249, `expected <= 249, got ${rows.length}`);
    assert.ok(rows.length >= 150);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
