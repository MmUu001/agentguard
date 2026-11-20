/**
 * 真实 upstream 验收：@modelcontextprotocol/server-filesystem 直连 vs 过 agentguard。
 *
 * 这是技术方案 W1 的验收原文 ——「配置指向 agentguard 后 filesystem server 功能完全不变」。
 * 目录名故意带空格，用来压测 Windows 下 cmd 行的引号处理。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const ALLOW_ALL = resolve(HERE, 'fixtures', 'allow-all.yaml');
const FS_POLICY = resolve(HERE, 'fixtures', 'fs-policy.yaml');
const NODE = process.execPath;

// 这些用例只验证转发/判定，不让它们在真实家目录里写审计
process.env.AGENTGUARD_AUDIT = 'off';

const SANDBOX = join(ROOT, '.tmp', 'fs sandbox');
const TARGET = join(SANDBOX, 'hello.txt');
const CONTENT = '权限网关透传测试 ✅\n第二行\n';

const UPSTREAM = ['npx', '-y', '@modelcontextprotocol/server-filesystem', SANDBOX];

class Client {
  constructor(proc) {
    this.proc = proc;
    this.seq = 0;
    this.pending = new Map();
    this.stderr = '';
    this.exited = new Promise((r) => proc.once('exit', (code) => r(code)));
    proc.stderr.on('data', (d) => (this.stderr += d.toString('utf8')));

    let buf = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      for (;;) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 1);
        this.#dispatch(line);
      }
    });

    this.exited.then(() => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('upstream exited'));
      }
      this.pending.clear();
    });
  }

  send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, timeoutMs = 180000) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  #dispatch(line) {
    if (line.trim() === '') return;
    const msg = JSON.parse(line);
    if (msg.method !== undefined) {
      if (msg.id !== undefined) {
        this.send({ jsonrpc: '2.0', id: msg.id, result: { roots: [] } });
      }
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    p.resolve(msg);
  }

  async close() {
    this.proc.stdin.end();
    return Promise.race([this.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
  }
}

async function run(viaProxy) {
  const proc = viaProxy
    ? spawn(NODE, [MAIN, '--policy', ALLOW_ALL, '--', ...UPSTREAM], { stdio: ['pipe', 'pipe', 'pipe'] })
    : // 基线必须同样能处理带空格的参数，所以按 token 自行加引号，不用 shell:true
      spawn(process.env.ComSpec ?? 'cmd.exe', [
        '/d',
        '/s',
        '/c',
        `"${[UPSTREAM[0], ...UPSTREAM.slice(1).map((a) => `"${a}"`)].join(' ')}"`,
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true });

  const c = new Client(proc);
  const init = await c.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: 'w1-real-check', version: '0.0.0' },
  });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  const list = await c.request('tools/list', {});
  const read = await c.request('tools/call', { name: 'read_file', arguments: { path: TARGET } });

  await c.close();
  if (proc.exitCode === null) proc.kill();

  return {
    protocolVersion: init.result?.protocolVersion,
    server: init.result?.serverInfo,
    tools: (list.result?.tools ?? []).map((t) => t.name).sort(),
    text: read.result?.content?.[0]?.text,
    isError: read.result?.isError === true,
    stderr: c.stderr,
  };
}

const results = [];
const check = (name, cond, detail = '') => {
  results.push(cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

/** 用指定策略过代理读一个文件，返回原始响应 */
async function readWithPolicy(policy, filePath) {
  const proc = spawn(NODE, [MAIN, '--policy', policy, '--', ...UPSTREAM], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const c = new Client(proc);
  await c.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: 'w3-real-check', version: '0.0.0' },
  });
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  const msg = await c.request('tools/call', { name: 'read_file', arguments: { path: filePath } });
  await c.close();
  if (proc.exitCode === null) proc.kill();
  return msg;
}

mkdirSync(SANDBOX, { recursive: true });
writeFileSync(TARGET, CONTENT, 'utf8');

try {
  console.log('agentguard W1 · real filesystem server\n');
  const direct = await run(false);
  const proxied = await run(true);

  check('initialize 协议版本一致', direct.protocolVersion === proxied.protocolVersion, String(proxied.protocolVersion));
  check('serverInfo 一致', JSON.stringify(direct.server) === JSON.stringify(proxied.server), JSON.stringify(proxied.server));
  check('tools/list 一致', JSON.stringify(direct.tools) === JSON.stringify(proxied.tools), `${proxied.tools.length} tools`);
  check('read_file 内容一致且正确', proxied.text === CONTENT && !proxied.isError, `${(proxied.text ?? '').length} chars`);
  check('中文与路径含空格均无编码问题', proxied.text === CONTENT);

  /* ---------- 真实 server + 真实策略：该拦的拦住，该放行的放行 ---------- */
  const envFile = join(SANDBOX, '.env');
  writeFileSync(envFile, 'SECRET=do-not-leak\n', 'utf8');

  const blocked = await readWithPolicy(FS_POLICY, envFile);
  check(
    '真实 server 下读 .env 被策略拦下',
    blocked.error?.code === -32001 && blocked.error?.data?.ruleId === 'block-env',
    `${blocked.error?.code}/${blocked.error?.data?.ruleId}`,
  );
  check('被拦时 client 拿到的是明确错误而不是空结果', typeof blocked.error?.message === 'string' && blocked.error.message.includes('Blocked by policy'));

  const allowed = await readWithPolicy(FS_POLICY, TARGET);
  check(
    '同一策略下读普通文件照常放行',
    allowed.result?.content?.[0]?.text === CONTENT && !allowed.error,
    `${(allowed.result?.content?.[0]?.text ?? '').length} chars`,
  );

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  if (process.env.KEEP_SANDBOX !== '1') rmSync(join(ROOT, '.tmp'), { recursive: true, force: true });
}
