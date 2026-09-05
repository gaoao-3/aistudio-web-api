import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteResponseCache } from "../src/cache/sqlite-response-cache.js";

function tempCache(
  options: Partial<ConstructorParameters<typeof SqliteResponseCache>[0]> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "aistudio-sqlite-cache-"));
  const cache = new SqliteResponseCache({
    enabled: true,
    ttlSeconds: 60,
    maxBytes: 4096,
    maxEntryBytes: 1024,
    file: join(directory, "cache.sqlite"),
    ...options,
  });
  return { cache, directory, file: join(directory, "cache.sqlite") };
}

test("sqlite response cache matches the in-memory key/get/set semantics", () => {
  const { cache, directory } = tempCache();
  try {
    const first = cache.key("model", { contents: [{ b: 2, a: 1 }] });
    const second = cache.key("model", { contents: [{ a: 1, b: 2 }] });
    assert.equal(first, second);
    assert.ok(first);
    // exact 模式：带 tools 的请求进缓存；外部引用不进
    assert.ok(cache.key("model", { tools: [{ googleSearch: {} }], contents: [] }));
    assert.equal(
      cache.key("model", { contents: [{ parts: [{ fileData: { fileUri: "https://example.com/f" } }] }] }),
      undefined,
    );

    const response = { candidates: [{ text: "cached" }] };
    cache.set(first, response);
    const hit = cache.get(first);
    assert.deepEqual(hit, response);
    assert.ok(hit && cache.wasHit(hit));

    const stats = cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.stores, 1);
    assert.equal(stats.entries, 1);
    assert.ok(stats.totalBytes > 0);
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite response cache persists entries across instances (process restarts)", () => {
  const { cache, directory, file } = tempCache();
  const key = cache.key("model", { contents: [{ text: "persist me" }] });
  assert.ok(key);
  cache.set(key, { candidates: [{ text: "survives restart" }] });
  cache.close();

  // 模拟进程重启：用同一个文件开一个新实例
  const reopened = new SqliteResponseCache({
    enabled: true,
    ttlSeconds: 60,
    maxBytes: 4096,
    maxEntryBytes: 1024,
    file,
  });
  try {
    const hit = reopened.get(key);
    assert.deepEqual(hit, { candidates: [{ text: "survives restart" }] });
    const stats = reopened.stats();
    assert.equal(stats.entries, 1);
    assert.equal(stats.hits, 1); // 计数器是进程级的，重启后重新累计
  } finally {
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite response cache expires entries and counts them as misses", async () => {
  const { cache, directory } = tempCache({ ttlSeconds: 0.05 });
  try {
    const key = cache.key("model", { contents: [{ text: "hello" }] });
    assert.ok(key);
    cache.set(key, { candidates: [{ text: "world" }] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(cache.get(key), undefined);
    const stats = cache.stats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.expirations, 1);
    assert.equal(stats.entries, 0);
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite response cache evicts least-recently-accessed entries over capacity", async () => {
  const { cache, directory } = tempCache({ maxBytes: 600, maxEntryBytes: 300 });
  try {
    const keyA = cache.key("model", { contents: [{ text: "a" }] });
    const keyB = cache.key("model", { contents: [{ text: "b" }] });
    assert.ok(keyA && keyB);
    cache.set(keyA, { candidates: [{ text: "x".repeat(200) }] });
    // 保证 accessed_at 不同
    await new Promise((resolve) => setTimeout(resolve, 5));
    cache.set(keyB, { candidates: [{ text: "y".repeat(200) }] });
    assert.equal(cache.stats().entries, 2);

    // 访问 A 让它变"新"，再塞入 C 把 B 挤出去
    cache.get(keyA);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const keyC = cache.key("model", { contents: [{ text: "c" }] });
    assert.ok(keyC);
    cache.set(keyC, { candidates: [{ text: "z".repeat(200) }] });

    const stats = cache.stats();
    assert.equal(stats.entries, 2);
    assert.ok(stats.evictions >= 1);
    assert.ok(cache.get(keyA)); // 最近访问过，保留
    assert.ok(cache.get(keyC)); // 新写入，保留
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sqlite response cache skips oversized responses", () => {
  // 上限要大于请求体（否则 key() 就返回 undefined），但小于响应体
  const { cache, directory } = tempCache({ maxEntryBytes: 128 });
  try {
    const key = cache.key("model", { contents: [{ text: "hi" }] });
    assert.ok(key);
    cache.set(key, { candidates: [{ text: "x".repeat(256) }] });
    const stats = cache.stats();
    assert.equal(stats.stores, 0);
    assert.equal(stats.skippedStores, 1);
    assert.equal(stats.entries, 0);
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
