import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

const ROOT_CACHE_DIRECTORIES = [
  "DawnCache",
  "GPUCache",
  "GrShaderCache",
  "GraphiteDawnCache",
  "ShaderCache",
] as const;

const PROFILE_CACHE_DIRECTORIES = [
  "Cache",
  "Code Cache",
  "DawnCache",
  "GPUCache",
] as const;

async function removeDirectories(
  parent: string,
  names: readonly string[],
): Promise<void> {
  await Promise.all(
    names.map((name) =>
      rm(join(parent, name), { recursive: true, force: true }),
    ),
  );
}

/** Removes Chromium's disposable caches without touching cookies or browser storage. */
export async function cleanBrowserCaches(profileRoot: string): Promise<void> {
  await removeDirectories(profileRoot, ROOT_CACHE_DIRECTORIES);

  const entries = await readdir(profileRoot, { withFileTypes: true }).catch(
    () => [],
  );
  const browserProfiles = entries.filter(
    (entry) =>
      entry.isDirectory() &&
      (entry.name === "Default" || /^Profile \d+$/u.test(entry.name)),
  );
  await Promise.all(
    browserProfiles.map((entry) =>
      removeDirectories(
        join(profileRoot, entry.name),
        PROFILE_CACHE_DIRECTORIES,
      ),
    ),
  );
}
