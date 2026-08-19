import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AccountRotator } from "../src/accounts/account-rotator.js";
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
