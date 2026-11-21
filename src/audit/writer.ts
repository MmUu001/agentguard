/**
 * 审计写入：一行一次判定，JSONL 追加。
 *
 * 三条约束：
 *   1. **不阻塞转发**：写走 WriteStream（异步），调用方只往队列里塞一行就返回。
 *   2. **参数要截断**：文件内容动辄几 MB，原样落盘一天就能把磁盘吃满。默认 200 字符，
 *      深度截断长字符串 / 超长数组 / 超多键的对象，实在压不下去再退化成 preview。
 *   3. **按天切分 + 保留期**：文件名就是日期，清理只需要按文件名比大小，不读内容。
 *
 * 记录字段与方案第 6 章一致，另加两个可选字段：
 *   raw —— dry_run 或 ask 时保留「本来是什么判定」，否则观察模式下看不到真相
 *   truncated —— args 被裁剪过
 */

import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  unlinkSync,
  type WriteStream,
} from 'node:fs';
import { join } from 'node:path';

import { logger } from '../logger.js';

export const DEFAULT_ARGS_LIMIT = 200;
export const DEFAULT_KEEP_DAYS = 30;

const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;
const STRING_CAP = 120;
const ARRAY_CAP = 10;
const OBJECT_KEYS_CAP = 20;

export interface AuditRecord {
  readonly ts: string;
  readonly reqId: string | number | null;
  readonly tool: string;
  readonly args: unknown;
  readonly decision: string;
  readonly raw?: string;
  readonly ruleId: string | null;
  readonly reason: string | null;
  readonly ms: number;
  readonly session: string;
  readonly agent: string | null;
  readonly policyHash?: string;
  readonly dryRun?: boolean;
}

/** 代理只需要「写一行」，具体落盘方式由这里决定 */
export interface AuditSink {
  write(record: AuditRecord): void;
}

export function dayKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 深度裁剪：保住结构，砍掉体积 */
function clipValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > STRING_CAP ? `${value.slice(0, STRING_CAP)}…` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, ARRAY_CAP).map(clipValue);
    return value.length > ARRAY_CAP ? [...head, `…(${value.length - ARRAY_CAP} more)`] : head;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    const kept = entries.slice(0, OBJECT_KEYS_CAP).map(([key, item]) => [key, clipValue(item)] as const);
    const result: Record<string, unknown> = Object.fromEntries(kept);
    if (entries.length > OBJECT_KEYS_CAP) {
      result['…'] = `${entries.length - OBJECT_KEYS_CAP} more keys`;
    }
    return result;
  }
  return value;
}

/** 把 args 压到 limit 个字符以内；返回 null 表示无需裁剪 */
export function clipArgs(args: unknown, limit: number = DEFAULT_ARGS_LIMIT): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(args ?? null);
  } catch {
    return { __unserializable: true };
  }

  if (serialized.length <= limit) return args;

  const clipped = clipValue(args);
  let clippedSerialized: string;
  try {
    clippedSerialized = JSON.stringify(clipped);
  } catch {
    clippedSerialized = 'null';
  }

  if (clippedSerialized.length <= limit) return clipped;

  return {
    __truncated: true,
    size: serialized.length,
    preview: serialized.slice(0, limit),
  };
}

export class AuditWriter implements AuditSink {
  readonly #dir: string;
  readonly #argsLimit: number;
  #stream: WriteStream | null = null;
  #day: string | null = null;
  #broken = false;

  constructor(dir: string, options: { argsLimit?: number } = {}) {
    this.#dir = dir;
    this.#argsLimit = options.argsLimit ?? DEFAULT_ARGS_LIMIT;
    mkdirSync(this.#dir, { recursive: true });
  }

  get directory(): string {
    return this.#dir;
  }

  write(record: AuditRecord): void {
    if (this.#broken) return;

    try {
      const day = dayKey(new Date(record.ts));
      if (this.#stream === null || this.#day !== day) this.#open(day);

      const clipped = clipArgs(record.args, this.#argsLimit);
      const payload: Record<string, unknown> = { ...record, args: clipped };
      if (clipped !== record.args) payload.truncated = true;

      this.#stream?.write(JSON.stringify(payload) + '\n');
    } catch (err) {
      // 审计写不进去不阻断转发（否则一个只读的家目录就能让整个网关停摆），
      // 但必须大声报错 —— 静默丢审计比拦错更糟。
      logger.error('审计写入失败，后续记录将被丢弃', { error: (err as Error).message });
      this.#broken = true;
    }
  }

  /** 把已入队的数据刷到内核；退出前必须调用 */
  flush(): Promise<void> {
    const stream = this.#stream;
    if (stream === null || this.#broken) return Promise.resolve();
    return new Promise((resolve) => {
      stream.write('', () => resolve());
    });
  }

  async close(): Promise<void> {
    const stream = this.#stream;
    this.#stream = null;
    this.#day = null;
    if (stream === null) return;

    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }

  #open(day: string): void {
    const previous = this.#stream;
    if (previous !== null) previous.end();

    mkdirSync(this.#dir, { recursive: true });
    const stream = createWriteStream(join(this.#dir, `${day}.jsonl`), { flags: 'a' });
    stream.on('error', (err: Error) => {
      logger.error('审计流错误，后续记录将被丢弃', { error: err.message });
      this.#broken = true;
    });

    this.#stream = stream;
    this.#day = day;
  }
}

/**
 * 按文件名删掉超过 keepDays 的审计文件。
 * 只比较 `YYYY-MM-DD` 字符串，不读文件内容，代价与文件体积无关。
 */
export function pruneAudit(dir: string, keepDays: number = DEFAULT_KEEP_DAYS, now: number = Date.now()): string[] {
  if (keepDays <= 0) return [];

  const cutoff = dayKey(new Date(now - keepDays * 86_400_000));
  const removed: string[] = [];

  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }

  for (const name of names) {
    const match = DAY_FILE.exec(name);
    if (match === null) continue;
    if (name.slice(0, 10) >= cutoff) continue;
    try {
      unlinkSync(join(dir, name));
      removed.push(name);
    } catch (err) {
      logger.warn('清理过期审计文件失败', { file: name, error: (err as Error).message });
    }
  }

  return removed;
}
