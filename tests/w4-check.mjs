/**
 * W4 验收 —— 审计与观察模式。
 *
 * 验收原文：`agentguard init --observe` 跑一天，能导出「agent 到底执行了哪些命令」。
 * init 在 W5，这里验证同一条链路的可观测部分：
 *   1. 每次判定都落一行 JSONL，字段完整（ts / reqId / tool / args / decision / ruleId / ms / session / agent）
 *   2. agent 名来自 initialize 的 clientInfo，不是瞎猜的
 *   3. 参数被截断，日志不会一条几 MB
 *   4. dry_run 记录 raw，观察模式下能看到「本会拦什么」
 *   5. 限流真的执行并落审计
 *   6. list / stats / export 三个查询命令可用
 *   7. 保留期清理按文件名工作，非审计文件不动
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from './lib/client.mjs';
import { AuditWriter, dayKey } from '../dist/audit/writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const FIXTURE = resolve(HERE, 'fixtures', 'mock-mcp-server.mjs');
const TMP = join(ROOT, '.tmp', 'w4');
const NODE = process.execPath;

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const AUDIT = join(TMP, 'audit');

const POLICY = join(TMP, 'policy.yaml');
writeFileSync(
  POLICY,
  `version: 1
defaults:
  on_no_match: deny
rules:
  - id: allow-echo
    match: { tool: echo }
    decision: allow
  - id: allow-tools
    match: { tool: [big, split, sample, crash, quit] }
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
    reason: 强制推送
limits:
  - tool: split
    max_calls: 2
    window: 1h
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
    reason: 危险命令
`,
);

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: { roots: { listChanged: true }, sampling: {} },
  clientInfo: { name: 'w4-check', version: '0.0.0' },
};

const AUDIT_ENV = { AGENTGUARD_AUDIT_DIR: AUDIT, AGENTGUARD_LOG: 'silent' };

function start({ policy = POLICY, env = AUDIT_ENV } = {}) {
  const args = [MAIN, '--policy', policy, '--', NODE, FIXTURE];
  const proc = spawn(NODE, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  return new McpClient(proc);
}

function readAudit(dir = AUDIT) {
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (line.trim() !== '') records.push(JSON.parse(line));
    }
  }
  return records;
}

function runCli(args, env = AUDIT_ENV) {
  return new Promise((res) => {
    const proc = spawn(NODE, [MAIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      res({ code: 'timeout', stdout, stderr });
    }, 30000);
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

console.log('agentguard W4 acceptance\n');

/* ---------------- 1. 记录完整性 ---------------- */
let c = start();
try {
  await c.request('initialize', INIT);
  c.notify('notifications/initialized');

  await c.call('echo', { command: 'ls -la' });
  await c.call('echo', { command: 'rm -rf /' });
  await c.call('echo', { command: 'git push --force origin main' });
  await c.call('unknown_tool', { x: 1 });
  await c.call('echo', { command: 'x'.repeat(5000) });

  check('stdout 无协议外噪声', c.invalidLines.length === 0);
  await c.close();
} catch (err) {
  check('记录完整性', false, err.message);
  c.kill();
}

const records = readAudit();
check('按天切分的 JSONL 文件已生成', existsSync(AUDIT) && readdirSync(AUDIT).some((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)));
check('每次判定都落一行（5 次调用）', records.length === 5, `${records.length} 行`);

const first = records[0] ?? {};
check(
  '字段完整：ts / reqId / tool / args / decision / ruleId / ms / session / agent',
  ['ts', 'reqId', 'tool', 'args', 'decision', 'ruleId', 'ms', 'session', 'agent'].every((k) => k in first),
  Object.keys(first).join(','),
);
check('ts 是 ISO 8601', typeof first.ts === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(first.ts));
check('agent 来自 clientInfo（不是瞎猜）', first.agent === 'w4-check', String(first.agent));
check('session 是 4 位十六进制', typeof first.session === 'string' && /^[0-9a-f]{4}$/.test(first.session), String(first.session));
check('ms 是数字', typeof first.ms === 'number');

check(
  '判定序列 allow → deny → ask → deny → allow',
  records.map((r) => r.decision).join(',') === 'allow,deny,ask,deny,allow',
  records.map((r) => r.decision).join(','),
);
check('deny 记录带规则 id 与原因', records[1]?.ruleId === 'block-rm' && records[1]?.reason === '危险命令');
check('ask 记录原样保留 ask（便于事后统计「差点被拦」）', records[2]?.decision === 'ask');
check('fail-closed 记录 ruleId 为 null', records[3]?.ruleId === null);

const truncated = records[4] ?? {};
const argText = JSON.stringify(truncated.args ?? {});
check(
  '超长参数被截断（<= 250 字符）',
  truncated.truncated === true && argText.length <= 250,
  `${argText.length} 字符`,
);

/* ---------------- 2. dry_run 观察模式 ---------------- */
c = start({ policy: DRY });
try {
  await c.request('initialize', INIT);
  const r = await c.call('echo', { command: 'rm -rf /' });
  check('dry_run：调用真的放行了', !r.msg.error);
  await c.close();
} catch (err) {
  check('dry_run：调用真的放行了', false, err.message);
  c.kill();
}

const dryRecords = readAudit().slice(5);
check(
  'dry_run：记录 decision=allow 且 raw=deny、dryRun=true',
  dryRecords[0]?.decision === 'allow' && dryRecords[0]?.raw === 'deny' && dryRecords[0]?.dryRun === true,
  JSON.stringify({ decision: dryRecords[0]?.decision, raw: dryRecords[0]?.raw, dryRun: dryRecords[0]?.dryRun }),
);

/* ---------------- 3. 限流 ---------------- */
c = start();
try {
  await c.request('initialize', INIT);
  const a = await c.call('split', {});
  const b = await c.call('split', {});
  const third = await c.call('split', {});
  check('限流：前 2 次放行', !a.msg.error && !b.msg.error);
  check(
    '限流：第 3 次回 -32004',
    third.msg.error?.code === -32004,
    `${third.msg.error?.code} ${third.msg.error?.message ?? ''}`,
  );
  await c.close();
} catch (err) {
  check('限流：第 3 次回 -32004', false, err.message);
  c.kill();
}

const limited = readAudit().find((r) => r.reason?.startsWith?.('限流'));
check('限流拒绝也落审计', limited !== undefined && limited.decision === 'deny', String(limited?.reason));

/* ---------------- 4. 查询命令 ---------------- */
{
  const list = await runCli(['audit', 'list', '--limit', '3']);
  const dataRows = list.stdout.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(l));
  check('audit list --limit 3 恰好 3 行数据', list.code === 0 && dataRows.length === 3, `${dataRows.length} 行`);

  const denials = await runCli(['audit', 'list', '--json', '--decision', 'deny', '--limit', '50']);
  const denialRecords = denials.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check(
    'audit list --decision deny 全是 deny',
    denials.code === 0 && denialRecords.length > 0 && denialRecords.every((r) => r.decision === 'deny'),
    `${denialRecords.length} 条`,
  );

  const json = await runCli(['audit', 'list', '--json', '--limit', '3']);
  const jsonLines = json.stdout.trim().split('\n').filter(Boolean);
  check(
    'audit list --json 输出可解析的 JSONL',
    jsonLines.length === 3 && jsonLines.every((l) => JSON.parse(l).ts !== undefined),
  );

  const stats = await runCli(['audit', 'stats', '--since', '1d']);
  check(
    'audit stats 聚合出判定与规则分布',
    stats.code === 0 && stats.stdout.includes('总计') && stats.stdout.includes('按规则') && stats.stdout.includes('block-rm'),
  );

  const csv = await runCli(['audit', 'export', '--format', 'csv']);
  const csvLines = csv.stdout.trim().split('\n');
  check(
    'audit export --format csv 有表头且列数一致',
    csv.code === 0 && csvLines[0] === 'ts,reqId,tool,decision,raw,ruleId,ms,session,agent,args' && csvLines.every((l) => l.split(',').length >= 10),
    `${csvLines.length - 1} 行数据`,
  );

  const jsonl = await runCli(['audit', 'export', '--format', 'jsonl']);
  check('audit export --format jsonl 逐行可解析', jsonl.stdout.trim().split('\n').every((l) => JSON.parse(l).ts));

  const badSince = await runCli(['audit', 'list', '--since', 'someday']);
  check('非法 --since → 退出码 2', badSince.code === 2, badSince.stderr.split('\n')[0]);

  const help = await runCli(['audit', '--help']);
  check('audit --help → 退出码 0', help.code === 0 && help.stdout.includes('list'));
}

/* ---------------- 5. 保留期清理 ---------------- */
{
  writeFileSync(join(AUDIT, '2020-01-01.jsonl'), '{"ts":"2020-01-01T00:00:00.000Z"}\n');
  writeFileSync(join(AUDIT, 'notes.txt'), 'do not touch\n');

  c = start();
  await c.request('initialize', INIT);
  await c.call('echo', { command: 'ls' });
  await c.close();

  const names = readdirSync(AUDIT);
  check('超过保留期的审计文件被删除', !names.includes('2020-01-01.jsonl'));
  check('非审计文件不被误删', names.includes('notes.txt'));
  check('当天的文件保留', names.some((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)));
}

/* ---------------- 6. 写入开销（不阻塞转发） ---------------- */
{
  const bench = join(TMP, 'bench');
  const writer = new AuditWriter(bench);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) {
    writer.write({
      ts: new Date().toISOString(),
      reqId: i,
      tool: 'bash',
      args: { command: 'ls -la' },
      decision: 'allow',
      ruleId: null,
      reason: null,
      ms: 0.01,
      session: 'abcd',
      agent: 'bench',
    });
  }
  const perCall = Number(process.hrtime.bigint() - t0) / 1e6 / 1000;
  await writer.close();

  const file = join(bench, `${dayKey()}.jsonl`);
  const written = readFileSync(file, 'utf8').trim().split('\n').length;
  check(
    '审计写入不阻塞转发（1000 条入队 < 0.1ms/条，且全部落盘）',
    perCall < 0.1 && written === 1000,
    `${perCall.toFixed(4)} ms/条, ${written} 行`,
  );
}

/* ---------------- 7. 关闭审计 ---------------- */{
  const freshDir = join(TMP, 'audit-off');
  c = start({ env: { AGENTGUARD_AUDIT_DIR: freshDir, AGENTGUARD_AUDIT: 'off', AGENTGUARD_LOG: 'silent' } });
  await c.request('initialize', INIT);
  await c.call('echo', { command: 'ls' });
  await c.close();
  check('AGENTGUARD_AUDIT=off 时不创建审计目录', !existsSync(freshDir));
}

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
