/**
 * 限流执行（W4）。
 *
 * 语义与方案一致：`limits: [{ tool: bash, max_calls: 200, window: 1h }]`
 * —— 每个窗口内该工具的调用次数上限，超出回 -32004。
 *
 * 两个刻意的实现选择：
 *   1. **按规则 + 工具各自计数**：一条 limit 写了多个工具时，是「每个工具各自限额」，
 *      而不是共享一个桶。前者更符合「防止某个工具跑飞」的直觉。
 *   2. **固定窗口**而非滑动窗口：实现简单、行为可预测、内存 O(规则数)。
 *      代价是窗口边界可能放过最多 2 倍瞬时流量 —— 对「防止整夜烧钱」这个诉求足够。
 */

import type { LimitRule } from './policy/types.js';

export interface LimitCheck {
  readonly ok: boolean;
  readonly rule: LimitRule | null;
  readonly count: number;
  readonly maxCalls: number;
}

interface Bucket {
  count: number;
  start: number;
}

export class LimitTracker {
  readonly #rules: readonly LimitRule[];
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(rules: readonly LimitRule[], now: () => number = Date.now) {
    this.#rules = rules;
    this.#now = now;
  }

  /** 记一次调用并判定；无论放行与否都要调用，这样「被拒后继续重试」也会被计数 */
  check(tool: string): LimitCheck {
    const now = this.#now();
    let blocked: LimitCheck | null = null;

    for (let index = 0; index < this.#rules.length; index++) {
      const rule = this.#rules[index]!;
      if (!rule.tools.includes(tool)) continue;

      const key = `${index}:${tool}`;
      let bucket = this.#buckets.get(key);
      if (bucket === undefined || now - bucket.start >= rule.windowMs) {
        bucket = { count: 0, start: now };
        this.#buckets.set(key, bucket);
      }
      bucket.count += 1;

      if (bucket.count > rule.maxCalls && blocked === null) {
        blocked = { ok: false, rule, count: bucket.count, maxCalls: rule.maxCalls };
      }
    }

    return blocked ?? { ok: true, rule: null, count: 0, maxCalls: 0 };
  }
}
