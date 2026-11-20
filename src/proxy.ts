/**
 * agentguard · stdio 双向代理
 *
 * 设计约束（来自技术方案第 3 章「五个必坑」）：
 *   1. 任何诊断输出只写 stderr —— stdout 是协议流，写一个字节的日志就会污染它。
 *   2. 不经过 readline —— 大 JSON（超长文件内容）会被行缓冲截断。这里用自建分割器，
 *      只在遇到 0x0A 时切分，行长度无上限。
 *   3. stdio 必须是 'pipe' —— 子进程直接继承 fd 等于把代理短路掉。
 *   4. 转发原始字节，不 JSON.parse → JSON.stringify 往返（浮点精度 / 字段顺序 / \u 转义
 *      都会变）。解析只发生在需要判定的地方（W3 接入策略时），转发永远走原始 Buffer。
 *   5. Windows 下 npx / 各种 CLI 是 .cmd 垫片，直接 spawn 会 ENOENT。见 resolveCommand()。
 *
 * 第四个消息方向（server → client 的请求，如 sampling/createMessage）不走任何特殊分支：
 * 只要方向是 upstream 往外，就原样转发，代理绝不消费 —— 否则某些 server 功能会静默挂住。
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, extname, join } from 'node:path';

import { buildErrorLine, ErrorCode, type RequestId } from './errors.js';
import { logger } from './logger.js';
import { decide } from './policy/decide.js';
import type { CompiledPolicy } from './policy/types.js';
import type { AuditSink } from './audit/writer.js';
import { LimitTracker } from './limits.js';

const LF = 0x0a;

export interface ProxySpec {
  /** argv[0] 是可执行文件，其余是参数 */
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** 不传 = 纯转发（W1 行为）。传了才做判定。 */
  readonly policy?: CompiledPolicy;
  /** 审计落盘；不传则不记录 */
  readonly audit?: AuditSink;
  readonly session?: string;
}

export interface ProxyHandle {
  readonly child: ChildProcess;
  /** upstream 退出后 resolve，值为退出码（被信号杀死时为 1） */
  readonly done: Promise<number>;
}

/* ------------------------------------------------------------------ *
 * 行分割：只在 0x0A 处切，行内字节原样保留（含行尾换行符）
 * ------------------------------------------------------------------ */

class LineSplitter {
  private rest: Buffer[] = [];

  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;

    for (;;) {
      const nl = chunk.indexOf(LF, start);
      if (nl === -1) break;

      if (this.rest.length === 0) {
        // 常见路径：整行都在这一块里，零拷贝
        lines.push(chunk.subarray(start, nl + 1));
      } else {
        this.rest.push(chunk.subarray(start, nl + 1));
        lines.push(Buffer.concat(this.rest));
        this.rest = [];
      }
      start = nl + 1;
    }

    if (start < chunk.length) this.rest.push(chunk.subarray(start));
    return lines;
  }

  /** 流结束时吐出最后一段没有换行结尾的内容（MCP 允许最后一行不带 \n） */
  flush(): Buffer | undefined {
    if (this.rest.length === 0) return undefined;
    const tail = this.rest.length === 1 ? this.rest[0]! : Buffer.concat(this.rest);
    this.rest = [];
    return tail;
  }
}

/** 返回 false 表示丢弃该行（W3 的 deny 路径会用到），W1 恒为 true */
type LineSink = (line: Buffer) => boolean | void;

/* ------------------------------------------------------------------ *
 * 管道泵：带背压，不无界缓冲
 * ------------------------------------------------------------------ */

function pump(
  src: NodeJS.ReadableStream,
  dst: NodeJS.WritableStream,
  sink: LineSink,
  endDstOnSourceEnd: boolean,
  dstLabel: string,
): void {
  const splitter = new LineSplitter();
  let paused = false;
  let dstBroken = false;

  dst.on('drain', () => {
    if (!paused) return;
    paused = false;
    src.resume();
  });

  // 高危防御：upstream 先退出而 client 还在写（或客户端断开时我们还在回写），
  // dst.write 会触发 EPIPE。Writable 没有监听 'error' 事件时会直接抛出，
  // 整个代理进程带着堆栈崩掉。这里转成日志 + 该方向停止转发。
  dst.on('error', (err: Error) => {
    dstBroken = true;
    process.stderr.write(`agentguard: ${dstLabel} 写入失败，该方向停止转发：${err.message}\n`);
  });

  src.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let full = false;

    for (const line of splitter.push(buf)) {
      if (sink(line) === false) continue;
      if (dstBroken) continue;
      if (dst.write(line) === false) full = true;
    }

    // 先写完本块内的所有行，再暂停；否则剩余行会滞留在内存里等下一次 data
    if (full) {
      paused = true;
      src.pause();
    }
  });

  src.on('end', () => {
    const tail = splitter.flush();
    if (!dstBroken && tail !== undefined && sink(tail) !== false) dst.write(tail);
    if (endDstOnSourceEnd) dst.end();
  });

  src.on('error', (err: Error) => {
    process.stderr.write(`agentguard: upstream stream error: ${err.message}\n`);
  });
}

/* ------------------------------------------------------------------ *
 * Windows 命令解析
 * ------------------------------------------------------------------ */

interface ResolvedCommand {
  readonly file: string;
  /** 'cmd' 表示必须经 cmd.exe 启动（.cmd / .bat 垫片） */
  readonly via: 'direct' | 'cmd';
}

/**
 * 在 Windows 上按 PATH + PATHEXT 顺序解析可执行文件。
 *
 * 为什么不用 spawn(cmd, args, { shell: true })：Node 在 shell 模式下把
 * [file, ...args].join(' ') 直接拼进 /c，参数里的空格不会被成对引号保护，
 * `.../server-filesystem "D:\\my projects"` 会被劈成两个参数。这里自己拼命令行
 * 并对每个 token 单独加引号，然后用 windowsVerbatimArguments 原样交给 cmd.exe。
 */
export function resolveCommand(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCommand {
  const isWindows = process.platform === 'win32';
  const isShim = /\.(cmd|bat)$/i.test(command);

  if (!isWindows) return { file: command, via: 'direct' };
  if (command === '') throw new Error('empty upstream command');

  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim())
    .filter((ext) => ext !== '');

  const names = extname(command) === '' ? exts.map((ext) => command + ext) : [command];
  const hasSeparator = /[\\/]/.test(command);

  const candidates: string[] = [];
  if (hasSeparator) {
    candidates.push(...names);
  } else {
    const pathVar = env.PATH ?? env.Path ?? '';
    for (const dir of pathVar.split(delimiter)) {
      if (dir === '') continue;
      for (const name of names) candidates.push(join(dir, name));
    }
  }

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return { file: candidate, via: /\.(cmd|bat)$/i.test(candidate) ? 'cmd' : 'direct' };
      }
    } catch {
      // 不存在或无权限，继续找下一个候选
    }
  }

  // 没找到：交给 spawn 报 ENOENT（或 cmd.exe 自己去解析），错误信息会带上原始命令名
  return { file: command, via: isShim ? 'cmd' : 'direct' };
}

function quoteForCmd(token: string): string {
  if (token === '') return '""';
  if (!/[\s"&|<>^()]/.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}

function spawnUpstream(
  resolved: ResolvedCommand,
  args: readonly string[],
  spec: ProxySpec,
): ChildProcess {
  const options: SpawnOptions = {
    // 坑 #3：三条流全部显式 pipe，子进程绝不能继承我们的 fd
    stdio: ['pipe', 'pipe', 'inherit'],
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    windowsHide: true,
  };

  if (resolved.via === 'cmd' && process.platform === 'win32') {
    const line = [resolved.file, ...args].map(quoteForCmd).join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(resolved.file, [...args], options);
}

/* ------------------------------------------------------------------ *
 * 判定闸门（W3）
 *
 * 只拦 client → upstream 方向的 tools/call：
 *   allow → 原样转发
 *   deny  → 用原 id 回 -32001，upstream 根本收不到这条消息（命令没有执行机会）
 *   ask   → 同理回 -32001，并在消息里说明「无审批通道，按拒绝处理」
 *
 * 为什么 ask 不弹交互确认：代理的 stdin 就是协议流，从里面读 y/n 会把 MCP 消息吃掉；
 * 真要做交互，必须另开控制终端（CONIN$ / /dev/tty），否则一读就死锁。
 * 在拿到可靠的审批通道之前，ask 的行为就是「明确拒绝」，绝不静默放行。
 * ------------------------------------------------------------------ */

const TOOLS_CALL = Buffer.from('"tools/call"', 'utf8');
const CLIENT_INFO = Buffer.from('"clientInfo"', 'utf8');
const ID_PEEK = /"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+|null)/;

interface Gate {
  /** 返回 false 表示这条请求不转发给 upstream */
  onClientLine(line: Buffer): boolean;
  onUpstreamLine(line: Buffer): void;
  onUpstreamClose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRequestId(value: unknown): RequestId | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value === null) return null;
  return undefined;
}

/**
 * 解析一行 JSON。容忍 UTF-8 BOM：某些客户端/编辑器会把 BOM 带进行首，
 * 标准 JSON.parse 会直接抛错，表现为「某个 agent 配上来就所有调用都失败」。
 */
function parseJsonLine(line: Buffer): unknown {
  const text = line.toString('utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** 只读响应头 512 字节取 id，避免为每个响应解析整行（响应体可能几 MB） */
function peekId(line: Buffer): string | number | null | undefined {
  const text = (line.length > 512 ? line.subarray(0, 512) : line).toString('utf8');
  const match = ID_PEEK.exec(text);
  if (match === null) return undefined;

  const token = match[1]!;
  if (token === 'null') return null;
  if (token.startsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return undefined;
    }
  }
  return Number(token);
}

function createGate(
  policy: CompiledPolicy,
  out: NodeJS.WritableStream,
  options: { audit?: AuditSink; limits?: LimitTracker; session: string },
): Gate {
  // 已放行、尚未收到响应的请求 id；upstream 崩溃时它们必须收到错误，否则 client 会一直等
  const pending = new Set<string | number>();
  // clientInfo.name 只在 initialize 里出现一次，抓到后整场复用
  let agent: string | null = null;

  const record = (
    tool: string,
    args: unknown,
    decision: string,
    detail: {
      raw?: string;
      ruleId: string | null;
      reason: string | null;
      ms: number;
      reqId: string | number | null;
      dryRun?: boolean;
    },
  ): void => {
    if (options.audit === undefined) return;
    try {
      options.audit.write({
        ts: new Date().toISOString(),
        reqId: detail.reqId,
        tool,
        args,
        decision,
        ...(detail.raw === undefined || detail.raw === decision ? {} : { raw: detail.raw }),
        ruleId: detail.ruleId,
        reason: detail.reason,
        ms: Number(detail.ms.toFixed(3)),
        session: options.session,
        agent,
        ...(detail.dryRun === true ? { dryRun: true } : {}),
      });
    } catch (err) {
      logger.error('审计记录写入异常', { error: (err as Error).message });
    }
  };

  return {
    onClientLine(line: Buffer): boolean {
      if (agent === null && line.indexOf(CLIENT_INFO) !== -1) {
        try {
          const message = parseJsonLine(line) as {
            params?: { clientInfo?: { name?: unknown } };
          };
          const name = message.params?.clientInfo?.name;
          if (typeof name === 'string' && name !== '') agent = name;
        } catch {
          // 解析不了就当没抓到，不影响转发
        }
      }

      // 快速路径：不含 "tools/call" 的行不解析、不判定，直接转发
      if (line.indexOf(TOOLS_CALL) === -1) return true;

      let message: unknown;
      try {
        message = parseJsonLine(line);
      } catch {
        logger.warn('无法解析的 tools/call 行，原样转发交给 upstream 报错');
        return true;
      }
      if (!isRecord(message) || message.method !== 'tools/call') return true;

      const params = isRecord(message.params) ? message.params : {};
      const tool = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments ?? {};
      const id = toRequestId(message.id);
      const reqId = typeof id === 'string' || typeof id === 'number' ? id : null;

      let result;
      try {
        result = decide(policy, tool, args);
      } catch (err) {
        // 判定过程本身异常也必须 fail closed，绝不能因为「引擎出错」就放行
        logger.error('策略判定异常，按拒绝处理', { error: (err as Error).message });
        record(tool, args, 'deny', {
          ruleId: null,
          reason: `判定异常：${(err as Error).message}`,
          ms: 0,
          reqId,
        });
        if (id !== undefined) {
          out.write(
            buildErrorLine(id, ErrorCode.POLICY_UNAVAILABLE, 'Policy engine failure (fail-closed)'),
          );
        }
        return false;
      }

      if (result.dryRun && result.raw !== 'allow') {
        logger.info('dry_run：本应拦截，已放行', {
          tool,
          raw: result.raw,
          rule: result.ruleId ?? '-',
        });
      }

      if (result.decision === 'allow') {
        // 限流只在「策略本来会放行」的调用上生效；被拒的调用回 -32001 更有信息量
        const limit = options.limits?.check(tool);
        if (limit !== undefined && !limit.ok) {
          const reason = `限流：${tool} 在 ${limit.rule!.window} 内超过 ${limit.maxCalls} 次`;
          record(tool, args, 'deny', { ruleId: null, reason, ms: result.elapsedMs, reqId });
          if (id !== undefined) {
            out.write(
              buildErrorLine(id, ErrorCode.RATE_LIMITED, `Rate limited: ${reason}`, {
                maxCalls: limit.maxCalls,
                window: limit.rule!.window,
                count: limit.count,
              }),
            );
          }
          logger.warn('触发限流', { tool, window: limit.rule!.window, max: limit.maxCalls });
          return false;
        }

        record(tool, args, 'allow', {
          raw: result.raw,
          ruleId: result.ruleId,
          reason: result.reason,
          ms: result.elapsedMs,
          reqId,
          dryRun: result.dryRun,
        });

        if (typeof id === 'string' || typeof id === 'number') pending.add(id);
        return true;
      }

      const ruleLabel = result.ruleId ?? '(fail-closed)';

      record(tool, args, result.decision === 'ask' ? 'ask' : 'deny', {
        raw: result.raw,
        ruleId: result.ruleId,
        reason: result.reason,
        ms: result.elapsedMs,
        reqId,
        dryRun: result.dryRun,
      });

      if (id === undefined) {
        // 通知没有 id，按协议不能回 error；丢掉即等于「不执行」
        logger.warn('拒绝了一个无 id 的 tools/call 通知', { tool, rule: ruleLabel });
        return false;
      }

      const text =
        result.decision === 'ask'
          ? `Blocked by policy ${ruleLabel}: 需要人工确认，当前无审批通道，按拒绝处理${
              result.reason === null ? '' : `（${result.reason}）`
            }`
          : `Blocked by policy ${ruleLabel}: ${result.reason ?? ''}`;

      out.write(
        buildErrorLine(id, ErrorCode.POLICY_DENIED, text, {
          ruleId: result.ruleId,
          reason: result.reason,
          decision: result.raw,
          dryRun: result.dryRun,
        }),
      );

      logger.info('拦截调用', { tool, rule: ruleLabel, id });
      return false;
    },

    onUpstreamLine(line: Buffer): void {
      if (pending.size === 0) return;
      const id = peekId(line);
      if (typeof id === 'string' || typeof id === 'number') pending.delete(id);
    },

    onUpstreamClose(): void {
      for (const id of pending) {
        out.write(
          buildErrorLine(id, ErrorCode.INTERNAL_ERROR, 'upstream exited before responding'),
        );
      }
      pending.clear();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 代理主体
 * ------------------------------------------------------------------ */

export function startProxy(spec: ProxySpec): ProxyHandle {
  const [command, ...args] = spec.command;
  if (command === undefined) throw new Error('no upstream command given');

  const resolved = resolveCommand(command, spec.env ?? process.env);
  const child = spawnUpstream(resolved, args, spec);

  const gate =
    spec.policy === undefined
      ? null
      : createGate(spec.policy, process.stdout, {
          audit: spec.audit,
          limits: spec.policy.limits.length === 0 ? undefined : new LimitTracker(spec.policy.limits),
          session: spec.session ?? 'unknown',
        });

  // 必须在 done 的 close 监听之前注册：先把「未完成请求的错误」写出去，再让进程收尾
  if (gate !== null) child.once('close', () => gate.onUpstreamClose());

  // 优先等 'close'：'exit' 触发时 stdout 管道可能还没读空，upstream「回完最后一条响应
  // 立刻退出」时那条有丢失风险（本机 40 轮压测未复现，属防御性写法）。
  // 但若 upstream 有孙进程占住管道，'close' 可能迟迟不来 —— 所以 exit 后 500ms 强制收尾。
  const done = new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve(code ?? (signal === null ? 0 : 1));
    };

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      setTimeout(() => finish(code, signal), 500).unref();
    });
    child.once('close', (code, signal) => finish(code, signal));
  });
  // 主链路只关心退出，这里吞掉避免 unattended rejection
  done.catch(() => {});

  // client → upstream：先过判定闸门（无策略时纯转发）；W4 的策略钩子与审计都挂在这里
  if (child.stdin) {
    pump(
      process.stdin,
      child.stdin,
      (line) => (gate === null ? true : gate.onClientLine(line)),
      true,
      'client → upstream',
    );
  }

  // upstream → client：原样转发，包括 server 主动发起的请求
  if (child.stdout) {
    pump(
      child.stdout,
      process.stdout,
      (line) => {
        gate?.onUpstreamLine(line);
        return true;
      },
      false,
      'upstream → client',
    );
  }

  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  };

  // 退出时顺手带走子进程。信号处理交给 main（它要先把审计刷盘再退）
  process.once('exit', kill);

  return { child, done };
}
