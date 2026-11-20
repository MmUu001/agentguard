/**
 * W9 验收 · 安装包边界与可运行性
 *
 * 发布前必须回答三个问题，这里逐条断言：
 *   1. 包里到底有什么？（不能带 src / tests / source map）
 *   2. 装到干净目录还能跑吗？（bin 可用、packs 能读到、init/check 正常）
 *   3. 安装后的代理能转发吗？
 *
 * 这一份跑通，才有资格谈 npm publish。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TMP = join(ROOT, '.tmp', 'install');
const NODE = process.execPath;
const isWin = process.platform === 'win32';

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function sh(command, cwd = ROOT) {
  return new Promise((res) => {
    const proc = spawn(command, { shell: true, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      res({ code: 'timeout', stdout, stderr });
    }, 180000);
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

console.log('agentguard W9 · 安装包边界\n');

/* ---------------- 1. 打包 ---------------- */
const packed = await sh(`npm pack --pack-destination "${TMP}"`);
const tgz = readdirSync(TMP).find((name) => name.endsWith('.tgz'));
check('npm pack 成功', packed.code === 0 && tgz !== undefined, tgz ?? packed.stderr.split('\n')[0]);

if (tgz === undefined) {
  console.log('\n0/1 passed');
  process.exit(1);
}

const tgzPath = join(TMP, tgz);
const sizeKb = statSync(tgzPath).size / 1024;
check('tarball < 200 KB', sizeKb < 200, `${sizeKb.toFixed(1)} KB`);

/* ---------------- 2. 干净目录安装 ---------------- */
const appDir = join(TMP, 'app');
const installed = await sh(`npm install "${tgzPath}" --prefix "${appDir}" --no-save --no-audit --no-fund`);
check('干净目录安装成功', installed.code === 0, installed.stderr.split('\n').filter(Boolean).pop() ?? '');

const modDir = join(appDir, 'node_modules', pkg.name);
check('包目录存在', existsSync(modDir));

/* ---------------- 3. 包内容边界 ---------------- */
function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(full.slice(base.length + 1).replace(/\\/g, '/'));
  }
  return out;
}

const files = walk(modDir);
check('包含 dist 与 packs', files.some((f) => f.startsWith('dist/')) && files.some((f) => f.startsWith('packs/')));
check('四个策略包齐全', ['core', 'secrets', 'git', 'net'].every((id) => files.includes(`packs/${id}.yaml`)));

const forbidden = files.filter((f) => /^src\//.test(f) || /^tests\//.test(f) || /\.map$/.test(f) || (f.endsWith('.ts') && !f.endsWith('.d.ts')));
check('不含 src / tests / source map / .ts', forbidden.length === 0, forbidden.slice(0, 3).join(', '));

const devOnly = files.filter((f) => /\.test\.mjs$|mock-mcp-server/.test(f));
check('不含测试夹具', devOnly.length === 0, devOnly.slice(0, 3).join(', '));

check('文件数 <= 40', files.length <= 40, `${files.length} 个文件`);

/* ---------------- 4. bin 可用 ---------------- */
const bin = isWin
  ? join(appDir, 'node_modules', '.bin', 'agentguard.cmd')
  : join(appDir, 'node_modules', '.bin', 'agentguard');
const version = await sh(`"${bin}" --version`, appDir);
check(
  `bin --version 输出 ${pkg.version}`,
  version.code === 0 && version.stdout.trim() === pkg.version,
  version.stdout.trim() || version.stderr.split('\n')[0],
);

/* ---------------- 5. init / check ---------------- */
const homeDir = join(TMP, 'home');
const init = await sh(`"${bin}" init --yes --dir "${homeDir}"`, appDir);
check('安装后 init 可用', init.code === 0 && existsSync(join(homeDir, 'policy.yaml')), `exit=${init.code}`);

const checked = await sh(`"${bin}" check --policy "${join(homeDir, 'policy.yaml')}"`, appDir);
check(
  '安装后 check 可用（能读到包里的规则）',
  checked.code === 0 && checked.stdout.includes('core-rm-rf-root') && checked.stdout.includes('secrets-read-env'),
  `exit=${checked.code}`,
);

/* ---------------- 6. 安装后的代理能转发 ---------------- */
{
  const entry = join(modDir, 'dist', 'main.js');
  const echoServer = join(TMP, 'echo-server.mjs');
  writeFileSync(echoServer, 'process.stdin.on("data", (d) => process.stdout.write(d));\nprocess.stdin.on("end", () => process.exit(0));\n');

  const proc = spawn(
    NODE,
    [entry, '--policy', join(homeDir, 'policy.yaml'), '--', NODE, echoServer],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, AGENTGUARD_AUDIT: 'off' } },
  );

  const line = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const echoed = await new Promise((res) => {
    let buf = '';
    const timer = setTimeout(() => res(null), 10000);
    proc.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      if (buf.includes('\n')) {
        clearTimeout(timer);
        res(buf.split('\n')[0]);
      }
    });
    proc.stdin.write(line + '\n');
  });

  check('安装后的代理能原样转发', echoed === line, echoed === null ? '无响应' : `${echoed.length} 字节`);
  proc.stdin.end();
  proc.kill();
}

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
