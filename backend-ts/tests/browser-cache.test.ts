import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanBrowserCaches } from "../src/gateway/browser-cache.js";

test("cleanBrowserCaches removes disposable caches and preserves login data", async () => {
  const root = await mkdtemp(join(tmpdir(), "aistudio-browser-cache-"));
  try {
    await Promise.all([
      mkdir(join(root, "GrShaderCache"), { recursive: true }),
      mkdir(join(root, "Default", "Code Cache", "js"), { recursive: true }),
      mkdir(join(root, "Default", "GPUCache"), { recursive: true }),
      mkdir(join(root, "Profile 1", "Cache"), { recursive: true }),
      mkdir(join(root, "Default", "Local Storage"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "GrShaderCache", "data"), "cache"),
      writeFile(join(root, "Default", "Code Cache", "js", "data"), "cache"),
      writeFile(join(root, "Default", "Cookies"), "session"),
      writeFile(join(root, "Default", "Local Storage", "state"), "login"),
    ]);

    await cleanBrowserCaches(root);

    await assert.rejects(readFile(join(root, "GrShaderCache", "data")));
    await assert.rejects(
      readFile(join(root, "Default", "Code Cache", "js", "data")),
    );
    assert.equal(
      await readFile(join(root, "Default", "Cookies"), "utf8"),
      "session",
    );
    assert.equal(
      await readFile(join(root, "Default", "Local Storage", "state"), "utf8"),
      "login",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
