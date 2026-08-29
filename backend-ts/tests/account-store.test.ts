import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AccountStore, parseGoogleCookies } from "../src/accounts/account-store.js";

describe("native account cookies", () => {
  it("parses Google cookie strings for Playwright storage state", () => {
    const cookies = parseGoogleCookies("SID=one; SAPISID=two; broken; __Host-GAPS=skip");
    assert.deepEqual(cookies.map(cookie => cookie.name), ["SID", "SAPISID"]);
    assert.equal(cookies[0]?.domain, ".google.com");
    assert.equal(cookies[0]?.httpOnly, false);
    assert.equal(cookies[0]?.sameSite, "None");
  });

  it("persists a browser storage state as a managed account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-login-account-"));
    try {
      const store = new AccountStore(directory);
      const saved = await store.saveStorageState({
        name: "测试账号",
        email: "test@example.com",
        storageState: {
          cookies: [{ name: "SID", value: "secret", domain: ".google.com", path: "/" }],
          origins: [],
        },
      });
      assert.equal(saved.account.name, "测试账号");
      assert.equal(saved.account.email, "test@example.com");
      assert.match(saved.account.id, /^acc_/u);
      const auth = JSON.parse(await readFile(saved.authFile, "utf8")) as { cookies: { name: string }[] };
      assert.equal(auth.cookies[0]?.name, "SID");
      assert.equal((await store.active())?.id, saved.account.id);
      await store.updateAuthState(saved.account.id, {
        state: "reauth_required",
        cookieCheckedAt: "2026-01-01T00:00:00.000Z",
        earliestCookieExpiry: "2026-01-08T00:00:00.000Z",
        lastRefreshAt: "2026-01-01T00:00:01.000Z",
        lastRefreshError: null,
        reauthUrl: "https://accounts.google.com/ServiceLogin",
      });
      const restored = await new AccountStore(directory).active();
      assert.equal(restored?.auth_state, "reauth_required");
      assert.equal(restored?.earliest_cookie_expiry, "2026-01-08T00:00:00.000Z");
      assert.match(restored?.reauth_url ?? "", /accounts\.google\.com/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
