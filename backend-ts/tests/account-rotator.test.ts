import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AccountRotator, isRateLimitedError } from "../src/accounts/account-rotator.js";
import { AccountStore } from "../src/accounts/account-store.js";

async function makeStore(directory: string): Promise<AccountStore> {
  const store = new AccountStore(directory);
  await store.saveStorageState({
    name: "A",
    email: "a@example.com",
    storageState: { cookies: [{ name: "SID", value: "a", domain: ".google.com", path: "/" }], origins: [] },
  });
  await store.saveStorageState({
    name: "B",
    email: "b@example.com",
    storageState: { cookies: [{ name: "SID", value: "b", domain: ".google.com", path: "/" }], origins: [] },
  });
  return store;
}

describe("account rotation", () => {
  it("round-robins accounts and skips a rate-limited account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-"));
    try {
      const store = await makeStore(directory);
      const rotator = new AccountRotator(store, "round_robin", 60);
      const first = await rotator.getNextAccount();
      assert.ok(first);
      rotator.recordRateLimited(first.id);
      const second = await rotator.getNextAccount();
      assert.ok(second);
      assert.notEqual(second.id, first.id);
      rotator.recordSuccess(second.id);
      const stats = await rotator.getAllStats();
      assert.equal(stats[first.id]?.rate_limited, 1);
      assert.equal(stats[second.id]?.success, 1);
      assert.equal(stats[first.id]?.is_available, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses least-recently-used selection when configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-lru-"));
    try {
      const store = await makeStore(directory);
      const rotator = new AccountRotator(store, "lru", 0);
      const first = await rotator.getNextAccount();
      assert.ok(first);
      rotator.recordSuccess(first.id);
      const second = await rotator.getNextAccount();
      assert.ok(second);
      assert.notEqual(second.id, first.id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers an available account with a warm browser", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-warm-"));
    try {
      const store = await makeStore(directory);
      const accounts = await store.list();
      const warm = accounts[1];
      assert.ok(warm);
      const rotator = new AccountRotator(store, "round_robin", 60);
      const selected = await rotator.getNextAccount(undefined, new Set([warm.id]));
      assert.equal(selected?.id, warm.id);
      if (selected) rotator.recordSuccess(selected.id);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("cooldown waiting", () => {
  it("rejects with AbortError when the signal fires mid-cooldown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-abort-"));
    try {
      const store = new AccountStore(directory);
      await store.saveStorageState({
        name: "A",
        email: "a@example.com",
        storageState: { cookies: [{ name: "SID", value: "a", domain: ".google.com", path: "/" }], origins: [] },
      });
      const rotator = new AccountRotator(store, "round_robin", 60);
      const only = await rotator.getNextAccount();
      assert.ok(only);
      rotator.recordRateLimited(only.id);
      const controller = new AbortController();
      const pending = rotator.getNextAccount(controller.signal);
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(pending, (error: unknown) => (error as Error).name === "AbortError");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("permission denied combos", () => {
  it("skips the denied account-model combo but keeps other models eligible", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-denied-"));
    try {
      const store = await makeStore(directory);
      const rotator = new AccountRotator(store, "round_robin", 0);
      const first = await rotator.getNextAccount(undefined, undefined, undefined, "gemini-2.5-pro");
      assert.ok(first);
      await rotator.recordDenied(first.id, "models/gemini-2.5-pro");
      assert.equal(rotator.isDenied(first.id, "gemini-2.5-pro"), true);

      const second = await rotator.getNextAccount(undefined, undefined, undefined, "gemini-2.5-pro");
      assert.ok(second);
      assert.notEqual(second.id, first.id);
      rotator.recordSuccess(second.id);

      // 同一账号换个模型仍可被选中
      const other = await rotator.getNextAccount(undefined, undefined, new Set([second!.id]), "gemini-3-flash-preview");
      assert.equal(other?.id, first.id);
      rotator.recordSuccess(first.id);

      const stats = await rotator.getAllStats();
      assert.deepEqual(stats[first.id]?.denied_models, ["gemini-2.5-pro"]);

      // 全部账号被该模型拒绝时不再返回账号
      await rotator.recordDenied(second!.id, "gemini-2.5-pro");
      const none = await rotator.getNextAccount(undefined, undefined, undefined, "gemini-2.5-pro");
      assert.equal(none, undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists denied combos and resetAccount clears them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-denied-persist-"));
    try {
      const store = await makeStore(directory);
      const rotator = new AccountRotator(store, "round_robin", 0);
      const first = await rotator.getNextAccount();
      assert.ok(first);
      await rotator.recordDenied(first.id, "gemini-2.5-pro");

      // 模拟重启：新 rotator 从磁盘恢复
      const restored = new AccountRotator(store, "round_robin", 0);
      restored.setDenied(await store.deniedModels());
      assert.equal(restored.isDenied(first.id, "gemini-2.5-pro"), true);

      // 重新登录 / 导入 Cookie 后恢复资格
      await restored.resetAccount(first.id);
      assert.equal(restored.isDenied(first.id, "gemini-2.5-pro"), false);
      assert.deepEqual(await store.deniedModels(), {});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("classifies upstream 403 permission errors", async () => {
    const { isPermissionDeniedError } = await import("../src/accounts/account-rotator.js");
    assert.equal(isPermissionDeniedError(new Error('AI Studio upstream returned HTTP 403: [,[7,"The caller does not have permission"]]')), true);
    assert.equal(isPermissionDeniedError(new Error("AI Studio upstream returned HTTP 429: quota exceeded")), false);
    assert.equal(isPermissionDeniedError(new Error("Google cookies are expired")), false);
  });
  it("classifies per-user quota routing errors as rate limited", () => {
    assert.equal(
      isRateLimitedError(
        new Error("AI Studio upstream returned HTTP 404: [,[5,\"Ambiguous request for service '' and method '/GenerativeService.StreamGenerateContentPerUserQuota'.\"]]"),
      ),
      true,
    );
    assert.equal(
      isRateLimitedError(new Error("AI Studio upstream returned HTTP 404: Requested entity was not found.")),
      false,
    );
  });
});

it("least_rl incorporates recent latency without ignoring concurrent load", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-health-"));
  try {
    const store = await makeStore(directory);
    const accounts = await store.list();
    const slow = accounts[0];
    const fast = accounts[1];
    assert.ok(slow && fast);
    const rotator = new AccountRotator(store, "least_rl", 0);
    rotator.recordSuccess(slow.id, 2_000);
    rotator.recordSuccess(fast.id, 100);
    const selected = await rotator.getNextAccount();
    assert.equal(selected?.id, fast.id);
    const stats = await rotator.getAllStats();
    assert.equal(stats[fast.id]?.latency_ewma_ms, 100);
    assert.equal(stats[fast.id]?.in_flight, 1);
    if (selected) rotator.recordSuccess(selected.id, 200);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
