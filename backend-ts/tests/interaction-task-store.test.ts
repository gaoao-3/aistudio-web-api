import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { InteractionTaskStore, type InteractionTaskStoreOptions } from "../src/openai/interaction-task-store.js";

function fixture(t: test.TestContext, options: InteractionTaskStoreOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), "interaction-tasks-"));
  const file = join(directory, "nested", "tasks.sqlite");
  let store = new InteractionTaskStore(file, options);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { file, get store() { return store; }, reopen() { store.close(); store = new InteractionTaskStore(file, options); return store; } };
}

test("persists completed and requires_action responses across restart with scoped writes", (t) => {
  const f = fixture(t);
  for (const status of ["completed", "requires_action"]) {
    f.store.create(status, "owner", initial);
    const response = { ...initial, id: status, status, steps: [{ type: "text", text: "answer" }], usage: { total_tokens: 42 } };
    assert.equal(f.store.complete(status, "wrong", response), undefined);
    assert.deepEqual(f.store.complete(status, "owner", response), response);
  }
  f.reopen();
  for (const status of ["completed", "requires_action"]) {
    assert.equal(f.store.get(status, "owner")!.status, status);
    assert.deepEqual(f.store.get(status, "owner")!.usage, { total_tokens: 42 });
  }
  assert.equal(f.store.complete("missing", "owner", {}), undefined);
});

test("failure and restart interruption preserve interaction identity and structured error", (t) => {
  const f = fixture(t);
  f.store.create("failed", "owner", initial);
  assert.equal(f.store.fail("failed", "wrong", new Error("no")), undefined);
  assert.equal(f.store.fail("missing", "owner", "no"), undefined);
  const failed = f.store.fail("failed", "owner", { code: "upstream_error", message: "offline", detail: 1 });
  assert.deepEqual(failed, { ...initial, id: "failed", status: "failed", error: { code: "upstream_error", message: "offline", detail: 1 } });
  f.store.create("running", "owner", initial);
  f.store.create("queued", "owner", initial);
  const db = new DatabaseSync(f.file);
  db.prepare("UPDATE interaction_tasks SET status = 'queued' WHERE id = ?").run("queued");
  db.close();
  f.reopen();
  assert.deepEqual(f.store.get("failed", "owner"), failed);
  for (const id of ["running", "queued"]) {
    const response = f.store.get(id, "owner")!;
    assert.equal(response.id, id);
    assert.equal(response.object, "interaction");
    assert.equal(response.status, "failed");
    assert.deepEqual(response.error, { code: "interaction_interrupted", message: "Background interaction interrupted by process restart." });
  }
  f.store.create("error", "owner", initial);
  assert.deepEqual(f.store.fail("error", "owner", new Error("offline"))!.error, { code: "interaction_failed", message: "offline" });
});

test("expires globally on access without polling or completion extending TTL", (t) => {
  let now = 1000;
  const f = fixture(t, { ttlMs: 100, now: () => now });
  f.store.create("a", "owner", initial);
  f.store.create("b", "owner", initial);
  now = 1099;
  assert.ok(f.store.get("a", "owner"));
  f.store.complete("a", "owner", { status: "completed" });
  now = 1100;
  assert.equal(f.store.get("missing", "other"), undefined);
  const db = new DatabaseSync(f.file);
  try { assert.equal(db.prepare("SELECT COUNT(*) AS count FROM interaction_tasks").get()!.count, 0); }
  finally { db.close(); }
  assert.equal(f.store.complete("a", "owner", {}), undefined);
  assert.equal(f.store.fail("b", "owner", "late"), undefined);
  f.store.create("c", "owner", initial);
  now = 1200;
  f.reopen();
  assert.equal(f.store.get("c", "owner"), undefined);
});

test("bounds records by evicting oldest terminal task, never running tasks", (t) => {
  let now = 1000;
  const { store } = fixture(t, { maxRecords: 2, ttlMs: 100, now: () => now });
  store.create("running", "owner", initial);
  store.create("done", "owner", initial);
  assert.throws(() => store.create("overflow", "owner", initial), /capacity/i);
  assert.ok(store.get("running", "owner"));
  store.complete("done", "owner", { status: "requires_action" });
  assert.throws(() => store.create("running", "other", initial), /already exists/i);
  assert.ok(store.get("done", "owner"));
  const circular: Record<string, unknown> = {}; circular.self = circular;
  assert.throws(() => store.create("invalid", "owner", circular));
  assert.ok(store.get("done", "owner"));
  store.create("next", "owner", initial);
  assert.equal(store.get("done", "owner"), undefined);
  assert.ok(store.get("running", "owner"));
  now = 1100;
  store.create("fresh", "owner", initial);
  assert.equal(store.get("running", "owner"), undefined);
});

test("default capacity is 256 and invalid bounds are rejected", (t) => {
  const { store } = fixture(t);
  for (let i = 0; i < 256; i++) store.create(`int_${i}`, "owner", initial);
  assert.throws(() => store.create("overflow", "owner", initial), /capacity/i);
  for (const maxRecords of [0, -1, 1.5, NaN, Infinity]) {
    assert.throws(() => new InteractionTaskStore(":memory:", { maxRecords }), /maxRecords/);
  }
  for (const ttlMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => new InteractionTaskStore(":memory:", { ttlMs }), /ttlMs/);
  }
});

const initial = { id: "int_1", object: "interaction", status: "in_progress", model: "test-model", steps: [] };

test("creates detached full JSON responses with owner-scoped access and hashed ownership", (t) => {
  const { store, file } = fixture(t);
  assert.deepEqual(store.create("int_1", "synthetic-owner", initial), initial);
  assert.deepEqual(store.get("int_1", "synthetic-owner"), initial);
  assert.equal(store.get("int_1", "other"), undefined);
  assert.equal(store.get("missing", "synthetic-owner"), undefined);
  store.get("int_1", "synthetic-owner")!.model = "mutated";
  assert.equal(store.get("int_1", "synthetic-owner")!.model, "test-model");
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare("SELECT * FROM interaction_tasks").get()!;
    assert.match(String(row.owner_hash), /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(row).includes("synthetic-owner"));
    assert.equal(Number(row.expires_at) - Number(row.created_at), 86_400_000);
    assert.equal(row.updated_at, row.created_at);
  } finally { db.close(); }
});
