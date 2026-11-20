/**
 * 匹配层：把 YAML 里的 match 块编译成可执行判定。
 *
 * 语义（方案第 4 章「必须说死的五条」）：
 *   - 字段路径从 args 根开始点号分隔；`tool` 是特例
 *   - 五种操作符：glob / regex / equals / in / prefix
 *   - 同一个操作符的多值 → OR
 *   - 同一规则的多字段 → AND
 *   - 优先级 deny > ask > allow（在 decide.ts）；同档按声明顺序取第一条
 *
 * 两个防呆设计：
 *   - `args.*` 字段必须写成操作符对象，裸字符串会被拒绝并给出提示。
 *     裸值只能当 `equals` 用，而用户写 `args.path: "**\/.env"` 时 99% 想表达 glob。
 *   - 所有 regex / glob 在加载期预编译，写错就是启动失败，而不是第一次调用才炸。
 */

import { logger } from '../logger.js';
import { compileGlob, matchGlob } from './glob.js';
import {
  PolicyError,
  type CompiledRule,
  type Decision,
  type FieldMatcher,
  type OperatorKind,
  type Scalar,
} from './types.js';

const DECISIONS: readonly Decision[] = ['allow', 'deny', 'ask'];
const OPERATORS: readonly OperatorKind[] = ['glob', 'regex', 'equals', 'in', 'prefix'];
const RULE_KEYS = new Set(['id', 'match', 'decision', 'reason']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }
  return String(value);
}

/** 从对象里按路径取值；支持数组下标（`args.files.0.path`） */
export function getPath(root: unknown, path: readonly string[]): unknown {
  let cur: unknown = root;
  for (const key of path) {
    if (Array.isArray(cur) && /^\d+$/.test(key)) {
      cur = cur[Number(key)];
      continue;
    }
    if (!isRecord(cur) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/* ------------------------------------------------------------------ *
 * 正则回溯风险 lint（W7 加固）
 *
 * JS 没有正则超时。用户写一条 `(a+)+$`，agent 递上 30 个 'a' 就能把整个网关
 * 卡死几十秒 —— 表现为「agent 突然不动了」，而拦截逻辑根本没机会执行。
 *
 * 真正的解法是把正则丢进 worker + 超时，但当前判定链是同步的，改造成本远超本版收益。
 * 所以这里做「加载期体检 + 明确告警」：识别「组内无序量词 + 组本身无限量词」并且
 * 组内没有任何强制分隔符的情况。我们自己的策略包必须零告警（有单测守着）。
 * ------------------------------------------------------------------ */

interface RToken {
  readonly kind: 'literal' | 'class' | 'dot' | 'group' | 'alt' | 'anchor';
  readonly quantified: boolean;
  readonly unbounded: boolean;
}

function tokenize(source: string): RToken[] {
  const tokens: { kind: RToken['kind']; quantified: boolean; unbounded: boolean }[] = [];
  let i = 0;

  const markQuantifier = (unbounded: boolean): void => {
    const last = tokens[tokens.length - 1];
    if (last === undefined) return;
    last.quantified = true;
    last.unbounded = last.unbounded || unbounded;
  };

  while (i < source.length) {
    const ch = source[i]!;

    if (ch === '\\') {
      tokens.push({ kind: 'literal', quantified: false, unbounded: false });
      i += 2;
      continue;
    }

    if (ch === '[') {
      let j = i + 1;
      while (j < source.length && source[j] !== ']') {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      tokens.push({ kind: 'class', quantified: false, unbounded: false });
      i = j + 1;
      continue;
    }

    if (ch === '(') {
      let depth = 0;
      let j = i;
      for (; j < source.length; j++) {
        if (source[j] === '\\') {
          j += 1;
          continue;
        }
        if (source[j] === '[') {
          while (j < source.length && source[j] !== ']') {
            if (source[j] === '\\') j += 1;
            j += 1;
          }
          continue;
        }
        if (source[j] === '(') depth += 1;
        if (source[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      tokens.push({ kind: 'group', quantified: false, unbounded: false });
      i = j + 1;
      continue;
    }

    if (ch === '.') {
      tokens.push({ kind: 'dot', quantified: false, unbounded: false });
      i += 1;
      continue;
    }

    if (ch === '|') {
      tokens.push({ kind: 'alt', quantified: false, unbounded: false });
      i += 1;
      continue;
    }

    if (ch === '^' || ch === '$') {
      tokens.push({ kind: 'anchor', quantified: false, unbounded: false });
      i += 1;
      continue;
    }

    if (ch === '*' || ch === '+') {
      markQuantifier(true);
      i += 1;
      continue;
    }

    if (ch === '?') {
      markQuantifier(false);
      i += 1;
      continue;
    }

    if (ch === '{') {
      const close = source.indexOf('}', i);
      if (close !== -1) {
        const body = source.slice(i + 1, close);
        markQuantifier(body.includes(',') && body.trim().endsWith(','));
        i = close + 1;
        continue;
      }
    }

    tokens.push({ kind: 'literal', quantified: false, unbounded: false });
    i += 1;
  }

  return tokens as RToken[];
}

/** 去掉 `(?:` / `(?<name>` / `(?=` / `?!` / `?<=` / `?<!` 这些组前缀，只留真正的 body */
function stripGroupPrefix(body: string): string {
  if (!body.startsWith('?')) return body;
  if (body.startsWith('?:')) return body.slice(2);
  if (body.startsWith('?<=') || body.startsWith('?<!')) return body.slice(3);
  if (body.startsWith('?<')) {
    const close = body.indexOf('>');
    return close === -1 ? body.slice(2) : body.slice(close + 1);
  }
  if (body.startsWith('?=') || body.startsWith('?!')) return body.slice(2);
  return body.slice(1);
}

/** 返回告警文案；null 表示这条正则没有明显的回溯风险 */
export function lintRegex(pattern: string): string | null {
  const source = pattern;
  let i = 0;

  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === '[') {
      i += 1;
      while (i < source.length && source[i] !== ']') {
        if (source[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (source[i] !== '(') {
      i += 1;
      continue;
    }

    // 找到一个组，取它的 body 与紧随其后的量词
    let depth = 0;
    let j = i;
    for (; j < source.length; j++) {
      if (source[j] === '\\') {
        j += 1;
        continue;
      }
      if (source[j] === '[') {
        while (j < source.length && source[j] !== ']') {
          if (source[j] === '\\') j += 1;
          j += 1;
        }
        continue;
      }
      if (source[j] === '(') depth += 1;
      if (source[j] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const rawBody = source.slice(i + 1, j);
    const body = stripGroupPrefix(rawBody);
    const after = source.slice(j + 1, j + 8);

    const outerUnbounded = /^(?:[*+]|\{\d+,\})/.test(after);
    if (outerUnbounded) {
      const tokens = tokenize(body);
      const hasInnerUnbounded = tokens.some((token) => token.unbounded);
      const first = tokens[0];
      const last = tokens[tokens.length - 1];
      const headSolid = first !== undefined && first.kind === 'literal' && !first.quantified;
      const tailSolid = last !== undefined && last.kind === 'literal' && !last.quantified;

      if (hasInnerUnbounded && !headSolid && !tailSolid) {
        return `存在嵌套量词且组内没有固定分隔符（如 (a+)+），恶意输入可能触发回溯爆炸把网关卡死`;
      }
    }

    i = j + 1;
  }

  return null;
}

/* ------------------------------------------------------------------ */

function parseFieldPath(field: string, origin: string, ruleId: string): string[] {
  if (field === 'tool') return ['tool'];
  if (field.startsWith('args.')) {
    const rest = field.slice('args.'.length);
    if (rest === '') {
      throw new PolicyError('字段 "args." 后必须跟子路径', origin, ruleId);
    }
    return ['args', ...rest.split('.')];
  }
  throw new PolicyError(
    `不认识的字段 "${field}"：只支持 "tool" 或 "args.<子路径>"`,
    origin,
    ruleId,
  );
}

function asStringList(op: OperatorKind, value: unknown, field: string, origin: string, ruleId: string): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) {
    throw new PolicyError(`字段 "${field}" 的 ${op} 取值不能是空数组`, origin, ruleId);
  }
  return list.map((item) => {
    if (typeof item !== 'string' || item === '') {
      throw new PolicyError(`字段 "${field}" 的 ${op} 只能是非空字符串`, origin, ruleId);
    }
    return item;
  });
}

function asScalarList(value: unknown, field: string, origin: string, ruleId: string): Scalar[] {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) {
    throw new PolicyError(`字段 "${field}" 的取值不能是空数组`, origin, ruleId);
  }
  return list.map((item) => {
    if (!isScalar(item)) {
      throw new PolicyError(`字段 "${field}" 的取值只能是字符串 / 数字 / 布尔`, origin, ruleId);
    }
    return item;
  });
}

function compileMatcher(field: string, raw: unknown, origin: string, ruleId: string): FieldMatcher {
  const path = parseFieldPath(field, origin, ruleId);

  let op: OperatorKind;
  let rawValue: unknown;

  if (isRecord(raw)) {
    const keys = Object.keys(raw);
    const opKeys = keys.filter((key) => (OPERATORS as readonly string[]).includes(key));
    if (opKeys.length === 0) {
      throw new PolicyError(
        `字段 "${field}" 的对象里没有合法操作符（可用：${OPERATORS.join(' / ')}）`,
        origin,
        ruleId,
      );
    }
    if (opKeys.length > 1) {
      throw new PolicyError(
        `字段 "${field}" 同时写了多个操作符（${opKeys.join(', ')}），只能选一个`,
        origin,
        ruleId,
      );
    }
    const unknownKeys = keys.filter((key) => !(OPERATORS as readonly string[]).includes(key));
    if (unknownKeys.length > 0) {
      throw new PolicyError(
        `字段 "${field}" 出现未知键 "${unknownKeys.join(', ')}"`,
        origin,
        ruleId,
      );
    }
    op = opKeys[0] as OperatorKind;
    rawValue = raw[op];
  } else {
    // 裸值只允许用在 tool 上（`tool: bash` / `tool: [a, b]`），args 字段必须显式写操作符
    if (field !== 'tool') {
      throw new PolicyError(
        `字段 "${field}" 必须写成操作符对象，例如 { glob: "**/.env*" }；` +
          `裸值会被误读成 equals，写错了不会报错但永不命中`,
        origin,
        ruleId,
      );
    }
    op = Array.isArray(raw) ? 'in' : 'equals';
    rawValue = raw;
  }

  if (op === 'in' && !Array.isArray(rawValue)) {
    throw new PolicyError(`字段 "${field}" 的 in 取值得是数组`, origin, ruleId);
  }

  switch (op) {
    case 'glob': {
      const patterns = asStringList(op, rawValue, field, origin, ruleId);
      return {
        field,
        path,
        op,
        patterns,
        regexes: [],
        globs: patterns.map((pattern) => {
          try {
            return compileGlob(pattern);
          } catch (err) {
            throw new PolicyError(`字段 "${field}" 的 glob 无效：${(err as Error).message}`, origin, ruleId);
          }
        }),
      };
    }

    case 'regex': {
      const patterns = asStringList(op, rawValue, field, origin, ruleId);
      return {
        field,
        path,
        op,
        patterns,
        // 大小写不敏感：安全方向上宁多拦不漏拦
        regexes: patterns.map((pattern) => {
          try {
            new RegExp(pattern, 'i');
          } catch (err) {
            throw new PolicyError(
              `字段 "${field}" 的 regex 无效：${(err as Error).message}（模式：${pattern}）`,
              origin,
              ruleId,
            );
          }
          const warning = lintRegex(pattern);
          if (warning !== null) {
            logger.warn(`规则 ${ruleId} 的正则可能有回溯风险：${warning}`, { pattern });
          }
          return new RegExp(pattern, 'i');
        }),
        globs: [],
      };
    }

    case 'prefix':
    case 'equals':
    case 'in': {
      if (op === 'prefix') asStringList(op, rawValue, field, origin, ruleId);
      return {
        field,
        path,
        op,
        patterns: asScalarList(rawValue, field, origin, ruleId),
        regexes: [],
        globs: [],
      };
    }
  }
}

/* ------------------------------------------------------------------ */

function patternHits(matcher: FieldMatcher, value: unknown): boolean {
  const text = toText(value);

  switch (matcher.op) {
    case 'equals':
      return matcher.patterns.some((pattern) => toText(pattern) === text);
    case 'prefix':
      return matcher.patterns.some((pattern) => text.startsWith(toText(pattern)));
    case 'in':
      return matcher.patterns.some((pattern) => toText(pattern) === text);
    case 'regex':
      return matcher.regexes.some((re) => re.test(text));
    case 'glob':
      return matcher.globs.some((glob) => matchGlob(glob, text));
  }
}

function fieldHits(matcher: FieldMatcher, tool: string, args: unknown): boolean {
  const value =
    matcher.path[0] === 'tool' ? tool : getPath(args, matcher.path.slice(1));

  if (value === undefined) return false;

  // 实参是数组时逐个判定：`read_multiple_files` 传 [safe.txt, .env] 必须能命中 .env
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) => patternHits(matcher, item));
}

export function compileRule(raw: unknown, origin: string, index: number): CompiledRule {
  if (!isRecord(raw)) {
    throw new PolicyError(`rules[${index}] 必须是对象`, origin);
  }

  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) {
      throw new PolicyError(`rules[${index}] 出现未知键 "${key}"（可用：id / match / decision / reason）`, origin);
    }
  }

  const id = raw.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    throw new PolicyError(
      `rules[${index}] 的 id 缺失或不合法（只允许字母、数字、. _ -，且不能以符号开头）`,
      origin,
    );
  }

  const decision = raw.decision;
  if (typeof decision !== 'string' || !(DECISIONS as readonly string[]).includes(decision)) {
    throw new PolicyError(`规则 "${id}" 的 decision 必须是 ${DECISIONS.join(' / ')}`, origin, id);
  }

  let reason: string | null = null;
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') {
      throw new PolicyError(`规则 "${id}" 的 reason 必须是字符串`, origin, id);
    }
    reason = raw.reason;
  }

  const match = raw.match;
  if (!isRecord(match)) {
    throw new PolicyError(`规则 "${id}" 缺少 match 块`, origin, id);
  }
  const fields = Object.keys(match);
  if (fields.length === 0) {
    throw new PolicyError(
      `规则 "${id}" 的 match 为空 —— 空 match 会命中一切调用，若确实要全放行请用 defaults.on_no_match: allow`,
      origin,
      id,
    );
  }

  const matchers = fields.map((field) => compileMatcher(field, match[field], origin, id));

  return {
    id,
    decision: decision as Decision,
    reason,
    matchers,
    origin,
    test: (tool: string, args: unknown) => matchers.every((matcher) => fieldHits(matcher, tool, args)),
  };
}

export function compileRules(rawRules: readonly unknown[], origin: string): CompiledRule[] {
  return rawRules.map((raw, index) => compileRule(raw, origin, index));
}
