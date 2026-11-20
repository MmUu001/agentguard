/**
 * W11 验收 · audit 输出的完整性（管道场景）与参数校验
 *
 * 背景：子命令用 `process.exit()` 收尾，stdout 若是管道（>64KB）存在被截断的理论风险。
 * 实测 Node 24 会冲刷干净，但 engines 声明 >=20，所以既加了显式 flush，也要有测试锁住
 * 「大输出不丢行」这个行为。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = join(ROOT, 'dist', 'main.js');
const NODE = process.execPath;

const dir = mkdtempSync(join(tmpdir(), 'ag-export-'));
const auditDir = join(dir, 'audit');
mkdirSync(auditDir, { recursive: true });

const N = 5000;
const rows = [];
for (let i = 0; i < N; i++) {
  rows.push(
    JSON.stringify({
      ts: new Date(1763000000000 + i * 1000).toISOString(),
      reqId: i,
      tool: i % 2 === 0 ? 'read_file' : 'bash',
      args: { path: './src/index.ts', note: 'x'.repeat(40) },
      decision: i % 3 === 0 ? 'deny' : 'allow',
      ruleId: i % 3 === 0 ? 'secrets-read-env' : 'base-allow-read',
      reason: null,
      ms: 0.01,
      session: 'abcd',
      agent: 'export-check',
    }),
  );
}
writeFileSync(join(auditDir, '2026-11-19.jsonl'), rows.join('\n') + '\n', 'utf8');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

function run(args) {
  return new Promise((res) => {
    const proc = spawn(NODE, [MAIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTGUARD_AUDIT_DIR: auditDir, AGENTGUARD_LOG: 'silent' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => res({ code, stdout, stderr }));
  });
}

console.log('agentguard · audit 输出与参数校验\n');

/* ---- 大输出不截断 ---- */
const csv = await run(['audit', 'export', '--format', 'csv']);
const csvRows = csv.stdout.split('\n').filter((l) => l !== '').length;
check('CSV 导出 5000 行不被截断', csvRows === N + 1, `${csvRows} 行 / ${Buffer.byteLength(csv.stdout)} 字节`);

const jsonl = await run(['audit', 'export', '--format', 'jsonl']);
const jsonlRows = jsonl.stdout.split('\n').filter((l) => l !== '').length;
check('JSONL 导出 5000 行不被截断', jsonlRows === N, `${jsonlRows} 行`);

const listAll = await run(['audit', 'list', '--json', '--limit', '5000']);
const listRows = listAll.stdout.split('\n').filter((l) => l !== '').length;
check('list --json 全量输出', listRows === N, `${listRows} 行`);

/* ---- 参数校验（写错要明确报错，不能静默返回空） ---- */
const badDecision = await run(['audit', 'list', '--decision', 'xyz']);
check(
  '--decision 非法值 → 退出码 2 且有明确提示',
  badDecision.code === 2 && badDecision.stderr.includes('只支持 allow / deny / ask'),
);

const badFormat = await run(['audit', 'export', '--format', 'xml']);
check('--format 非法值 → 退出码 2', badFormat.code === 2 && badFormat.stderr.includes('只支持 csv / jsonl'));

const badSince = await run(['audit', 'list', '--since', 'not-a-date']);
check('--since 非法值 → 退出码 2', badSince.code === 2);

/* ---- 帮助 ---- */
const subHelp = await run(['audit', 'list', '--help']);
check('audit list --help → 退出码 0 且打印用法', subHelp.code === 0 && subHelp.stdout.includes('audit <command>'));

/* ---- 过滤正确性 ---- */
const onlyDeny = await run(['audit', 'list', '--json', '--decision', 'deny', '--limit', '5000']);
const denyRows = onlyDeny.stdout
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l));
check(
  '--decision deny 只返回 deny',
  denyRows.length > 0 && denyRows.every((r) => r.decision === 'deny'),
  `${denyRows.length} 条`,
);

const onlyBash = await run(['audit', 'list', '--json', '--tool', 'bash', '--limit', '5000']);
const bashRows = onlyBash.stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
check(
  '--tool 过滤正确',
  bashRows.length > 0 && bashRows.every((r) => r.tool === 'bash'),
  `${bashRows.length} 条`,
);

rmSync(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
