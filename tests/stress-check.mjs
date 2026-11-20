/**
 * W7 验收 · 压力与编码加固
 *
 * 覆盖方案 W7–8 里「超长行 / 编码 / Windows 兼容」这一组，加上判定延迟的 P0 预算：
 *   1. 8 MiB 单行不截断、不崩
 *   2. 1000 次连续调用全部正确（含 p99 往返延迟）
 *   3. CRLF 行尾
 *   4. 行首 UTF-8 BOM（客户端/编辑器常见污染源）
 *   5. 策略文件带 BOM + CRLF 仍能加载
 *   6. 32 条规则下判定 p99 < 2ms
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from './lib/client.mjs';
import { decide } from '../dist/policy/decide.js';
import { loadPolicy } from '../dist/policy/load.js';

process.env.AGENTGUARD_AUDIT = 'off';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const FIXTURE = resolve(HERE, 'fixtures', 'mock-mcp-server.mjs');
const NODE = process.execPath;
const TMP = join(ROOT, '.tmp', 'stress');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function run(args) {
  return new Promise((res) => {
    const proc = spawn(NODE, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTGUARD_AUDIT: 'off', AGENTGUARD_LOG: 'silent' },
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

await run([MAIN, 'init', '--yes', '--packs', 'core,secrets,git,net', '--dir', join(TMP, 'home')]);
const policyPath = join(TMP, 'home', 'policy.yaml');

const extra = join(TMP, 'extra.yaml');
writeFileSync(
  extra,
  `version: 1
rules:
  - id: stress-allow
    match:
      tool: [echo, big, split, crash, quit]
    decision: allow
`,
);

function startProxy() {
  const proc = spawn(NODE, [MAIN, '--policy', policyPath, '--policy', extra, '--', NODE, FIXTURE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENTGUARD_AUDIT: 'off', AGENTGUARD_LOG: 'silent' },
  });
  return new McpClient(proc, { timeoutMs: 60000 });
}

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: { roots: {}, sampling: {} },
  clientInfo: { name: 'stress', version: '0.0.0' },
};

console.log('agentguard W7 · 压力与编码\n');

/* ---------------- 1. 8 MiB 单行 ---------------- */
{
  const c = startProxy();
  try {
    await c.request('initialize', INIT);
    const size = 8 * 1024 * 1024;
    const big = await c.call('big', { text: 'x'.repeat(size) }, 120000);
    check(
      '8 MiB 单行不截断',
      big.msg.result?.content?.[0]?.text === String(size),
      `回显长度 ${big.msg.result?.content?.[0]?.text ?? 'n/a'}`,
    );
    await c.close();
  } catch (err) {
    check('8 MiB 单行不截断', false, err.message);
    c.kill();
  }
}

/* ---------------- 2. 1000 次连续调用 ---------------- */
{
  const c = startProxy();
  try {
    await c.request('initialize', INIT);
    const rounds = 1000;
    const samples = [];
    const started = process.hrtime.bigint();
    let okCount = 0;

    for (let i = 0; i < rounds; i++) {
      const t0 = process.hrtime.bigint();
      const r = await c.call('echo', { command: `echo ${i}` });
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (r.msg.result?.content?.[0]?.text?.includes(`echo ${i}`)) okCount += 1;
    }

    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    samples.sort((a, b) => a - b);
    const p50 = samples[Math.floor(rounds * 0.5)];
    const p99 = samples[Math.floor(rounds * 0.99)];

    check(`1000 次连续调用全部正确`, okCount === rounds, `${okCount}/${rounds}`);
    check('往返 p99 < 20ms', p99 < 20, `p50=${p50.toFixed(2)}ms p99=${p99.toFixed(2)}ms 总耗时 ${elapsed.toFixed(0)}ms`);

    // 跑完还能继续用：说明没有句柄泄漏 / 状态被污染
    const after = await c.call('echo', { command: 'still-alive' });
    check('1000 次之后代理仍正常', after.msg.result?.content?.[0]?.text?.includes('still-alive'));
    await c.close();
  } catch (err) {
    check('1000 次连续调用全部正确', false, err.message);
    c.kill();
  }
}

/* ---------------- 3. CRLF 行尾 ---------------- */
{
  const c = startProxy();
  try {
    // id 用 100 避开 McpClient 内部自增的 id（否则响应会被错配）
    c.proc.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'initialize', params: INIT }) + '\r\n',
    );
    const init = await c.request('tools/list', {});
    check('CRLF 行尾不影响解析', init.msg.result?.tools?.length > 0);
    await c.close();
  } catch (err) {
    check('CRLF 行尾不影响解析', false, err.message);
    c.kill();
  }
}

/* ---------------- 4. 行首 BOM ---------------- */
{
  const c = startProxy();
  try {
    await c.request('initialize', INIT);

    // 带 BOM 的危险调用：判定生效说明闸门正确解析了它（否则会被原样转发、由 upstream 报"没有这个工具"）
    const line =
      '\uFEFF' +
      JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'bash', arguments: { command: 'rm -rf /' } },
      }) +
      '\n';
    c.proc.stdin.write(Buffer.from(line, 'utf8'));

    const answer = await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('BOM 行没有产生响应')), 10000);
      c.proc.stdout.once('data', (chunk) => {
        clearTimeout(timer);
        const text = chunk.toString('utf8');
        const lineOut = text.split('\n').find((l) => l.includes('"id":99'));
        res(lineOut === undefined ? null : JSON.parse(lineOut.trim()));
      });
    });

    check(
      '行首 BOM 不影响判定（仍被策略拦住）',
      answer?.error?.code === -32001 && answer?.error?.data?.ruleId === 'core-rm-rf-root',
      String(answer?.error?.code),
    );
    await c.close();
  } catch (err) {
    check('行首 BOM 不影响判定（仍被策略拦住）', false, err.message);
    c.kill();
  }
}

/* ---------------- 5. 策略文件带 BOM + CRLF ---------------- */
{
  const source = (await import('node:fs')).readFileSync(policyPath, 'utf8');
  const mangled = join(TMP, 'policy-bom.yaml');
  writeFileSync(mangled, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source.replace(/\n/g, '\r\n'), 'utf8')]));

  const out = await run([MAIN, 'check', '--policy', mangled]);
  check('策略文件带 BOM + CRLF 仍能加载', out.code === 0 && out.stdout.includes('core-rm-rf-root'), `exit=${out.code}`);
}

/* ---------------- 6. 判定延迟（32 条规则） ---------------- */
{
  const policy = loadPolicy([policyPath, extra]);
  check('全量策略规则数 >= 30', policy.rules.length >= 30, `${policy.rules.length} 条`);

  const rounds = 2000;
  const times = [];
  for (let i = 0; i < rounds; i++) {
    times.push(decide(policy, 'bash', { command: 'npm test' }).elapsedMs);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(rounds * 0.5)];
  const p99 = times[Math.floor(rounds * 0.99)];
  check('判定 p99 < 2ms（P0 预算）', p99 < 2, `p50=${p50.toFixed(4)}ms p99=${p99.toFixed(4)}ms`);
}

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
