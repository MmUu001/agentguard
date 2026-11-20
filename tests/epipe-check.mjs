/**
 * 回归 · EPIPE 崩溃防护
 *
 * 场景一（核心）：client 先发出一个 tools/call（已转发、进入 pending），upstream 随后退出。
 *   修复前：close 时 gate 会为 pending 回 -32603 —— 但这个行为早于 EPIPE 修复就存在。
 *   真正要防的是修复后引入的路径：upstream 死后 client 继续写，EPIPE 在 child.stdin 上
 *   无人监听 → 未捕获异常 → 代理带着堆栈崩掉。
 * 场景二：upstream 死后继续灌 30 条请求（写入端已 broken），代理必须干净退出。
 */

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const ALLOW_ALL = resolve(HERE, 'fixtures', 'allow-all.yaml');
const NODE = process.execPath;

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

console.log('agentguard · EPIPE 回归\n');

// upstream 活 200ms：足够让第一条请求被转发并进入 pending
const proc = spawn(
  NODE,
  [MAIN, '--policy', ALLOW_ALL, '--', NODE, '-e', 'setTimeout(() => process.exit(0), 200)'],
  { stdio: ['pipe', 'pipe', 'pipe'] },
);

let stdout = '';
let stderr = '';
proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
// 代理退出后 test 继续写 stdin 会 EPIPE，不能让测试进程自己崩掉
proc.stdin.on('error', () => {});

const send = (obj) => {
  if (proc.stdin.writable) proc.stdin.write(JSON.stringify(obj) + '\n');
};

// t≈0：第一条请求进入 pending
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'echo', arguments: { first: true } },
});

// upstream 在 200ms 退出；t≈1s 时再灌 30 条（此时写入端已 broken）
setTimeout(() => {
  for (let i = 2; i <= 31; i++) {
    send({
      jsonrpc: '2.0',
      id: i,
      method: 'tools/call',
      params: { name: 'echo', arguments: { i } },
    });
  }
  proc.stdin.end();
}, 1000);

const outcome = await new Promise((res) => {
  const timer = setTimeout(() => {
    proc.kill();
    res({ code: 'timeout', stdout, stderr });
  }, 15000);
  proc.once('close', (code) => {
    clearTimeout(timer);
    res({ code, stdout, stderr });
  });
});

const errorLines = outcome.stdout.split('\n').filter((l) => l.includes('"code":-32603'));

check('代理干净退出（exit 0，不是崩溃）', outcome.code === 0, `exit=${outcome.code}`);
check(
  'stderr 没有未捕获异常堆栈',
  !/TypeError|at\s+\w+\s*\(/.test(outcome.stderr),
  outcome.stderr.split('\n').slice(0, 3).join(' | ').slice(0, 160),
);
check('EPIPE 被转为日志而非崩溃', !/Throw|ERR_STREAM.*unhandled/i.test(outcome.stderr));
check(
  'pending 中的请求在 upstream 退出时收到 -32603',
  errorLines.length >= 1,
  `${errorLines.length} 条`,
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
