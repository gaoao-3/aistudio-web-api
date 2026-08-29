import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AccountRuntimeLease } from "../src/gateway/account-runtime-lease.js";

test("account runtime lease prevents concurrent profile owners and releases cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-runtime-lease-"));
  const path = join(directory, "runtime.lock");
  try {
    const first = await AccountRuntimeLease.acquire(path);
    await assert.rejects(
      () => AccountRuntimeLease.acquire(path),
      /already leased by PID/u,
    );
    const stored = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    assert.equal(stored.pid, process.pid);
    await first.release();
    const second = await AccountRuntimeLease.acquire(path);
    await second.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("account runtime lease reclaims a malformed stale lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-runtime-stale-"));
  const path = join(directory, "runtime.lock");
  try {
    await writeFile(path, "stale", "utf8");
    const lease = await AccountRuntimeLease.acquire(path);
    await lease.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
