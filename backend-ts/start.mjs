// Node 版启动器：替代 start.ps1，避免脚本依赖 powershell 在 PATH 中可被解析。
// 用法: node backend-ts/start.mjs [--skip-build] [--port <port>]
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendRoot = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(backendRoot, '..');

const args = process.argv.slice(2);
const skipBuild = args.some((a) => a === '--skip-build' || a === '--skipBuild' || a === '-SkipBuild');
const portArg = args.indexOf('--port');
const port = portArg !== -1 ? args[portArg + 1] : process.env.AISTUDIO_PORT ?? '3006';

const runtimeRoot = resolve(process.env.AISTUDIO_RUNTIME_ROOT ?? projectRoot);
process.env.AISTUDIO_RUNTIME_ROOT = runtimeRoot;
process.env.AISTUDIO_PORT = String(port);
process.env.AISTUDIO_ACCOUNTS_DIR = join(runtimeRoot, 'data', 'accounts');

const registryPath = join(runtimeRoot, 'data', 'accounts', 'registry.json');
if (existsSync(registryPath)) {
  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (registry.active_account_id) {
      const authPath = join(runtimeRoot, 'data', 'accounts', registry.active_account_id, 'auth.json');
      if (existsSync(authPath)) process.env.AISTUDIO_AUTH_FILE = authPath;
    }
  } catch (err) {
    console.error(`[start] failed to read registry: ${err.message}`);
  }
}

if (!skipBuild) {
  const tscPath = resolve(backendRoot, 'node_modules/typescript/bin/tsc');
  if (!existsSync(tscPath)) {
    console.error('[start] typescript not found; run `pnpm --dir backend-ts install` first');
    process.exit(1);
  }
  const build = spawnSync(process.execPath, [tscPath], { cwd: backendRoot, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error('[start] TypeScript build failed');
    process.exit(build.status ?? 1);
  }
}

const server = spawn('node dist/src/server.js', { cwd: backendRoot, stdio: 'inherit', shell: true });
server.on('error', (err) => {
  console.error(`[start] failed to start server: ${err.message}`);
  process.exit(1);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.kill(sig));
}
server.on('exit', (code) => process.exit(code ?? 0));
