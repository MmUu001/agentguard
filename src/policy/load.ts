/**
 * 策略加载：YAML → 校验 → 编译。
 *
 * 三条硬规则（方案第 4 章「三个必须坚持的设计决策」）：
 *   1. fail-closed 是默认值：没写 on_no_match 就是 deny。
 *   2. 语法错误 = 加载失败。任何一条写错的规则都不允许被静默忽略 ——
 *      静默忽略等于给用户假的安心。
 *   3. 加载期就把 regex / glob 编译掉，写错立刻报，而不是等第一次调用。
 *
 * 多文件合并：按传入顺序拼接规则（先文件的规则先声明）。同档判定取第一条，
 * 所以「项目 > 用户 > 内置」只要按这个顺序传路径即可。
 */

import { readFileSync } from 'node:fs';

import { parse as parseYaml } from 'yaml';

import { compileRules } from './match.js';
import {
  PolicyError,
  type CompiledPolicy,
  type CompiledRule,
  type Decision,
  type LimitRule,
} from './types.js';

const ROOT_KEYS = new Set(['version', 'defaults', 'rules', 'limits']);
const DEFAULTS_KEYS = new Set(['on_no_match', 'dry_run']);
const LIMIT_KEYS = new Set(['tool', 'max_calls', 'window']);
const DECISIONS: readonly Decision[] = ['allow', 'deny', 'ask'];
const WINDOW_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
const WINDOW_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

interface ParsedDoc {
  readonly version: number;
  readonly defaults: { onNoMatch?: Decision; dryRun?: boolean };
  readonly rules: CompiledRule[];
  readonly limits: LimitRule[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWindow(value: unknown, origin: string, where: string): { ms: number; raw: string } {
  if (typeof value !== 'string') {
    throw new PolicyError(`${where} 的 window 必须是字符串，例如 "1h"`, origin);
  }
  const m = WINDOW_PATTERN.exec(value.trim());
  if (m === null) {
    throw new PolicyError(`${where} 的 window "${value}" 无法识别（可用：30s / 5m / 1h / 1d）`, origin);
  }
  const unit = WINDOW_UNIT_MS[m[2]!]!;
  return { ms: Number(m[1]) * unit, raw: value };
}

function parseDefaults(raw: unknown, origin: string): ParsedDoc['defaults'] {
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    throw new PolicyError('defaults 必须是对象', origin);
  }
  for (const key of Object.keys(raw)) {
    if (!DEFAULTS_KEYS.has(key)) {
      throw new PolicyError(`defaults 出现未知键 "${key}"（可用：on_no_match / dry_run）`, origin);
    }
  }

  const out: ParsedDoc['defaults'] = {};

  if (raw.on_no_match !== undefined) {
    const value = raw.on_no_match;
    if (typeof value !== 'string' || !(DECISIONS as readonly string[]).includes(value)) {
      throw new PolicyError(
        `defaults.on_no_match 必须是 ${DECISIONS.join(' / ')}，收到 ${JSON.stringify(value)}`,
        origin,
      );
    }
    out.onNoMatch = value as Decision;
  }

  if (raw.dry_run !== undefined) {
    if (typeof raw.dry_run !== 'boolean') {
      throw new PolicyError('defaults.dry_run 必须是 true / false', origin);
    }
    out.dryRun = raw.dry_run;
  }

  return out;
}

function parseLimits(raw: unknown, origin: string): LimitRule[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PolicyError('limits 必须是数组', origin);
  }

  return raw.map((entry, index) => {
    const where = `limits[${index}]`;
    if (!isRecord(entry)) {
      throw new PolicyError(`${where} 必须是对象`, origin);
    }
    for (const key of Object.keys(entry)) {
      if (!LIMIT_KEYS.has(key)) {
        throw new PolicyError(`${where} 出现未知键 "${key}"（可用：tool / max_calls / window）`, origin);
      }
    }

    const tool = entry.tool;
    const tools = Array.isArray(tool) ? tool : [tool];
    if (tools.length === 0 || tools.some((t) => typeof t !== 'string' || t === '')) {
      throw new PolicyError(`${where} 的 tool 必须是非空字符串或非空字符串数组`, origin);
    }

    const maxCalls = entry.max_calls;
    if (typeof maxCalls !== 'number' || !Number.isInteger(maxCalls) || maxCalls <= 0) {
      throw new PolicyError(`${where} 的 max_calls 必须是正整数`, origin);
    }

    const window = parseWindow(entry.window, origin, where);

    return {
      tools: tools as string[],
      maxCalls,
      windowMs: window.ms,
      window: window.raw,
      origin,
    };
  });
}

function parseDocument(text: string, origin: string): ParsedDoc {
  let root: unknown;
  try {
    root = parseYaml(text);
  } catch (err) {
    throw new PolicyError(`YAML 解析失败：${(err as Error).message}`, origin);
  }

  if (root === null || root === undefined) {
    throw new PolicyError('策略文件是空的', origin);
  }
  if (!isRecord(root)) {
    throw new PolicyError('策略文件顶层必须是对象（version / defaults / rules / limits）', origin);
  }

  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.has(key)) {
      throw new PolicyError(`顶层出现未知键 "${key}"（可用：version / defaults / rules / limits）`, origin);
    }
  }

  if (root.version !== 1) {
    throw new PolicyError(
      `version 必须是 1，收到 ${JSON.stringify(root.version)} —— 版本不对时拒绝加载，避免语义漂移`,
      origin,
    );
  }

  const defaults = parseDefaults(root.defaults, origin);
  const limits = parseLimits(root.limits, origin);

  const rawRules = root.rules === undefined ? [] : root.rules;
  if (!Array.isArray(rawRules)) {
    throw new PolicyError('rules 必须是数组', origin);
  }

  const rules = compileRules(rawRules, origin);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new PolicyError(`规则 id "${rule.id}" 重复`, origin, rule.id);
    }
    seen.add(rule.id);
  }

  return { version: 1, defaults, rules, limits };
}

/** 解析单个策略文本（测试与 `check` 子命令用） */
export function parsePolicy(text: string, origin = '<inline>'): CompiledPolicy {
  const doc = parseDocument(text, origin);
  return {
    version: doc.version,
    defaults: {
      onNoMatch: doc.defaults.onNoMatch ?? 'deny',
      dryRun: doc.defaults.dryRun ?? false,
    },
    rules: doc.rules,
    limits: doc.limits,
    sources: [origin],
  };
}

/**
 * 按顺序加载并合并多个策略文件。
 * 规则按文件顺序拼接；defaults 由后出现的文件覆盖（同键）；sources 记录全部出处。
 */
export function loadPolicy(paths: string | readonly string[]): CompiledPolicy {
  const list = typeof paths === 'string' ? [paths] : [...paths];
  if (list.length === 0) {
    throw new PolicyError('没有指定策略文件');
  }

  const rules: CompiledRule[] = [];
  const limits: LimitRule[] = [];
  const sources: string[] = [];
  let onNoMatch: Decision | undefined;
  let dryRun: boolean | undefined;
  const idOrigin = new Map<string, string>();

  for (const file of list) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new PolicyError(`无法读取策略文件：${(err as Error).message}`, file);
    }

    const doc = parseDocument(text.replace(/^\uFEFF/, ''), file);
    sources.push(file);

    if (doc.defaults.onNoMatch !== undefined) onNoMatch = doc.defaults.onNoMatch;
    if (doc.defaults.dryRun !== undefined) dryRun = doc.defaults.dryRun;

    for (const rule of doc.rules) {
      const previous = idOrigin.get(rule.id);
      if (previous !== undefined) {
        throw new PolicyError(
          `规则 id "${rule.id}" 与 ${previous} 重复 —— id 会出现在审计日志里，必须全局唯一`,
          file,
          rule.id,
        );
      }
      idOrigin.set(rule.id, file);
      rules.push(rule);
    }

    limits.push(...doc.limits);
  }

  return {
    version: 1,
    defaults: { onNoMatch: onNoMatch ?? 'deny', dryRun: dryRun ?? false },
    rules,
    limits,
    sources,
  };
}
