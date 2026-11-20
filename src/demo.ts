/**
 * `agentguard demo` —— 不接任何 agent 也能看完整效果。
 *
 * 起一个内置的假 MCP server，经真实的代理链路发起 7 次工具调用，
 * 把「放行 / 拦截 / 命中哪条规则 / 上游有没有真的执行」打成一张表。
 *
 * 为什么需要它：
 *   - 用户可能没有（或不能用）某个客户端，装客户端不该是理解产品的前提
 *   - 文章与演示里可以贴真实输出，而不是截图
 *   - 有人质疑「真能拦吗」时，一条命令自证
 *
 * 审计默认关闭：演示产生的假调用不该污染用户真实的审计记录。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { displayWidth, pad } from './format.js';
import { buildDefaultPolicyText } from './policy/bootstrap.js';
import { decide } from './policy/decide.js';
import { loadPolicy } from './policy/load.js';

/** 内联的假 MCP server：只回固定内容，用来证明「被拦的调用根本没到它这里」 */
const DEMO_SERVER = `
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  for (;;) {
    const nl = buf.indexOf('\\n');
    if (nl === -1) break;
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line !== '') handle(line);
  }
});

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) return;

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentguard-demo-server', version: '1' },
      },
    });
    return;
  }

  if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          { name: 'read_file', inputSchema: { type: 'object' } },
          { name: 'write_file', inputSchema: { type: 'object' } },
          { name: 'bash', inputSchema: { type: 'object' } },
        ],
      },
    });
    return;
  }

  if (msg.method === 'tools/call') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: 'executed: ' + (msg.params && msg.params.name) }] },
    });
    return;
  }

  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
}
`;

interface Scenario {
  readonly label: string;
  readonly tool: string;
  readonly args: unknown;
}

const SCENARIOS: readonly Scenario[] = [
  { label: '读 ./src/index.ts', tool: 'read_file', args: { path: './src/index.ts' } },
  { label: '读 ./.env', tool: 'read_file', args: { path: './.env' } },
  { label: '写 /etc/hosts', tool: 'write_file', args: { path: '/etc/hosts', content: 'x' } },
  { label: 'rm -rf /', tool: 'bash', args: { command: 'rm -rf /' } },
  { label: 'rm -rf ./build', tool: 'bash', args: { command: 'rm -rf ./build' } },
  { label: 'git push --force', tool: 'bash', args: { command: 'git push --force origin main' } },
  { label: '未定义的工具', tool: 'mystery_tool', args: { foo: 1 } },
];

interface Row {
  label: string;
  decision: string;
  ruleId: string | null;
  executed: boolean;
}

function resolvePolicy(explicit: string | undefined, workDir: string): { file: string; label: string } {
  if (explicit !== undefined) return { file: explicit, label: explicit };

  const fallback = join(homedir(), '.agentguard', 'policy.yaml');
  if (existsSync(fallback)) return { file: fallback, label: fallback };

  const file = join(workDir, 'policy.yaml');
  writeFileSync(file, buildDefaultPolicyText(['core', 'secrets']), 'utf8');
  return { file, label: '内置默认策略（等同于 init 的 core + secrets + dev 基线）' };
}

export async function runDemo(options: { policyPath?: string } = {}): Promise<number> {
  const workDir = mkdtempSync(join(tmpdir(), 'agentguard-demo-'));
  let child: ReturnType<typeof spawn> | null = null;

  try {
    const serverFile = join(workDir, 'demo-server.mjs');
    writeFileSync(serverFile, DEMO_SERVER, 'utf8');

    const policy = resolvePolicy(options.policyPath, workDir);
    let compiled;
    try {
      compiled = loadPolicy(policy.file);
    } catch (err) {
      process.stderr.write(`agentguard: 策略加载失败\n  ${(err as Error).message}\n`);
      return 2;
    }

    const entry = process.argv[1] ?? 'dist/main.js';
    child = spawn(
      process.execPath,
      [entry, '--policy', policy.file, '--', process.execPath, serverFile],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGENTGUARD_AUDIT: 'off', AGENTGUARD_LOG: 'silent' },
      },
    );

    const run = child;
    const pending = new Map<number, (msg: unknown) => void>();
    let nextId = 0;
    let buffer = '';
    let stderr = '';

    run.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    run.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim() === '') continue;
        try {
          const msg = JSON.parse(line) as { id?: number };
          const resolve = msg.id === undefined ? undefined : pending.get(msg.id);
          if (resolve !== undefined) {
            pending.delete(msg.id as number);
            resolve(msg);
          }
        } catch {
          // 忽略非 JSON 行（demo 自己不会产生，防御一下）
        }
      }
    });

    const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} 超时（20s）`));
        }, 20_000);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg as Record<string, unknown>);
        });
        run.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });

    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agentguard-demo', version: '1' },
    });
    run.stdin?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n',
    );

    const rows: Row[] = [];
    let mismatch = 0;

    for (const scenario of SCENARIOS) {
      const reply = await request('tools/call', {
        name: scenario.tool,
        arguments: scenario.args,
      });
      const error = reply.error as
        | { code?: number; data?: { decision?: string; ruleId?: string | null } }
        | undefined;

      const decision =
        error === undefined
          ? 'allow'
          : error.data?.decision === 'ask'
            ? 'ask'
            : error.code === -32001
              ? 'deny'
              : `error ${error.code}`;

      // 代理不回报「放行时命中了哪条规则」（那要去读审计），这里用同一份策略在本地算一次；
      // 同时校验它与代理实际行为一致 —— 不一致说明有 bug，值得当场暴露。
      const local = decide(compiled, scenario.tool, scenario.args);
      if (local.decision !== decision) mismatch += 1;

      rows.push({
        label: scenario.label,
        decision,
        ruleId: local.ruleId,
        executed: error === undefined,
      });
    }

    run.stdin?.end();

    const label = (row: Row): string =>
      row.ruleId ?? (row.decision === 'deny' ? '(fail-closed)' : '-');

    const wLabel = Math.max(...rows.map((row) => displayWidth(row.label)), 4);
    const wRule = Math.max(...rows.map((row) => displayWidth(label(row))), 6);

    const lines: string[] = [];
    lines.push('');
    lines.push('agentguard demo —— 内置假 MCP server，走真实代理链路跑一遍');
    lines.push(`策略      ${policy.label}`);
    lines.push('');
    lines.push(
      `  ${pad('判定', 5)}  ${pad('调用', wLabel)}  ${pad('命中规则', wRule)}  上游`,
    );
    lines.push(`  ${'─'.repeat(5 + 2 + wLabel + 2 + wRule + 6)}`);

    for (const row of rows) {
      const verdict = row.decision === 'ask' ? 'ask*' : row.decision;
      lines.push(
        `  ${pad(verdict, 5)}  ${pad(row.label, wLabel)}  ${pad(label(row), wRule)}  ${
          row.executed ? '已执行' : '未执行'
        }`,
      );
    }

    const allow = rows.filter((row) => row.decision === 'allow').length;
    const deny = rows.filter((row) => row.decision === 'deny').length;
    const ask = rows.filter((row) => row.decision === 'ask').length;

    lines.push('');
    lines.push(`  合计：allow ${allow} / deny ${deny} / ask* ${ask}`);
    if (mismatch > 0) {
      lines.push(`  ⚠ 有 ${mismatch} 条代理结果与本地判定不一致（这是 bug，请反馈）`);
    }
    lines.push('  ask* 没有审批通道时按拒绝处理（fail-closed），不是放行');
    lines.push('  审计已关闭（演示不写 ~/.agentguard/audit）');
    lines.push('');

    process.stdout.write(lines.join('\n'));

    if (stderr.trim() !== '') {
      process.stderr.write(stderr);
    }

    return 0;
  } catch (err) {
    process.stderr.write(`agentguard: demo 失败：${(err as Error).message}\n`);
    return 1;
  } finally {
    child?.kill();
    rmSync(workDir, { recursive: true, force: true });
  }
}
