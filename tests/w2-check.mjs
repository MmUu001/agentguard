/**
 * W2 验收 —— 策略引擎。
 *
 * 验收原文：`rm -rf /` 被拒、`ls` 放行、未匹配命令被拒。
 * 这里按更严的口径验证：三种判定的命中规则、参数顺序变体、优先级、
 * 以及「非法策略必须加载失败」的 16 种写法。
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide } from '../dist/policy/decide.js';
import { compileGlob, matchGlob } from '../dist/policy/glob.js';
import { loadPolicy, parsePolicy } from '../dist/policy/load.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const TMP = join(ROOT, '.tmp', 'w2');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};
const expectThrow = (name, fn, pattern) => {
  try {
    fn();
    check(name, false, '预期抛错但没有');
  } catch (err) {
    const msg = String(err && err.message);
    const ok = pattern === undefined || new RegExp(pattern).test(msg);
    check(name, ok, ok ? '' : `错误信息不匹配：${msg}`);
  }
};

/* ---------------- 基线策略（与方案 4.1 的示例同构） ---------------- */
const BASE = `
version: 1

defaults:
  on_no_match: deny

rules:
  - id: block-rm-rf-root
    match:
      tool: bash
      args.command:
        regex: 'rm\\s+(-[a-zA-Z]+\\s+)*-(rf|fr)\\s+/'
    decision: deny
    reason: 递归删除根目录

  - id: protect-secrets
    match:
      tool: [read_file, read_multiple_files]
      args.path:
        glob: ["**/.env*", "**/*.pem", "**/id_rsa*"]
    decision: deny
    reason: 敏感凭据文件

  - id: force-push-needs-approval
    match:
      tool: bash
      args.command:
        regex: 'git\\s+push\\s+(--force|-f)'
    decision: ask
    reason: 强制推送会覆盖远端历史

  - id: protect-secrets-multi
    match:
      tool: read_multiple_files
      args.paths:
        glob: ["**/.env*", "**/*.pem", "**/id_rsa*"]
    decision: deny
    reason: 敏感凭据文件（批量读取）

  - id: allow-read-multi
    match:
      tool: read_multiple_files
      args.paths:
        glob: "**"
    decision: allow

  - id: allow-read
    match:
      tool: [read_file, list_directory, glob]
      args.path:
        glob: "**"
    decision: allow
`;

const policy = parsePolicy(BASE, '<base>');
const d = (tool, args) => decide(policy, tool, args);

/* ---------------- 1. 三种判定 ---------------- */
console.log('agentguard W2 acceptance\n');
{
  const r = d('bash', { command: 'rm -rf /' });
  check('rm -rf / → deny', r.decision === 'deny' && r.ruleId === 'block-rm-rf-root', `${r.decision}/${r.ruleId}`);
}
{
  const r = d('list_directory', { path: '/projects' });
  check('list_directory → allow', r.decision === 'allow' && r.ruleId === 'allow-read', `${r.decision}/${r.ruleId}`);
}
{
  const r = d('some_unknown_tool', { whatever: 1 });
  check('未匹配 → deny（fail-closed）', r.decision === 'deny' && r.ruleId === null, String(r.reason));
}

/* ---------------- 2. 变体与边界 ---------------- */
{
  const r = d('bash', { command: 'rm -fr /var' });
  check('rm -fr /var → deny（参数顺序变体）', r.decision === 'deny' && r.ruleId === 'block-rm-rf-root');
}
{
  const r = d('bash', { command: 'rm -r -f /' });
  // 方案原示例的 regex 覆盖不到「拆分短参数」，这条由 fail-closed 兜住而不是规则命中。
  // 结论仍然是 deny —— 但规则本身在 W5 的 core 包里要补更宽的变体。
  check('rm -r -f / → deny（规则未覆盖，由 fail-closed 兜住）', r.decision === 'deny', `${r.decision}/${r.ruleId}`);
}
{
  const r = d('bash', { command: 'rm -rf /var/lib/mysql' });
  check('rm -rf 子目录 → 命中规则（\s+/ 匹配绝对路径）', r.decision === 'deny' && r.ruleId === 'block-rm-rf-root');
}
{
  const r = d('bash', { command: 'RM -RF /' });
  check('大写变体 → deny（regex 大小写不敏感）', r.decision === 'deny' && r.ruleId === 'block-rm-rf-root');
}
{
  const r = d('bash', { command: 'rm -rf ./build' });
  check('未命中规则的危险命令仍被 fail-closed 拦下', r.decision === 'deny' && r.ruleId === null);
}
{
  const r = d('bash', { command: 'git push --force origin main' });
  check('git push --force → ask', r.decision === 'ask' && r.ruleId === 'force-push-needs-approval');
}
{
  const r = d('bash', { command: 'git push -f' });
  check('git push -f → ask（短参数）', r.decision === 'ask' && r.ruleId === 'force-push-needs-approval');
}
for (const p of ['./.env', '.env', '.ENV', '/home/u/.env.local', '~/.ssh/id_rsa', 'certs/server.pem']) {
  const r = d('read_file', { path: p });
  check(`读 ${p} → deny`, r.decision === 'deny' && r.ruleId === 'protect-secrets', `${r.decision}/${r.ruleId}`);
}
{
  const r = d('read_file', { path: './src/index.ts' });
  check('读 ./src/index.ts → allow', r.decision === 'allow' && r.ruleId === 'allow-read');
}
{
  const r = d('read_multiple_files', { paths: ['src/a.ts', './.env'] });
  check('数组实参逐个判定（含 .env → deny）', r.decision === 'deny' && r.ruleId === 'protect-secrets-multi');
}
{
  const r = d('read_multiple_files', { paths: ['src/a.ts', 'src/b.ts'] });
  check('数组实参全安全时放行', r.decision === 'allow' && r.ruleId === 'allow-read-multi');
}
{
  const r = d('read_file', {});
  check('字段缺失时不命中规则（走 fail-closed）', r.decision === 'deny' && r.ruleId === null);
}
{
  const r = d('bash', { command: { nested: 'rm -rf /' } });
  check('非字符串实参按 JSON 文本参与匹配', r.decision === 'deny' && r.ruleId === 'block-rm-rf-root');
}

{
  const r = d('read_file', { path: 'C:\\Users\\me\\.env' });
  check('Windows 反斜杠绝对路径 → deny', r.decision === 'deny' && r.ruleId === 'protect-secrets', r.ruleId ?? '');
}
{
  const r = d('read_file', { path: '.\\config\\.env.local' });
  check('Windows 相对路径 .\\ → deny', r.decision === 'deny' && r.ruleId === 'protect-secrets', r.ruleId ?? '');
}
{
  const r = d('read_file', { path: 'C:\\Users\\me\\.ssh\\id_rsa' });
  check('Windows 路径下的 id_rsa → deny', r.decision === 'deny' && r.ruleId === 'protect-secrets');
}

/* ---------------- 3. 优先级 ---------------- */
{
  const p = parsePolicy(`
version: 1
rules:
  - id: allow-bash
    match: { tool: bash }
    decision: allow
  - id: block-rm
    match:
      tool: bash
      args.command: { regex: 'rm -rf' }
    decision: deny
`);
  const r = decide(p, 'bash', { command: 'rm -rf /' });
  check('allow 写在前面也压不过 deny', r.decision === 'deny' && r.ruleId === 'block-rm');
}
{
  const p = parsePolicy(`
version: 1
rules:
  - id: first-allow
    match: { tool: bash }
    decision: allow
  - id: second-allow
    match: { tool: bash }
    decision: allow
`);
  const r = decide(p, 'bash', {});
  check('同档取声明在前的那条', r.decision === 'allow' && r.ruleId === 'first-allow');
}
{
  const p = parsePolicy(`
version: 1
rules:
  - id: allow-all
    match: { tool: bash }
    decision: allow
  - id: ask-force
    match:
      tool: bash
      args.command: { prefix: 'git push' }
    decision: ask
`);
  const r = decide(p, 'bash', { command: 'git push --force' });
  check('ask 压过 allow', r.decision === 'ask' && r.ruleId === 'ask-force');
}

/* ---------------- 4. dry_run ---------------- */
{
  const p = parsePolicy(`
version: 1
defaults:
  dry_run: true
rules:
  - id: block-rm
    match:
      tool: bash
      args.command: { regex: 'rm -rf' }
    decision: deny
`);
  const r = decide(p, 'bash', { command: 'rm -rf /' });
  check(
    'dry_run：生效 allow 但保留 raw deny',
    r.decision === 'allow' && r.raw === 'deny' && r.ruleId === 'block-rm' && r.dryRun === true,
    `${r.decision}/raw=${r.raw}`,
  );
}
{
  const p = parsePolicy(`
version: 1
defaults:
  on_no_match: allow
rules: []
`);
  const r = decide(p, 'anything', {});
  check('on_no_match: allow 时未匹配放行', r.decision === 'allow' && r.ruleId === null);
}

/* ---------------- 5. 非法策略必须加载失败 ---------------- */
mkdirSync(TMP, { recursive: true });
expectThrow('YAML 语法错误 → 加载失败', () => parsePolicy('version: 1\nrules: [ {id: x', '<bad>'), 'YAML 解析失败');
expectThrow('缺少 version → 加载失败', () => parsePolicy('rules: []\n', '<bad>'), 'version 必须是 1');
expectThrow('version: 2 → 加载失败', () => parsePolicy('version: 2\nrules: []\n', '<bad>'), 'version 必须是 1');
expectThrow('顶层未知键 → 加载失败', () => parsePolicy('version: 1\nrules: []\nfoo: 1\n', '<bad>'), '未知键');
expectThrow(
  'defaults 未知键 → 加载失败',
  () => parsePolicy('version: 1\ndefaults: { on_nomatch: deny }\n', '<bad>'),
  '未知键',
);
expectThrow(
  'on_no_match 非法值 → 加载失败',
  () => parsePolicy('version: 1\ndefaults: { on_no_match: maybe }\n', '<bad>'),
  'on_no_match',
);
expectThrow(
  '缺少 id → 加载失败',
  () => parsePolicy("version: 1\nrules:\n  - match: { tool: bash }\n    decision: deny\n", '<bad>'),
  'id 缺失或不合法',
);
expectThrow(
  'decision 非法 → 加载失败',
  () => parsePolicy('version: 1\nrules:\n  - id: a\n    match: { tool: x }\n    decision: maybe\n', '<bad>'),
  'decision',
);
expectThrow(
  '空 match → 加载失败',
  () => parsePolicy('version: 1\nrules:\n  - id: a\n    match: {}\n    decision: deny\n', '<bad>'),
  '空 match 会命中一切',
);
expectThrow(
  '未知 match 字段 → 加载失败',
  () => parsePolicy("version: 1\nrules:\n  - id: a\n    match: { arguments: x }\n    decision: deny\n", '<bad>'),
  '不认识的字段',
);
expectThrow(
  'args 字段写裸值 → 加载失败并提示用操作符',
  () => parsePolicy("version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.path: '**/.env*'\n    decision: deny\n", '<bad>'),
  '必须写成操作符对象',
);
expectThrow(
  '未知操作符 → 加载失败',
  () => parsePolicy("version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.x: { matches: y }\n    decision: deny\n", '<bad>'),
  '没有合法操作符',
);
expectThrow(
  '同一字段写多个操作符 → 加载失败',
  () => parsePolicy("version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.x: { glob: '*', regex: 'x' }\n    decision: deny\n", '<bad>'),
  '只能选一个',
);
expectThrow(
  '非法 regex → 加载失败（不是第一次调用才炸）',
  () => parsePolicy("version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.x: { regex: '([' }\n    decision: deny\n", '<bad>'),
  'regex 无效',
);
expectThrow(
  'glob 类型错误 → 加载失败',
  () => parsePolicy('version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.x: { glob: 123 }\n    decision: deny\n', '<bad>'),
  'glob 只能是非空字符串',
);
expectThrow(
  'in 非数组 → 加载失败',
  () => parsePolicy("version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.x: { in: 'a' }\n    decision: deny\n", '<bad>'),
  'in 取值得是数组',
);
expectThrow(
  '同文件重复 id → 加载失败',
  () =>
    parsePolicy(
      'version: 1\nrules:\n  - id: dup\n    match: { tool: a }\n    decision: deny\n  - id: dup\n    match: { tool: b }\n    decision: allow\n',
      '<bad>',
    ),
  '重复',
);
expectThrow(
  'limits.window 非法 → 加载失败',
  () => parsePolicy('version: 1\nlimits:\n  - tool: bash\n    max_calls: 10\n    window: "1 hour"\n', '<bad>'),
  'window',
);
expectThrow(
  'limits.max_calls 非正整数 → 加载失败',
  () => parsePolicy('version: 1\nlimits:\n  - tool: bash\n    max_calls: 0\n    window: 1h\n', '<bad>'),
  'max_calls',
);
expectThrow('策略文件不存在 → 加载失败', () => loadPolicy(join(TMP, 'nope.yaml')), '无法读取');

/* ---------------- 6. 多文件合并 ---------------- */
{
  const a = join(TMP, 'a.yaml');
  const b = join(TMP, 'b.yaml');
  writeFileSync(a, 'version: 1\nrules:\n  - id: from-a\n    match: { tool: bash }\n    decision: allow\n');
  writeFileSync(
    b,
    'version: 1\ndefaults:\n  on_no_match: allow\nrules:\n  - id: from-b\n    match:\n      tool: bash\n      args.command: { regex: "rm -rf" }\n    decision: deny\n',
  );
  const merged = loadPolicy([a, b]);
  check('多文件规则按顺序合并', merged.rules.map((r) => r.id).join(',') === 'from-a,from-b');
  check('defaults 由后出现的文件覆盖', merged.defaults.onNoMatch === 'allow');
  const r = decide(merged, 'bash', { command: 'rm -rf /' });
  check('跨文件优先级仍然 deny > allow', r.decision === 'deny' && r.ruleId === 'from-b');

  const c = join(TMP, 'c.yaml');
  writeFileSync(c, 'version: 1\nrules:\n  - id: from-a\n    match: { tool: bash }\n    decision: deny\n');
  expectThrow('跨文件重复 id → 加载失败', () => loadPolicy([a, c]), '重复');
}

/* ---------------- 7. glob 单元 ---------------- */
{
  const g = compileGlob('**/.env*');
  const yes = ['.env', './.env', 'a/.env.local', '/srv/app/.env', '.ENV'];
  const no = ['environment.md', 'src/main.ts'];
  check('glob **/.env* 命中集正确', yes.every((v) => matchGlob(g, v)) && no.every((v) => !matchGlob(g, v)));
}
{
  const g = compileGlob('**/*.pem');
  check(
    'glob **/*.pem 命中集正确',
    ['server.pem', 'certs/server.pem', 'a/b/x.PEM'].every((v) => matchGlob(g, v)) &&
      !matchGlob(g, 'server.pem.bak'),
  );
}
{
  const g = compileGlob('src/*.ts');
  check('glob src/*.ts 不跨目录', matchGlob(g, 'src/a.ts') && !matchGlob(g, 'src/a/b.ts'));
}
{
  const g = compileGlob('**');
  check('glob ** 命中一切', ['', 'a', 'a/b/c'].every((v) => matchGlob(g, v)));
}
{
  const g = compileGlob('id_rsa[0-9]');
  check('glob 字符类可用', matchGlob(g, 'id_rsa1') && !matchGlob(g, 'id_rsax'));
}

/* ---------------- 8. 性能 ---------------- */
{
  const rounds = 2000;
  const times = [];
  for (let i = 0; i < rounds; i++) {
    times.push(d('bash', { command: 'npm run build' }).elapsedMs);
  }
  times.sort((x, y) => x - y);
  const p50 = times[Math.floor(rounds * 0.5)];
  const p99 = times[Math.floor(rounds * 0.99)];
  check('4 条规则 P99 < 2ms（P0 性能预算）', p99 < 2, `p50=${p50.toFixed(4)}ms p99=${p99.toFixed(4)}ms`);
}

{
  const many = ['version: 1', 'rules:'];
  for (let i = 0; i < 1000; i++) {
    many.push(`  - id: r${i}`);
    many.push('    match:');
    many.push(`      tool: tool_${i}`);
    many.push(`      args.cmd: { regex: 'pattern-${i}-[a-z]+$' }`);
    many.push('    decision: allow');
  }
  const big = parsePolicy(many.join('\n'), '<1000-rules>');
  const rounds = 500;
  const times = [];
  for (let i = 0; i < rounds; i++) {
    times.push(decide(big, 'bash', { cmd: 'npm test' }).elapsedMs);
  }
  times.sort((x, y) => x - y);
  const p99 = times[Math.floor(rounds * 0.99)];
  console.log(`INFO  1000 条规则未命中场景 p99=${p99.toFixed(3)}ms（P1 目标 < 10ms，需按 tool 建索引，留到 W7）`);
  check('1000 条规则仍可接受（< 15ms）', p99 < 15, `p99=${p99.toFixed(3)}ms`);
}

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
