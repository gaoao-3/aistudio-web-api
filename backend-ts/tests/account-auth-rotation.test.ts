import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AccountRotator,
  isAuthExpiredError,
} from "../src/accounts/account-rotator.js";
import { AccountStore } from "../src/accounts/account-store.js";

async function makeStore(directory: string): Promise<AccountStore> {
  const store = new AccountStore(directory);
  await store.saveStorageState({
    name: "A",
    email: "a@example.com",
    storageState: {
      cookies: [{ name: "SID", value: "a", domain: ".google.com", path: "/" }],
      origins: [],
    },
  });
  await store.saveStorageState({
    name: "B",
    email: "b@example.com",
    storageState: {
      cookies: [{ name: "SID", value: "b", domain: ".google.com", path: "/" }],
      origins: [],
    },
  });
  return store;
}

describe("auth-expired rotation", () => {
  it("detects cookie-expired errors from the browser session", () => {
    assert.equal(
      isAuthExpiredError(
        new Error(
          "Failed to open AI Studio: Error: Google cookies are expired",
        ),
      ),
      true,
    );
    assert.equal(
      isAuthExpiredError(
        new Error(
          "Failed to install AI Studio hooks at https://accounts.google.com/v3/signin/accountchooser?continue=x",
        ),
      ),
      true,
    );
    assert.equal(
      isAuthExpiredError(new Error("AI Studio streaming request timed out")),
      false,
    );
    assert.equal(isAuthExpiredError(new Error("429 Too Many Requests")), false);
  });

  it("cools an auth-expired account down longer than a rate-limited one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-auth-"));
    try {
      const store = await makeStore(directory);
      const rotator = new AccountRotator(store, "round_robin", 60, 1800);
      const first = await rotator.getNextAccount();
      assert.ok(first);
      rotator.recordAuthExpired(first.id);

      const second = await rotator.getNextAccount();
      assert.ok(second);
      assert.notEqual(second.id, first.id, "auth-expired account is skipped");

      const stats = await rotator.getAllStats();
      assert.equal(stats[first.id]?.auth_expired, 1);
      assert.equal(stats[first.id]?.errors, 1);
      assert.equal(stats[first.id]?.is_available, false);
      assert.ok(
        (stats[first.id]?.cooldown_remaining ?? 0) > 60,
        "auth cooldown exceeds the rate-limit cooldown",
      );
      assert.ok(stats[first.id]?.last_auth_expired);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resetAccount immediately clears the auth-expired cooldown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-rotator-reset-"));
    try {
      const store = await makeStore(directory);
      const rotator = new AccountRotator(store, "round_robin", 60, 1800);
      const first = await rotator.getNextAccount();
      assert.ok(first);
      rotator.recordAuthExpired(first.id);
      assert.equal(
        (await rotator.getAllStats())[first.id]?.is_available,
        false,
      );

      // Re-login / cookie import resets the stats.
      rotator.resetAccount(first.id);
      const stats = (await rotator.getAllStats())[first.id];
      assert.equal(stats?.is_available, true);
      assert.equal(stats?.auth_expired, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
