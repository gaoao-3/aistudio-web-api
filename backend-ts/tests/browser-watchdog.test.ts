import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright-core";
import { settings } from "../src/config.js";
import { NativeBrowserSession } from "../src/gateway/browser-session.js";

test("watchdog resets the session and releases the queue when an operation hangs", async () => {
  const root = await mkdtemp(join(tmpdir(), "aistudio-browser-watchdog-"));
  const original = settings.browserWatchdogTimeoutMs;
  settings.browserWatchdogTimeoutMs = 50;
  try {
    const session = new NativeBrowserSession(join(root, "auth.json"));
    let closes = 0;
    const fakeContext = {
      close: async () => {
        closes += 1;
      },
    } as BrowserContext;
    (session as unknown as { context: BrowserContext }).context = fakeContext;

    // A renderer freeze makes the first operation never settle.
    const hung = session.runExclusive(
      () => new Promise<string>(() => undefined),
    );
    const queued = session.runExclusive(async () => "second");

    await assert.rejects(hung, /watchdog timed out/);
    assert.equal(
      await queued,
      "second",
      "queued operation runs after the wedged one is evicted",
    );
    assert.equal(closes, 1, "watchdog force-closes the browser context");
  } finally {
    settings.browserWatchdogTimeoutMs = original;
    await rm(root, { recursive: true, force: true });
  }
});

test("watchdog is disabled when configured to 0", async () => {
  const root = await mkdtemp(join(tmpdir(), "aistudio-browser-watchdog-"));
  const original = settings.browserWatchdogTimeoutMs;
  settings.browserWatchdogTimeoutMs = 0;
  try {
    const session = new NativeBrowserSession(join(root, "auth.json"));
    const result = await session.runExclusive(async () => "ok");
    assert.equal(result, "ok");
  } finally {
    settings.browserWatchdogTimeoutMs = original;
    await rm(root, { recursive: true, force: true });
  }
});
