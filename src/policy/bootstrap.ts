/**
 * 策略文件的「开箱默认值」：dev 基线 + 各策略包的规则，拼成一份可直接加载的 YAML 文本。
 *
 * 被两处使用：
 *   - `agentguard init` 写盘
 *   - `agentguard demo` 在没有策略文件时临时构造一份（否则演示全是 deny，看不出效果）
 *
 * 之所以放在这里而不是 cli.ts：demo 也要用，而 cli → demo → cli 会形成循环依赖。
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { findPack, readPackText } from '../packs.js';

export interface PolicyGroup {
  readonly label: string;
  readonly rules: readonly unknown[];
}

/**
 * dev profile 的基线放行。
 *
 * 为什么需要它：fail-closed 意味着「没写 allow 的工具一律拒绝」，
 * 如果生成的文件里一条 allow 都没有，用户接上去 agent 立刻瘫痪，
 * 第一反应就是把这个东西卸了 —— 那安全价值等于 0。
 * 所以基线放行「日常开发必用」的工具，危险动作交给各包的 deny 规则兜住。
 *
 * 想要「只跑白名单工具」的严格模式：`--profile strict`，不生成这些规则。
 */
export function baselineRules(): unknown[] {
  return [
    {
      id: 'base-allow-command',
      match: { tool: ['bash', 'shell', 'run_command', 'execute_command', 'terminal', 'powershell'] },
      decision: 'allow',
      reason: '基线：放行命令工具（危险命令由各包的 deny 规则拦截）',
    },
    {
      id: 'base-allow-argless',
      match: {
        tool: [
          'list_allowed_directories',
          'grep',
          'glob',
          'search',
          'codebase_search',
          'list_tools',
        ],
      },
      decision: 'allow',
      reason: '基线：放行无路径参数的只读工具',
    },
    {
      id: 'base-allow-read',
      match: {
        tool: ['read_file', 'read_text_file', 'view_file', 'open_file', 'list_directory', 'directory_tree', 'get_file_info', 'search_files'],
        'args.path': { glob: '**' },
      },
      decision: 'allow',
      reason: '基线：放行文件读取',
    },
    {
      id: 'base-allow-read-multi',
      match: { tool: ['read_multiple_files'], 'args.paths': { glob: '**' } },
      decision: 'allow',
      reason: '基线：放行批量文件读取',
    },
    {
      id: 'base-allow-write',
      match: {
        tool: ['write_file', 'write_text_file', 'edit_file', 'create_directory', 'move_file', 'apply_patch'],
        'args.path': { glob: '**' },
      },
      decision: 'allow',
      reason: '基线：放行文件写入（系统目录与凭据目录由 core/secrets 拦截）',
    },
  ];
}

function renderBlock(value: unknown): string {
  const text = stringifyYaml(value, { lineWidth: 0 }).replace(/\n+$/, '');
  const lines = text.split('\n');
  return ['  - ' + lines[0], ...lines.slice(1).map((line) => '    ' + line)].join('\n');
}

/** 把若干组规则 + 限流渲染成一份完整的策略文本 */
export function buildPolicyText(options: {
  dryRun: boolean;
  groups: readonly PolicyGroup[];
  limits: readonly unknown[];
}): string {
  const out: string[] = [
    '# agentguard policy —— 由 `agentguard init` 生成，可以直接手改。',
    '# 改完跑 `agentguard check --policy <本文件>`，确认它会拦什么再接入。',
    '# 优先级：deny > ask > allow；同档取声明在前的一条。',
    'version: 1',
    '',
    'defaults:',
    '  # 没有任何规则命中时怎么办：deny | allow | ask（默认 deny，fail-closed）',
    '  on_no_match: deny',
    '  # 观察模式：true 时只记录不拦截。第一次接入建议先用 --observe 跑一周',
    `  dry_run: ${options.dryRun}`,
    '',
    'rules:',
  ];

  for (const group of options.groups) {
    out.push(`  # ── ${group.label}（${group.rules.length} 条）`);
    for (const rule of group.rules) out.push(renderBlock(rule));
  }

  if (options.limits.length > 0) {
    out.push('');
    out.push('limits:');
    for (const limit of options.limits) out.push(renderBlock(limit));
  }

  return out.join('\n') + '\n';
}

export function readPackDoc(id: string): { rules: unknown[]; limits: unknown[] } {
  const parsed = parseYaml(readPackText(id)) as { rules?: unknown; limits?: unknown } | null;
  return {
    rules: Array.isArray(parsed?.rules) ? parsed.rules : [],
    limits: Array.isArray(parsed?.limits) ? parsed.limits : [],
  };
}

/** init / demo 共用的「标准策略」：基线 + 指定包 */
export function buildDefaultPolicyText(
  packs: readonly string[],
  options: { dryRun?: boolean; profile?: 'dev' | 'strict' } = {},
): string {
  const profile = options.profile ?? 'dev';
  const groups: PolicyGroup[] = [];

  if (profile === 'dev') {
    groups.push({ label: '基线放行 · dev profile', rules: baselineRules() });
  }

  const limits: unknown[] = [];
  for (const id of packs) {
    const doc = readPackDoc(id);
    const title = findPack(id)?.title ?? id;
    groups.push({ label: `${title} · pack:${id}`, rules: doc.rules });
    limits.push(...doc.limits);
  }

  return buildPolicyText({ dryRun: options.dryRun === true, groups, limits });
}
