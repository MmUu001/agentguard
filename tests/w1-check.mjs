/**
 * W1 验收脚本 —— 差分比对：同一个假 upstream，直连 vs 过代理，输出必须逐字节相同。
 *
 * 验收标准（技术方案第 8 章 W1）：Claude Code 配置指向 agentguard 后，upstream 功能完全不变。
 * 「完全不变」在这里被量化为：
 *   1. initialize / tools/list / tools/call 的原始响应行完全相同
 *   2. 2 MiB 的大行不截断
 *   3. server → client 的 sampling/createMessage 反向请求能通
 *   4. 一行被拆成多次 write 时仍被正确重组
 *   5. upstream 非零退出码原样传回
 *   6. Windows .cmd 垫片（npx）可被启动
 *   7. stdout 上没有一行是协议之外的噪声
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { McpClient } from './lib/client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const FIXTURE = resolve(HERE, 'fixtures', 'mock-mcp-server.mjs');
// W3 起默认策略是 deny-all，W1 的「纯透传」验收必须显式挂 allow-all
const ALLOW_ALL = resolve(HERE, 'fixtures', 'allow-all.yaml');
const NODE = process.execPath;

// 这些用例只验证转发/判定，不让它们在真实家目录里写审计
process.env.AGENTGUARD_AUDIT = 'off';

const results = [];
const pass = (name, detail = '') => {
  results.push({ name, ok: true });
  console.log(`PASS  ${name}${detail === '' ? '' : '  ' + detail}`);
};
const fail = (name, err) => {
  results.push({ name, ok: false });
  console.log(`FAIL  ${name}\n      ${err && err.message ? err.message : String(err)}`);
};

/* ---------------------------------------------------------------- */

function connect(viaProxy) {
  const proc = viaProxy
    ? spawn(NODE, [MAIN, '--policy', ALLOW_ALL, '--', NODE, FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(NODE, [FIXTURE], { stdio: ['pipe', 'pipe', 'pipe'] });
  return new McpClient(proc);
}

/* ---------------------------------------------------------------- */

const INIT_PARAMS = {
  protocolVersion: '2025-06-18',
  capabilities: { roots: { listChanged: true }, sampling: {} },
  clientInfo: { name: 'w1-check', version: '0.0.0' },
};

const ROUND1 = { command: 'ls -la "带 空格 的目录"', max: 12345678901234567890 };
const ROUND2 = {
  unicode: '权限网关 🔒 \u00e9\u00e8\u00ea',
  float: 0.1 + 0.2,
  tiny: 1e-7,
  big: 1e21,
  nested: { 键: ['值', null, true, -0] },
  escaped: 'line1\nline2\ttab"quote\\slash',
};

async function transcript(viaProxy) {
  const c = connect(viaProxy);
  const out = {};
  try {
    out.init = (await c.request('initialize', INIT_PARAMS)).line;
    c.notify('notifications/initialized');
    out.list = (await c.request('tools/list', {})).line;
    out.echo = (await c.request('tools/call', { name: 'echo', arguments: ROUND1 })).line;
    out.echo2 = (await c.request('tools/call', { name: 'echo', arguments: ROUND2 })).line;
    out.big = (await c.request('tools/call', { name: 'big', arguments: { text: 'x'.repeat(2 * 1024 * 1024) } })).line;
    c.serverRequestHandler = (msg, respond) =>
      respond({ content: [{ type: 'text', text: 'client-answer' }], model: 'mock-model', role: 'assistant' });
    out.sample = (await c.request('tools/call', { name: 'sample', arguments: {} })).line;
    out.split = (await c.request('tools/call', { name: 'split', arguments: {} })).line;
    out.serverRequests = [...c.serverRequests];
    out.invalidLines = [...c.invalidLines];
    out.exitCode = await c.close();
  } finally {
    if (c.proc.exitCode === null) c.proc.kill();
  }
  return out;
}

/* ---------------------------------------------------------------- */

async function main() {
  console.log('agentguard W1 acceptance\n');

  // ---- 差分：直连 vs 过代理 ----
  let direct;
  let proxied;
  try {
    direct = await transcript(false);
    proxied = await transcript(true);
    pass('差分基线采集', `${Object.keys(direct).length} 项`);
  } catch (err) {
    fail('差分基线采集', err);
    return summary();
  }

  const fields = ['init', 'list', 'echo', 'echo2', 'big', 'sample', 'split'];
  for (const field of fields) {
    const a = direct[field];
    const b = proxied[field];
    if (a === b) {
      pass(`透传逐字节一致 · ${field}`, `${Buffer.byteLength(b, 'utf8')} B`);
    } else {
      fail(`透传逐字节一致 · ${field}`, new Error(`direct=${a.slice(0, 160)}\n      proxied=${b.slice(0, 160)}`));
    }
  }

  const bigText = JSON.parse(proxied.big).result.content[0].text;
  bigText === String(2 * 1024 * 1024)
    ? pass('2 MiB 超长行不截断')
    : fail('2 MiB 超长行不截断', new Error(`length=${bigText}`));

  proxied.serverRequests.includes('sampling/createMessage')
    ? pass('第 4 方向 · server→client 请求可透传', proxied.serverRequests.join(','))
    : fail('第 4 方向 · server→client 请求可透传', new Error(`got ${JSON.stringify(proxied.serverRequests)}`));

  JSON.parse(proxied.sample).result.content[0].text.startsWith('sampling-ok:')
    ? pass('第 4 方向 · 回应能回到 upstream')
    : fail('第 4 方向 · 回应能回到 upstream', new Error(proxied.sample));

  JSON.parse(proxied.split).result.content[0].text === 'chunked'
    ? pass('分片写入的行能被重组')
    : fail('分片写入的行能被重组', new Error(proxied.split));

  proxied.invalidLines.length === 0
    ? pass('stdout 无协议外噪声')
    : fail('stdout 无协议外噪声', new Error(JSON.stringify(proxied.invalidLines)));

  proxied.exitCode === 0
    ? pass('正常关闭退出码 0')
    : fail('正常关闭退出码 0', new Error(`exit=${proxied.exitCode}`));

  // ---- upstream 崩溃传播 ----
  try {
    const c = connect(true);
    await c.request('initialize', INIT_PARAMS);
    c.send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'crash', arguments: {} } });
    const code = await c.exited;
    code === 7 ? pass('upstream 非零退出码原样传回', 'exit=7') : fail('upstream 非零退出码原样传回', new Error(`exit=${code}`));
    if (c.proc.exitCode === null) c.proc.kill();
  } catch (err) {
    fail('upstream 非零退出码原样传回', err);
  }

  // ---- upstream 回完响应立刻退出：最后一行不能被丢 ----
  try {
    const c = connect(true);
    await c.request('initialize', INIT_PARAMS);
    const last = await c.request('tools/call', { name: 'quit', arguments: {} });
    const text = JSON.parse(last.line).result.content[0].text;
    const code = await c.exited;
    text === 'last-words' && code === 0
      ? pass('响应后立即退出的尾行不丢失', 'exit=0')
      : fail('响应后立即退出的尾行不丢失', new Error(`text=${text} exit=${code}`));
    if (c.proc.exitCode === null) c.proc.kill();
  } catch (err) {
    fail('响应后立即退出的尾行不丢失', err);
  }

  // ---- Windows .cmd 垫片 ----
  try {
    const { stdout, code } = await runNode([MAIN, '--', 'npx', '--version']);
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    if (code === 0 && /^\d+\.\d+/.test(line)) pass('Windows .cmd 垫片可启动', `npx ${line}`);
    else fail('Windows .cmd 垫片可启动', new Error(`code=${code} stdout=${JSON.stringify(stdout.slice(0, 200))}`));
  } catch (err) {
    fail('Windows .cmd 垫片可启动', err);
  }

  // ---- CLI 行为 ----
  try {
    const v = await runNode([MAIN, '--version']);
    /^\d+\.\d+\.\d+/.test(v.stdout.trim())
      ? pass('--version 输出版本', v.stdout.trim())
      : fail('--version 输出版本', new Error(JSON.stringify(v.stdout)));
  } catch (err) {
    fail('--version 输出版本', err);
  }

  try {
    const u = await runNode([MAIN]);
    u.code === 2 && u.stdout.includes('Usage:')
      ? pass('无参数时打印用法并以 2 退出')
      : fail('无参数时打印用法并以 2 退出', new Error(`code=${u.code}`));
  } catch (err) {
    fail('无参数时打印用法并以 2 退出', err);
  }

  try {
    const e = await runNode([MAIN, '--', 'definitely-not-a-real-command-xyz']);
    e.code !== 0 && /failed to spawn|ENOENT/i.test(e.stderr)
      ? pass('不存在的命令报错退出', `exit=${e.code}`)
      : fail('不存在的命令报错退出', new Error(`code=${e.code} stderr=${e.stderr.slice(0, 200)}`));
  } catch (err) {
    fail('不存在的命令报错退出', err);
  }

  summary();
}

function runNode(args, timeoutMs = 30000) {
  return new Promise((res, rej) => {
    const proc = spawn(NODE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      rej(new Error(`timeout: node ${args.join(' ')}`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('error', rej);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      res({ code: code ?? -1, stdout, stderr });
    });
  });
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
