/**
 * W7 验收 · 正则回溯风险
 *
 * JS 没有正则超时，`(a+)+$` 这类模式在 25 个字符上就能让网关卡住几十毫秒到几十秒。
 * 本版的做法是「加载期体检 + 明确告警」（判定链仍是同步的，worker + 超时的改造成本
 * 远超本版收益）。这里要证明两件事：
 *   1. lint 能识别危险模式，且**我们自己的四套策略包零告警**（否则就是狼来了）
 *   2. 这类模式确实会变慢 —— 不是理论恐吓，是实测
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintRegex } from '../dist/policy/match.js';
import { loadPolicy } from '../dist/policy/load.js';

process.env.AGENTGUARD_AUDIT = 'off';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const NODE = process.execPath;
const TMP = join(ROOT, '.tmp', 'lint');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

console.log('agentguard W7 · 正则回溯风险\n');

/* ---------------- 1. 能识别危险模式 ---------------- */
for (const pattern of ['(a+)+', '(.*)*', '(\\w+\\s*)+', '([a-z]+)+', '(?<x>\\d+)+']) {
  const warning = lintRegex(pattern);
  check(`识别危险模式 ${pattern}`, warning !== null);
}

/* ---------------- 2. 不误报正常模式 ---------------- */
const safe = [
  '(?:-[a-zA-Z]+\\s+)*',
  '(?:\\d+\\.)+',
  '\\b(?:drop\\s+(?:table|database|schema)|truncate\\s+table)\\b',
  '(?:curl|wget)\\s[^\\n|]*\\|\\s*(?:sudo\\s+)?(?:ba|z|k)?sh\\b',
  'git\\s+push\\s+(?:[^\\n]*\\s)?(?:-f\\b|--force(?!-))',
  '(?:^|[/\\\\])\\.env(?:\\.(?!example$|sample$|template$)[A-Za-z0-9_-]+)*$',
];
for (const pattern of safe) {
  const warning = lintRegex(pattern);
  check(`不误报 ${pattern.slice(0, 44)}`, warning === null, warning ?? '');
}

/* ---------------- 3. 四套策略包零告警 ---------------- */
{
  const packs = ['core', 'secrets', 'git', 'net'].map((id) => resolve(ROOT, 'packs', `${id}.yaml`));
  let warnings = 0;
  const originals = [];
  const originalWarn = console.warn;

  // 直接扫 pack 里的每一行 regex 值，比捕获日志更直接
  const { readFileSync } = await import('node:fs');
  const { parse: parseYaml } = await import('yaml');

  for (const file of packs) {
    const doc = parseYaml(readFileSync(file, 'utf8'));
    for (const rule of doc?.rules ?? []) {
      for (const value of Object.values(rule.match ?? {})) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
        const patterns = value.regex;
        if (patterns === undefined) continue;
        for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
          const warning = lintRegex(String(pattern));
          if (warning !== null) {
            warnings += 1;
            originals.push(`${rule.id}: ${pattern}`);
          }
        }
      }
    }
  }

  check(
    '四套策略包的正则零回溯告警',
    warnings === 0,
    warnings === 0 ? '（自己写的包先不能报，否则用户会忽略告警）' : originals.join(' | '),
  );
}

/* ---------------- 4. 加载时真的会告警 ---------------- */
{
  const bad = join(TMP, 'redos.yaml');
  writeFileSync(
    bad,
    `version: 1
rules:
  - id: redos-demo
    match:
      tool: bash
      args.command: { regex: '^(a+)+$' }
    decision: deny
`,
  );

  const out = await new Promise((res) => {
    const proc = spawn(NODE, [MAIN, 'check', '--policy', bad], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTGUARD_AUDIT: 'off', AGENTGUARD_LOG: 'warn' },
    });
    let stderr = '';
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => res({ code, stdout, stderr }));
  });

  check(
    '加载危险正则时在 stderr 告警',
    out.code === 0 && out.stderr.includes('回溯') && out.stderr.includes('redos-demo'),
    out.stderr.split('\n')[0]?.slice(0, 80) ?? '',
  );
  check('告警不污染 stdout', !out.stdout.includes('回溯'));
}

/* ---------------- 5. 实测：危险模式确实会变慢 ---------------- */
{
  const dangerous = new RegExp('^(a+)+$');
  const input = 'a'.repeat(26) + '!';

  const t0 = process.hrtime.bigint();
  dangerous.test(input);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  // 26 个字符约 2^26 次回溯。这条断言的意义是留下证据，不是追求某个绝对值
  check(
    '危险正则在 26 字符输入上已出现明显耗时（实测证据）',
    elapsedMs > 5,
    `${elapsedMs.toFixed(1)}ms / 26 字符`,
  );

  const t1 = process.hrtime.bigint();
  new RegExp('^(?:-[a-zA-Z]+\\s+)*').test('rm ' + '-a '.repeat(30));
  const safeMs = Number(process.hrtime.bigint() - t1) / 1e6;
  check('正常模式的同规模输入保持线性', safeMs < 2, `${safeMs.toFixed(3)}ms`);
}

/* ---------------- 6. 四套包合起来仍能正常加载 ---------------- */
{
  const all = ['core', 'secrets', 'git', 'net'].map((id) => resolve(ROOT, 'packs', `${id}.yaml`));
  const policy = loadPolicy(all);
  check('四套包合并加载成功', policy.rules.length >= 27, `${policy.rules.length} 条规则`);
}

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
