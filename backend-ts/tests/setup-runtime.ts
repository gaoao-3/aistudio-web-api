import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试不能读取项目运行目录中的真实账号、Cookie、统计或 API 密钥。
// 通过 --import 在所有测试模块加载前设置路径，避免测试顺序和本机状态互相影响。
const testRuntimeRoot = mkdtempSync(join(tmpdir(), "aistudio-api-ts-tests-"));

process.env.AISTUDIO_RUNTIME_ROOT = testRuntimeRoot;
process.env.AISTUDIO_ACCOUNTS_DIR = join(testRuntimeRoot, "accounts");
process.env.AISTUDIO_STATS_FILE = join(testRuntimeRoot, "stats.json");
process.env.AISTUDIO_APIKEYS_FILE = join(testRuntimeRoot, "apikeys.json");
// 测试里淘汰宽限期设为 0（立即淘汰），保证 LRU 淘汰用例的确定性；宽限期行为有单独的测试覆盖
process.env.AISTUDIO_BROWSER_EVICT_GRACE_MS = "0";
delete process.env.AISTUDIO_AUTH_FILE;
delete process.env.AISTUDIO_API_KEY;
delete process.env.AISTUDIO_API_KEYS;

process.once("exit", () => {
  try {
    rmSync(testRuntimeRoot, { recursive: true, force: true });
  } catch {
    // Windows 上未关闭的 SQLite 句柄会锁住文件；留给系统临时目录清理即可
  }
});
