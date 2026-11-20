/**
 * W3 验收 —— 判定接入与拒绝路径。
 *
 * 验收原文：被拦的调用在 agent 里显示为明确的错误，而不是卡住或崩溃。
 * 这里把它拆成可观测的断言：
 *   1. allow → 上游照常执行，响应原样回来
 *   2. deny  → 回 -32001 且带 ruleId，**上游根本没收到这条调用**
 *   3. 未命中规则 → 回 -32001，ruleId 为 null（fail-closed 真的生效）
 *   4. ask   → 明确拒绝并说明「无审批通道」，绝不静默放行
 *   5. 拦完之后代理仍然活着（不是崩了）
 *   6. 无 id 的通知被丢弃且不影响后续
 *   7. 上游崩溃时未完成的请求收到 -32603，client 不会一直等
 *   8. 策略加载失败 / 文件不存在 → 退出码 2，且上游根本没被启动
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from './lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const FIXTURE = resolve(HERE, 'fixtures', 'mock-mcp-server.mjs');
const TMP = join(ROOT, '.tmp', 'w3');
const NODE = process.execPath;

// 这些用例只验证转发/判定，不让它们在真实家目录里写审计
process.env.AGENTGUARD_AUDIT = 'off';

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

mkdirSync(TMP, { recursive: true });

const POLICY = join(TMP, 'w3.yaml');
writeFileSync(
  POLICY,
  `version: 1

defaults:
  on_no_match: deny

rules:
  - id: allow-tools
    match:
      tool: [echo, big, split, sample, crash, quit]
    decision: allow

  - id: block-rm
    match:
      tool: echo
      args.command: { regex: 'rm -rf' }
    decision: deny
    reason: 危险命令

  - id: ask-force
    match:
      tool: echo
      args.command: { prefix: 'git push --force' }
    decision: ask
    reason: 强制推送会覆盖远端历史

  - id: block-secret
    match:
      tool: echo
      args.path: { glob: '**/.env*' }
    decision: deny
    reason: 凭据文件

  - id: block-crash-probe
    match:
      tool: crash
      args.reason: { prefix: 'nope' }
    decision: deny
`,
);

const DRY = join(TMP, 'dry.yaml');
writeFileSync(
  DRY,
  `version: 1
defaults:
  dry_run: true
rules:
  - id: block-rm
    match:
      tool: echo
      args.command: { regex: 'rm -rf' }
    decision: deny
`,
);

const BROKEN = join(TMP, 'broken.yaml');
writeFileSync(BROKEN, "version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.x: { regex: '([' }\n    decision: deny\n");

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: { roots: { listChanged: true }, sampling: {} },
  clientInfo: { name: 'w3-check', version: '0.0.0' },
};

function start({ policy = POLICY, env, command = [NODE, FIXTURE] } = {}) {
  const args = [MAIN];
  if (policy !== null) args.push('--policy', policy);
  args.push('--', ...command);
  const proc = spawn(NODE, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
  return new McpClient(proc);
}

function runNode(args, env) {
  return new Promise((res) => {
    const proc = spawn(NODE, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env === undefined ? process.env : { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      res({ code: 'timeout', stdout, stderr });
    }, 20000);
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

console.log('agentguard W3 acceptance\n');

/* ---------------- 1. allow 路径 ---------------- */
let c = start();
try {
  await c.request('initialize', INIT);
  c.notify('notifications/initialized');

  const ok = await c.call('echo', { command: 'ls -la' });
  const text = ok.msg.result?.content?.[0]?.text ?? '';
  check('allow：上游正常执行并原样返回', !ok.msg.error && text.includes('ls -la'), text.slice(0, 40));

  /* ---------- 2. deny 路径 ---------- */
  const denied = await c.call('echo', { command: 'rm -rf /' });
  const err = denied.msg.error;
  check(
    'deny：回 -32001 且带 ruleId',
    err?.code === -32001 && err.data?.ruleId === 'block-rm',
    `${err?.code} / ${err?.data?.ruleId}`,
  );
  check('deny：错误信息可读（不是空 message）', typeof err?.message === 'string' && err.message.includes('Blocked by policy block-rm'));
  check(
    'deny：上游没有执行这条调用（返回的不是 echo 结果）',
    denied.msg.result === undefined && typeof err?.message === 'string',
  );

  /* ---------- 3. fail-closed ---------- */
  const unmatched = await c.call('some_unknown_tool', { x: 1 });
  check(
    '未命中规则 → -32001 且 ruleId 为 null',
    unmatched.msg.error?.code === -32001 && unmatched.msg.error.data.ruleId === null,
    String(unmatched.msg.error?.message),
  );

  /* ---------- 4. ask ---------- */
  const asked = await c.call('echo', { command: 'git push --force origin main' });
  check(
    'ask → 明确拒绝并说明无审批通道',
    asked.msg.error?.code === -32001 && asked.msg.error.message.includes('需要人工确认'),
    String(asked.msg.error?.data?.decision),
  );
  check('ask 的审计数据保留原始判定', asked.msg.error?.data?.decision === 'ask');

  /* ---------- 5. glob 规则经代理生效 ---------- */
  const secret = await c.call('echo', { path: 'C:\\Users\\me\\.env' });
  check('Windows 路径命中 protect 规则', secret.msg.error?.data?.ruleId === 'block-secret');

  /* ---------- 6. 拦完之后代理仍然可用 ---------- */
  const after = await c.call('echo', { command: 'pwd' });
  check('连续拦截后代理仍正常工作', !after.msg.error && after.msg.result?.content[0].text.includes('pwd'));

  /* ---------- 7. 无 id 的通知被丢弃且不影响后续 ---------- */
  c.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'crash', arguments: { reason: 'nope' } } });
  const afterNotify = await c.call('echo', { command: 'true' });
  check(
    '被拒的通知被丢弃（上游未收到，没被 crash 杀死）',
    !afterNotify.msg.error && afterNotify.msg.result?.content[0].text.includes('true'),
  );

  /* ---------- 8. 2 MiB 大调用在有策略时仍然通畅 ---------- */
  const big = await c.call('big', { text: 'x'.repeat(2 * 1024 * 1024) });
  check('2 MiB 参数在策略链路下不截断', big.msg.result?.content?.[0]?.text === String(2 * 1024 * 1024));

  check('stdout 无协议外噪声', c.invalidLines.length === 0, JSON.stringify(c.invalidLines.slice(0, 1)));

  const exitCode = await c.close();
  check('正常关闭退出码 0', exitCode === 0, `exit=${exitCode}`);
} catch (err) {
  check('主链路', false, err.message);
  c.kill();
}

/* ---------------- 9. 上游崩溃 → 未完成请求收到 -32603 ---------------- */
try {
  c = start();
  await c.request('initialize', INIT);
  const crashed = c.call('crash', {});
  const answer = await crashed;
  check(
    '上游崩溃：未完成的 tools/call 收到 -32603',
    answer.msg.error?.code === -32603,
    String(answer.msg.error?.message),
  );
  const code = await c.exited;
  check('上游崩溃：退出码原样传回', code === 7, `exit=${code}`);
  c.kill();
} catch (err) {
  check('上游崩溃：未完成的 tools/call 收到 -32603', false, err.message);
}

/* ---------------- 10. dry_run ---------------- */
try {
  c = start({ policy: DRY });
  await c.request('initialize', INIT);
  const dry = await c.call('echo', { command: 'rm -rf /' });
  check(
    'dry_run：危险调用被放行（只记录不拦截）',
    !dry.msg.error && dry.msg.result?.content[0].text.includes('rm -rf'),
  );
  await c.close();
} catch (err) {
  check('dry_run：危险调用被放行（只记录不拦截）', false, err.message);
}

/* ---------------- 11. 无策略文件 → deny-all + 告警 ---------------- */
try {
  const fakeHome = join(TMP, 'home');
  mkdirSync(fakeHome, { recursive: true });
  c = start({ policy: null, env: { USERPROFILE: fakeHome, HOME: fakeHome } });
  await c.request('initialize', INIT);
  const r = await c.call('echo', { command: 'ls' });
  check(
    '没有策略文件时以 deny-all 启动（不放行）',
    r.msg.error?.code === -32001 && r.msg.error.data.ruleId === null,
  );
  check('并且 stderr 有明确告警', c.stderr.includes('deny-all'), c.stderr.split('\n')[0]?.slice(0, 80));
  await c.close();
} catch (err) {
  check('没有策略文件时以 deny-all 启动（不放行）', false, err.message);
}

/* ---------------- 12. 策略写错 → 拒绝启动 ---------------- */
{
  const bad = await runNode([MAIN, '--policy', BROKEN, '--', NODE, FIXTURE]);
  check('策略语法错误 → 退出码 2', bad.code === 2, `exit=${bad.code}`);
  check('错误信息指出是哪条规则/哪个字段', bad.stderr.includes('regex 无效'), bad.stderr.split('\n').slice(0, 2).join(' ').slice(0, 120));
  check('失败时 stdout 完全干净', bad.stdout === '', JSON.stringify(bad.stdout.slice(0, 60)));
}
{
  const missing = await runNode([MAIN, '--policy', join(TMP, 'nope.yaml'), '--', NODE, FIXTURE]);
  check('策略文件不存在 → 退出码 2', missing.code === 2, `exit=${missing.code}`);
}
{
  // 策略在 spawn 上游之前加载：命令名不存在时，报的仍然是策略错误
  const order = await runNode([MAIN, '--policy', BROKEN, '--', 'definitely-not-a-real-command-xyz']);
  check(
    '策略先于 upstream 加载（报策略错误而不是 ENOENT）',
    order.code === 2 && order.stderr.includes('策略加载失败'),
    `exit=${order.code}`,
  );
}
{
  const unknown = await runNode([MAIN, '--nope', '--', NODE, FIXTURE]);
  check('未知选项 → 退出码 2', unknown.code === 2, `exit=${unknown.code}`);
}

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
