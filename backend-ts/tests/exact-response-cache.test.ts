import assert from "node:assert/strict";
import test from "node:test";
import { ExactResponseCache } from "../src/cache/exact-response-cache.js";

const options = {
  enabled: true,
  ttlSeconds: 60,
  maxBytes: 1024,
  maxEntryBytes: 512,
} as const;

test("exact response cache canonicalizes object keys and clones responses", () => {
  const cache = new ExactResponseCache(options);
  const first = cache.key("model", { contents: [{ b: 2, a: 1 }] });
  const second = cache.key("model", { contents: [{ a: 1, b: 2 }] });
  assert.equal(first, second);
  assert.ok(first);

  const response = { candidates: [{ text: "cached" }] };
  cache.set(first, response);
  const hit = cache.get(first);
  assert.deepEqual(hit, response);
  assert.ok(hit && cache.wasHit(hit));
  (hit?.candidates as Array<{ text: string }>)[0]!.text = "changed";
  assert.deepEqual(cache.get(first), response);
});

test("exact cache allows tool requests but skips external references and oversized requests", () => {
  const cache = new ExactResponseCache(options);
  // exact 模式：带 tools 的请求参与缓存（工具副作用在客户端重新执行）
  assert.ok(cache.key("model", { tools: [{ googleSearch: {} }], contents: [] }));
  assert.ok(cache.key("model", {
    tools: [{ functionDeclarations: [{ name: "get_weather" }] }],
    contents: [
      { role: "user", parts: [{ text: "天气?" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: { city: "Paris" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: { temp: 20 } } }] },
    ],
  }));
  // 外部句柄（fileData/cachedContent）任何模式都跳过
  assert.equal(
    cache.key("model", { contents: [{ parts: [{ fileData: { fileUri: "https://example.com/f" } }] }] }),
    undefined,
  );
  assert.equal(
    cache.key("model", { cachedContent: "cachedContents/abc", contents: [] }),
    undefined,
  );
  assert.equal(
    cache.key("model", { contents: [{ text: "x".repeat(600) }] }),
    undefined,
  );
});

test("deterministic cache still skips tool requests", () => {
  const cache = new ExactResponseCache({ ...options, mode: "deterministic" });
  const deterministic = {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    generationConfig: { temperature: 0, seed: 42 },
  };
  assert.equal(cache.key("model", { ...deterministic, tools: [{ googleSearch: {} }] }), undefined);
  assert.ok(cache.key("model", deterministic));
});

test("exact response cache counts oversized responses as skipped stores", () => {
  // 上限要大于请求体（否则 key() 就返回 undefined），但小于响应体
  const cache = new ExactResponseCache({ ...options, maxEntryBytes: 128 });
  const key = cache.key("model", { contents: [{ text: "hi" }] });
  assert.ok(key);
  cache.set(key, { candidates: [{ text: "x".repeat(256) }] });
  const stats = cache.stats();
  assert.equal(stats.stores, 0);
  assert.equal(stats.skippedStores, 1);
  assert.equal(stats.entries, 0);
});

test("exact response cache tracks hit/miss/store/eviction stats", () => {
  const cache = new ExactResponseCache(options);
  assert.deepEqual(cache.stats(), {
    enabled: true,
    mode: "exact",
    entries: 0,
    totalBytes: 0,
    maxBytes: 1024,
    ttlSeconds: 60,
    hits: 0,
    misses: 0,
    stores: 0,
    skippedStores: 0,
    expirations: 0,
    evictions: 0,
    hitRate: 0,
  });

  const key = cache.key("model", { contents: [{ text: "hello" }] });
  assert.ok(key);

  cache.get(key); // miss
  cache.set(key, { candidates: [{ text: "world" }] });
  cache.get(key); // hit
  cache.get(key); // hit

  const stats = cache.stats();
  assert.equal(stats.misses, 1);
  assert.equal(stats.hits, 2);
  assert.equal(stats.stores, 1);
  assert.equal(stats.entries, 1);
  assert.ok(stats.totalBytes > 0);
  assert.ok(Math.abs(stats.hitRate - 2 / 3) < 1e-9);

  cache.clear();
  assert.equal(cache.stats().hits, 0);
  assert.equal(cache.stats().misses, 0);
});

test("exact response cache counts expirations as misses", async () => {
  const cache = new ExactResponseCache({ ...options, ttlSeconds: 0.05 });
  const key = cache.key("model", { contents: [{ text: "hello" }] });
  assert.ok(key);
  cache.set(key, { candidates: [{ text: "world" }] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(cache.get(key), undefined);
  const stats = cache.stats();
  assert.equal(stats.hits, 0);
  assert.equal(stats.misses, 1);
  assert.equal(stats.expirations, 1);
  assert.equal(stats.entries, 0);
});

test("deterministic cache requires temperature zero, a fixed seed, and static parts", () => {
  const cache = new ExactResponseCache({ ...options, mode: "deterministic" });
  const deterministic = {
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
    generationConfig: { temperature: 0, seed: 42 },
  };
  assert.ok(cache.key("model", deterministic));
  assert.equal(cache.key("model", { ...deterministic, generationConfig: { temperature: 0 } }), undefined);
  assert.equal(cache.key("model", { ...deterministic, generationConfig: { temperature: 0.5, seed: 42 } }), undefined);
  assert.equal(cache.key("model", {
    ...deterministic,
    contents: [{ role: "user", parts: [{ fileData: { fileUri: "https://example.com/file" } }] }],
  }), undefined);
  assert.equal(cache.key("model", {
    ...deterministic,
    contents: [{ role: "user", parts: [{ functionResponse: { name: "tool", response: {} } }] }],
  }), undefined);
  assert.equal(cache.stats().mode, "deterministic");
});
