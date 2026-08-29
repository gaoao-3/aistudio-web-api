import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { BrowserContext } from "playwright-core";
import { NativeBrowserSession } from "../src/gateway/browser-session.js";

const wait = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("idle close waits until all queued browser operations finish", async () => {
  const root = await mkdtemp(join(tmpdir(), "aistudio-browser-idle-"));
  try {
    const session = new NativeBrowserSession(join(root, "auth.json"));
    (session as unknown as { idleTimeoutMs: number }).idleTimeoutMs = 25;
    let closes = 0;
    const fakeContext = {
      close: async () => {
        closes += 1;
      },
    } as BrowserContext;
    (session as unknown as { context: BrowserContext }).context = fakeContext;

    const first = session.runExclusive(async () => {
      await wait(35);
    });
    const second = session.runExclusive(async () => {
      await wait(20);
    });
    await wait(40);
    assert.equal(closes, 0, "must not close while a queued operation remains");

    await Promise.all([first, second]);
    await wait(45);
    assert.equal(
      closes,
      1,
      "closes once after the complete queue becomes idle",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new operation cancels a pending idle close", async () => {
  const root = await mkdtemp(join(tmpdir(), "aistudio-browser-idle-"));
  try {
    const session = new NativeBrowserSession(join(root, "auth.json"));
    (session as unknown as { idleTimeoutMs: number }).idleTimeoutMs = 35;
    let closes = 0;
    const fakeContext = {
      close: async () => {
        closes += 1;
      },
    } as BrowserContext;
    (session as unknown as { context: BrowserContext }).context = fakeContext;

    await session.runExclusive(async () => undefined);
    await wait(20);
    await session.runExclusive(async () => undefined);
    await wait(25);
    assert.equal(closes, 0);
    await wait(25);
    assert.equal(closes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("idle close can be disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "aistudio-browser-idle-"));
  try {
    const session = new NativeBrowserSession(join(root, "auth.json"));
    (session as unknown as { idleTimeoutMs: number }).idleTimeoutMs = 0;
    let closes = 0;
    const fakeContext = {
      close: async () => {
        closes += 1;
      },
    } as BrowserContext;
    (session as unknown as { context: BrowserContext }).context = fakeContext;

    await session.runExclusive(async () => undefined);
    await wait(30);
    assert.equal(closes, 0);
    await session.close();
    assert.equal(closes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
