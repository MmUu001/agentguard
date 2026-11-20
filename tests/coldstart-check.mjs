/**
 * W8 验收 · 冷启动（方案 W5–6 的原始验收标准）
 *
 * 「新用户 3 分钟完成配置，且能看懂自己配了什么」这条一直没被真正计时验证过。
 * 这里在全新的 HOME 下走完整流程，并用**真实 filesystem server**证明它真的能用：
 *   init → check → 接入 → 读普通文件（放行）→ 读 .env（拦）→ 写 /etc（拦）
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from './lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const NODE = process.execPath;
const TMP = join(ROOT, '.tmp', 'coldstart');
const HOME = join(TMP, 'home');
const SANDBOX = join(TMP, 'my project');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(SANDBOX, { recursive: true });
writeFileSync(join(SANDBOX, 'app.ts'), 'export const guard = true;\n', 'utf8');
writeFileSync(join(SANDBOX, '.env'), 'STRIPE_SECRET=sk_live_donotleak\n', 'utf8');

const ENV = {
  ...process.env,
  USERPROFILE: HOME,
  HOME,
  AGENTGUARD_AUDIT: 'off',
  AGENTGUARD_LOG: 'silent',
};

function run(args, timeout = 60000) {
  return new Promise((res) => {
    const proc = spawn(NODE, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: ENV });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      res({ code: 'timeout', stdout, stderr });
    }, timeout);
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

console.log('agentguard W8 · 冷启动（全新 HOME）\n');

const started = Date.now();
const timings = {};

/* ---- 1. init ---- */
const mark1 = Date.now();
const init = await run(['init', '--yes'], 30000);
timings.init = Date.now() - mark1;

check('init 在全新 HOME 下成功', init.code === 0, `exit=${init.code}`);
const policyPath = join(HOME, '.agentguard', 'policy.yaml');
check('策略落在默认位置 ~/.agentguard/policy.yaml', init.stdout.includes(policyPath) || init.stdout.includes('.agentguard\\policy.yaml'));

/* ---- 2. 打印的配置片段可解析 ---- */
{
  const start = init.stdout.indexOf('{');
  const end = init.stdout.lastIndexOf('}');
  let parsed = null;
  try {
    parsed = JSON.parse(init.stdout.slice(start, end + 1));
  } catch {
    parsed = null;
  }
  const server = parsed?.mcpServers?.['filesystem (经 agentguard)'];
  check('init 打印的 JSON 片段可解析', parsed !== null);
  const invocationOk =
    (server?.command === 'npx' && server?.args?.some((a) => a.startsWith('agentguard'))) ||
    (server?.command === 'node' && String(server?.args?.[0]).includes('dist/main.js'));
  check(
    '片段里的启动方式与实际运行方式一致',
    invocationOk && server?.args?.includes('--policy'),
    `${server?.command} ${String(server?.args?.[0] ?? '').slice(0, 40)}`,
  );
  check('片段不包含任何自动改写（只是打印）', !init.stdout.includes('已修改') && init.stdout.includes('不会改你的配置'));
}

/* ---- 3. check ---- */
const mark2 = Date.now();
const checked = await run(['check'], 30000);
timings.check = Date.now() - mark2;

check('check 用默认路径找到策略', checked.code === 0, `exit=${checked.code}`);
check('check 打印预演', checked.stdout.includes('预演') && /deny\s+rm -rf \//.test(checked.stdout));
check('check 打印规则清单', checked.stdout.includes('core-rm-rf-root') && checked.stdout.includes('secrets-read-env'));

/* ---- 4. 接入真实 filesystem server ---- */
const mark3 = Date.now();
const proc = spawn(
  NODE,
  [MAIN, '--policy', policyPath, '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', SANDBOX],
  { stdio: ['pipe', 'pipe', 'pipe'], env: ENV },
);
const c = new McpClient(proc, { timeoutMs: 180000 });

try {
  await c.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: 'claude-code', version: '1.0.0' },
  });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  const read = await c.call('read_file', { path: join(SANDBOX, 'app.ts') });
  timings.firstCall = Date.now() - mark3;

  check(
    '真实 server：读普通文件成功（agent 不被搞瘫）',
    read.msg.result?.content?.[0]?.text?.includes('export const guard'),
  );

  const leaked = await c.call('read_file', { path: join(SANDBOX, '.env') });
  check(
    '真实 server：读 .env 被拦',
    leaked.msg.error?.code === -32001 && leaked.msg.error?.data?.ruleId === 'secrets-read-env',
    `${leaked.msg.error?.code}/${leaked.msg.error?.data?.ruleId}`,
  );

  const wrote = await c.call('write_file', { path: '/etc/hosts', content: '1.2.3.4 evil' });
  check(
    '真实 server：写 /etc/hosts 被拦',
    wrote.msg.error?.code === -32001 && wrote.msg.error?.data?.ruleId === 'core-write-system-path',
  );

  const listed = await c.call('list_directory', { path: SANDBOX });
  check('真实 server：目录列举正常', listed.msg.result?.content?.length > 0);

  check('stdout 全程无协议外噪声', c.invalidLines.length === 0, JSON.stringify(c.invalidLines.slice(0, 1)));

  await c.close();
} catch (err) {
  check('冷启动全链路', false, err.message);
  c.kill();
}

const total = Date.now() - started;

console.log('');
console.log(`  耗时  init ${timings.init}ms · check ${timings.check}ms · 到首次成功调用 ${timings.firstCall}ms · 合计 ${(total / 1000).toFixed(1)}s`);
console.log('');

check('全流程 < 180 秒（「3 分钟」验收线）', total < 180_000, `${(total / 1000).toFixed(1)}s`);

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
