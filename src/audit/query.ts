/**
 * 审计查询：list / stats / export。
 *
 * 读法是「新文件先读、文件内倒序读」：审计是追加写，时间天然有序，
 * 所以一旦碰到早于 --since 的记录就可以整段停手，不需要把全部历史读进内存。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { AuditRecord } from './writer.js';

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DURATION = /^(\d+)(s|m|h|d|w)$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export interface AuditFilter {
  readonly dir: string;
  /** 起止时间戳（ms）。since / until 都是闭区间 */
  readonly since?: number;
  readonly until?: number;
  readonly decision?: string;
  readonly tool?: string;
  readonly limit?: number;
}

/** `7d` / `24h` / `30m` / `2026-11-01` / 完整 ISO 都能用 */
export function parseSince(text: string, now: number = Date.now()): number {
  const duration = DURATION.exec(text.trim());
  if (duration !== null) {
    return now - Number(duration[1]) * UNIT_MS[duration[2]!]!;
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) {
    throw new Error(`无法识别的时间 "${text}"（可用：7d / 24h / 30m / 2026-11-01）`);
  }
  return parsed;
}

/** 按日期倒序返回审计文件全路径 */
export function listAuditFiles(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => DAY_FILE.test(name))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((name) => join(dir, name));
}

export function readRecords(filter: AuditFilter): AuditRecord[] {
  const limit = filter.limit ?? Number.POSITIVE_INFINITY;
  const out: AuditRecord[] = [];

  for (const file of listAuditFiles(filter.dir)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (line === '') continue;

      let record: AuditRecord;
      try {
        record = JSON.parse(line) as AuditRecord;
      } catch {
        continue; // 半行（进程被强杀）直接跳过，不因此中断查询
      }

      const ts = Date.parse(record.ts);
      if (Number.isNaN(ts)) continue;

      // 文件内是时间升序，倒序读时一旦早于 since 就可以整个文件收手
      if (filter.since !== undefined && ts < filter.since) break;
      if (filter.until !== undefined && ts > filter.until) continue;
      if (filter.decision !== undefined && record.decision !== filter.decision) continue;
      if (filter.tool !== undefined && record.tool !== filter.tool) continue;

      out.push(record);
      if (out.length >= limit) return out;
    }
  }

  return out;
}

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(records: readonly AuditRecord[]): string {
  const header = ['ts', 'reqId', 'tool', 'decision', 'raw', 'ruleId', 'ms', 'session', 'agent', 'args'];
  const rows = records.map((r) =>
    [
      r.ts,
      r.reqId,
      r.tool,
      r.decision,
      r.raw ?? '',
      r.ruleId ?? '',
      r.ms,
      r.session,
      r.agent ?? '',
      r.args,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}

export interface Stats {
  readonly total: number;
  readonly decisions: Record<string, number>;
  readonly rules: Array<{ ruleId: string; count: number }>;
  readonly tools: Array<{ tool: string; count: number }>;
  readonly since: number | null;
  readonly until: number | null;
}

export function summarize(records: readonly AuditRecord[]): Stats {
  const decisions: Record<string, number> = {};
  const rules = new Map<string, number>();
  const tools = new Map<string, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const record of records) {
    decisions[record.decision] = (decisions[record.decision] ?? 0) + 1;
    const rule = record.ruleId ?? '(未命中规则)';
    rules.set(rule, (rules.get(rule) ?? 0) + 1);
    tools.set(record.tool, (tools.get(record.tool) ?? 0) + 1);

    const ts = Date.parse(record.ts);
    if (!Number.isNaN(ts)) {
      min = Math.min(min, ts);
      max = Math.max(max, ts);
    }
  }

  return {
    total: records.length,
    decisions,
    rules: [...rules.entries()]
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort((a, b) => b.count - a.count),
    tools: [...tools.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count),
    since: Number.isFinite(min) ? min : null,
    until: Number.isFinite(max) ? max : null,
  };
}

export function formatTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}
