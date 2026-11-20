/**
 * 判定层：给定 tool 与 args，输出 allow / deny / ask。
 *
 * 优先级 deny > ask > allow，同档按声明顺序取第一条。
 * 这个顺序不是「再想一层」的优化，是为了消除「规则顺序决定结果」的意外：
 * 用户在文件末尾补一条 allow 不会意外放开一条 deny。
 *
 * 没有任何规则命中时走 defaults.on_no_match（默认 deny）—— fail-closed。
 */

import type { CompiledPolicy, Decision, DecisionResult } from './types.js';

const RANK: Record<Decision, number> = { allow: 1, ask: 2, deny: 3 };

export function decide(policy: CompiledPolicy, tool: string, args: unknown): DecisionResult {
  const started = process.hrtime.bigint();

  let bestRule: { decision: Decision; id: string; reason: string | null } | null = null;
  let bestRank = 0;

  for (const rule of policy.rules) {
    if (!rule.test(tool, args)) continue;

    const rank = RANK[rule.decision];
    // 严格大于才替换 → 同档自然保留「声明在前的第一条」
    if (rank > bestRank) {
      bestRank = rank;
      bestRule = { decision: rule.decision, id: rule.id, reason: rule.reason };
      if (rank === RANK.deny) break; // deny 已经是最高的，后面的不可能翻盘
    }
  }

  const raw: Decision = bestRule === null ? policy.defaults.onNoMatch : bestRule.decision;
  const ruleId = bestRule === null ? null : bestRule.id;
  const reason =
    bestRule === null
      ? `没有规则命中（on_no_match: ${policy.defaults.onNoMatch}）`
      : bestRule.reason;

  return {
    // dry_run 只记录不拦截：审计里仍然保留 raw，才能看出「本会拦下什么」
    decision: policy.defaults.dryRun ? 'allow' : raw,
    raw,
    ruleId,
    reason,
    dryRun: policy.defaults.dryRun,
    elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}
