/**
 * 策略模块的共享类型。单独成文件是为了打断 load → match → load 的循环依赖：
 *   types.ts  ←  glob.ts / match.ts / load.ts / decide.ts
 */

import type { CompiledGlob } from './glob.js';

/** 策略配置错误。必须带上出处（文件 / 规则 id / 字段），否则用户没法定位 */
export class PolicyError extends Error {
  constructor(
    message: string,
    readonly origin?: string,
    readonly ruleId?: string,
  ) {
    super(origin === undefined ? message : `${origin}: ${message}`);
    this.name = 'PolicyError';
  }
}

export type Decision = 'allow' | 'deny' | 'ask';

export type OperatorKind = 'glob' | 'regex' | 'equals' | 'in' | 'prefix';

/** 操作符的取值只能是这三类标量；数组表示 OR */
export type Scalar = string | number | boolean;

export interface FieldMatcher {
  /** 原始字段名，如 `tool` / `args.command`，报错与审计都用它 */
  readonly field: string;
  /** 从 args 根开始的路径；`tool` 是特例，只含一段 */
  readonly path: readonly string[];
  readonly op: OperatorKind;
  readonly patterns: readonly Scalar[];
  /** op = regex 时预编译 */
  readonly regexes: readonly RegExp[];
  /** op = glob 时预编译 */
  readonly globs: readonly CompiledGlob[];
}

export interface CompiledRule {
  readonly id: string;
  readonly decision: Decision;
  readonly reason: string | null;
  readonly matchers: readonly FieldMatcher[];
  readonly origin: string;
  /** 所有字段全部命中才算命中（AND） */
  readonly test: (tool: string, args: unknown) => boolean;
}

export interface PolicyDefaults {
  readonly onNoMatch: Decision;
  readonly dryRun: boolean;
}

/**
 * 限流规则。W2 只解析与校验，不执行 —— 计数需要跨调用的窗口状态，
 * 与审计一起在 W4 接入。在这里保留结构，避免用户写了 `limits` 却被静默丢弃。
 */
export interface LimitRule {
  readonly tools: readonly string[];
  readonly maxCalls: number;
  readonly windowMs: number;
  readonly window: string;
  readonly origin: string;
}

export interface CompiledPolicy {
  readonly version: number;
  readonly defaults: PolicyDefaults;
  readonly rules: readonly CompiledRule[];
  readonly limits: readonly LimitRule[];
  readonly sources: readonly string[];
}

export interface DecisionResult {
  /** 生效判定（dry_run 时恒为 allow） */
  readonly decision: Decision;
  /** 规则给出的原始判定，dry_run 时也要保留它用于审计 */
  readonly raw: Decision;
  readonly ruleId: string | null;
  readonly reason: string | null;
  readonly dryRun: boolean;
  readonly elapsedMs: number;
}
