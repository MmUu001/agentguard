#!/usr/bin/env node
/**
 * agentguard · CLI 入口
 *
 * 用法：
 *   agentguard [--policy <file>]... -- <真实 mcp server 命令> [参数...]
 *
 * 策略来源（按优先级）：
 *   1. `--policy` 指定的文件（可重复，按顺序合并）
 *   2. `~/.agentguard/policy.yaml`
 *   3. 都没有 → 内置 deny-all 空策略 + stderr 告警。**绝不因为「没配置」就裸奔。**
 *
 * 退出码：0 正常 / 1 upstream 启动失败 / 2 用法或策略配置错误。
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AuditWriter, pruneAudit } from './audit/writer.js';
import { auditDir, auditKeepDays, runCli } from './cli.js';
import { logger } from './logger.js';
import { loadPolicy, parsePolicy } from './policy/load.js';
import { PolicyError, type CompiledPolicy } from './policy/types.js';
import { startProxy } from './proxy.js';

const NAME = 'agentguard';
const DEFAULT_POLICY = join(homedir(), '.agentguard', 'policy.yaml');

class UsageError extends Error {}

interface CliOptions {
  readonly action: 'run' | 'help' | 'version';
  readonly policies: readonly string[];
  readonly command: readonly string[];
}

function readVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printUsage(): void {
  process.stdout.write(
    [
      `${NAME} ${readVersion()}`,
      '',
      'Usage:',
      `  ${NAME} [--policy <file>]... -- <command> [args...]`,
      `  ${NAME} init | check | demo`,
      `  ${NAME} audit <list|stats|export> [options]`,
      `  ${NAME} --version`,
      '',
      'Options:',
      '  --policy <file>  策略文件，可重复；按给出顺序合并（先给出的规则先声明）',
      `                   不传时读 ${DEFAULT_POLICY}`,
      '',
      'Example:',
      `  npx -y ${NAME} -- npx -y @modelcontextprotocol/server-filesystem /projects`,
      `  npx -y ${NAME} --policy ~/.agentguard/policy.yaml -- npx -y @modelcontextprotocol/server-filesystem /projects`,
      `  ${NAME} demo                  # 不接 agent，直接看拦截效果`,
      `  ${NAME} audit stats --since 7d`,
      '',
      'stdout carries the MCP JSON-RPC stream; all diagnostics go to stderr.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv: readonly string[]): CliOptions {
  const policies: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === '--') return { action: 'run', policies, command: argv.slice(i + 1) };
    if (arg === '--version' || arg === '-v') return { action: 'version', policies, command: [] };
    if (arg === '--help' || arg === '-h') return { action: 'help', policies, command: [] };

    if (arg === '--policy') {
      const value = argv[i + 1];
      if (value === undefined || value === '') {
        throw new UsageError('--policy 后面必须跟文件路径');
      }
      policies.push(value);
      i += 1;
      continue;
    }

    if (arg.startsWith('--policy=')) {
      const value = arg.slice('--policy='.length);
      if (value === '') throw new UsageError('--policy= 后面必须跟文件路径');
      policies.push(value);
      continue;
    }

    if (arg.startsWith('-')) throw new UsageError(`未知选项 ${arg}`);

    // 没写 `--` 也允许（`agentguard npx -y ...`），但命令本身不能以 `-` 开头
    return { action: 'run', policies, command: argv.slice(i) };
  }

  return { action: 'run', policies, command: [] };
}

function fail(message: string, code: number): never {
  process.stderr.write(`${NAME}: ${message}\n`);
  process.exit(code);
}

/** 退出前把 stdout 队列排空，否则最后一条响应可能留在管道缓冲里被丢掉 */
function flushStdout(): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write('', () => resolve());
  });
}

function loadOrExit(paths: readonly string[]): CompiledPolicy {
  try {
    const policy = loadPolicy(paths);
    logger.info('策略已加载', {
      sources: policy.sources.join(','),
      rules: policy.rules.length,
      on_no_match: policy.defaults.onNoMatch,
      dry_run: policy.defaults.dryRun,
    });
    if (policy.limits.length > 0) {
      logger.warn('limits 已解析但尚未执行（留到 W4 随审计一起接入）', {
        count: policy.limits.length,
      });
    }
    return policy;
  } catch (err) {
    const message = err instanceof PolicyError ? err.message : (err as Error).message;
    // 策略写错就不启动 —— 带着错误策略运行等于给用户假的安心
    process.stderr.write(`${NAME}: 策略加载失败，拒绝启动\n  ${message}\n`);
    process.exit(2);
  }
}

/** 审计开关与目录。`AGENTGUARD_AUDIT=off` 可关闭；目录不可写时告警但不停摆。 */
function openAudit(): AuditWriter | null {
  if ((process.env.AGENTGUARD_AUDIT ?? '').trim().toLowerCase() === 'off') {
    logger.info('审计已关闭（AGENTGUARD_AUDIT=off）');
    return null;
  }

  const dir = auditDir();
  try {
    const removed = pruneAudit(dir, auditKeepDays());
    if (removed.length > 0) logger.info('清理过期审计文件', { removed: removed.length });
    const writer = new AuditWriter(dir);
    logger.info('审计已启用', { dir, keep_days: auditKeepDays() });
    return writer;
  } catch (err) {
    logger.error('审计目录不可用，本次运行不写审计', { dir, error: (err as Error).message });
    return null;
  }
}

function resolvePolicy(explicit: readonly string[]): CompiledPolicy {  if (explicit.length > 0) return loadOrExit(explicit);
  if (existsSync(DEFAULT_POLICY)) return loadOrExit([DEFAULT_POLICY]);

  logger.warn('未找到策略文件，以 deny-all 启动（所有 tools/call 都会被拒绝）', {
    expected: DEFAULT_POLICY,
    hint: '用 --policy <file> 指定策略，或等待 W5 的 agentguard init',
  });
  return parsePolicy('version: 1\nrules: []\n', '<built-in deny-all>');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // 子命令优先于「把第一个词当 upstream 命令」的兜底行为
  if (
    argv[0] === 'audit' ||
    argv[0] === 'init' ||
    argv[0] === 'check' ||
    argv[0] === 'demo'
  ) {
    process.exit(await runCli(argv));
  }

  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${NAME}: ${err.message}\n\n`);
      printUsage();
      process.exit(2);
    }
    throw err;
  }

  if (options.action === 'version') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }
  if (options.action === 'help') {
    printUsage();
    return;
  }

  if (options.command.length === 0) {
    process.stderr.write(`${NAME}: no upstream command after "--"\n\n`);
    printUsage();
    process.exit(2);
  }

  const head = options.command[0]!;
  if (head.startsWith('-')) {
    fail(`refusing to treat "${head}" as an upstream command`, 2);
  }

  const policy = resolvePolicy(options.policies);
  const audit = openAudit();
  const session = randomBytes(2).toString('hex');

  let handle;
  try {
    handle = startProxy({
      command: options.command,
      policy,
      ...(audit === null ? {} : { audit }),
      session,
    });
  } catch (err) {
    fail(`cannot start upstream: ${(err as Error).message}`, 1);
  }

  const shutdown = async (code: number): Promise<void> => {
    // 先刷审计再退出：被强杀的进程丢最后几条日志，比不写日志更误导人
    await audit?.close();
    await flushStdout();
    process.exit(code);
  };

  process.once('SIGINT', () => void shutdown(130));
  process.once('SIGTERM', () => void shutdown(143));

  handle.done.then(
    (code) => shutdown(code),
    (err: Error) => fail(`failed to spawn upstream: ${err.message}`, 1),
  );
}

void main();
