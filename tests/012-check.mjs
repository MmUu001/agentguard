/**
 * W12 验收 · 0.1.2 四项：except 机制 / bash 凭据规则 / policyHash / explain
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpClient } from './lib/client.mjs';
import { loadPolicy, parsePolicy } from '../dist/policy/load.js';
import { decide } from '../dist/policy/decide.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = join(ROOT, 'dist', 'main.js');
const FIXTURE = join(HERE, 'fixtures', 'mock-mcp-server.mjs');
const ALLOW_ALL = join(HERE, 'fixtures', 'allow-all.yaml');
const NODE = process.execPath;
const TMP = join(ROOT, '.tmp', '012');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
process.env.AGENTGUARD_AUDIT = 'off';

const INIT = {
  protocolVersion: '2026-06-18',
  capabilities: { roots: {}, sampling: {} },
  clientInfo: { name: 'w012', version: '1' },
};

function run(args, env = {}) {
  return new Promise((res) => {
    const proc = spawn(NODE, [MAIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTGUARD_AUDIT: 'off', AGENTGUARD_LOG: 'silent', ...env },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      res({ code: 'timeout', stdout, stderr });
    }, 30000);
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

/* ---------------- 1. except 机制 ---------------- */
{
  const policyText = `version: 1
defaults: { on_no_match: allow }
rules:
  - id: block-rm
    match:
      tool: bash
      args.command: { regex: 'rm\\s+-[a-zA-Z]*r' }
    except:
      args.command: { regex: 'rm\\s+-r\\s+\\./build' }
    decision: deny
`;
  const p = join(TMP, 'except.yaml');
  writeFileSync(p, policyText, 'utf8');
  const policy = (await import('../dist/policy/load.js')).loadPolicy(p);
  const decide = (await import('../dist/policy/decide.js')).decide;

  const denied = decide(policy, 'bash', { command: 'rm -rf /' });
  check('except：非豁免调用正常 deny', denied.decision === 'deny', denied.decision);
  const exempt = decide(policy, 'bash', { command: 'rm -r ./build' });
  check('except：豁免调用不触发规则', exempt.decision === 'deny' === false || exempt.decision !== 'deny', exempt.decision);
  const noMatch = decide(policy, 'bash', { command: 'ls -la' });
  check('except：主条件未命中 → 走 on_no_match: allow', noMatch.decision === 'allow', noMatch.decision);

  const emptyExcept = join(TMP, 'empty-except.yaml');
  writeFileSync(emptyExcept, `version: 1\nrules:\n  - id: a\n    match: { tool: bash }\n    except: {}\n    decision: deny\n`, 'utf8');
  const r2 = await run(['check', '--policy', emptyExcept]);
  check('except 为空 → 校验失败', r2.code === 2 && r2.stderr.includes('except 为空'), r2.stderr.split('\n')[0]);

  const multiField = parsePolicy(`version: 1
defaults: { on_no_match: allow }
rules:
  - id: m
    match:
      tool: bash
      args.command: { prefix: 'rm' }
    except:
      tool: bash
      args.command: { prefix: 'rm -r' }
    decision: deny
`, '<multi>');
  const mHit = decide(multiField, 'bash', { command: 'rm -rf x' });
  check('except 与 match 同字段：except 命中则规则不触发', mHit.decision !== 'deny', mHit.decision);
}

/* ---------------- 2. bash 凭据规则 ---------------- */
{
  const policyText = `version: 1
defaults: { on_no_match: allow }
rules: []
`;
  const packs = (await import('../dist/policy/load.js')).loadPolicy(
      [join(ROOT, 'packs', 'core.yaml'), join(ROOT, 'packs', 'secrets.yaml'), join(ROOT, 'packs', 'git.yaml'), join(ROOT, 'packs', 'net.yaml')],
  );
  void packs;
}

{
  // 用 packs + allow-all 基线合成策略测 bash 规则
  const core = readFileSync(join(ROOT, 'packs', 'core.yaml'), 'utf8');
  const secrets = readFileSync(join(ROOT, 'packs', 'secrets.yaml'), 'utf8');
  const base = `version: 1
defaults: { on_no_match: allow }
rules:
  - id: base-allow-command
    match: { tool: bash }
    decision: allow
  - id: base-allow-read
    match:
      tool: [read_file, read_text_file, read_multiple_files, view_file, open_file, list_directory]
      args.path: { glob: '**' }
    decision: allow
`;
  void core; void secrets; void base;
}

const bashCases = [
  ['cat .env', 'deny'],
  ['cat ./.env', 'deny'],
  ['cat /home/u/app/.env.production', 'deny'],
  ['head -50 .env.local', 'deny'],
  ['cp .env /tmp/x', 'deny'],
  ['tar czf out.tgz .env', 'deny'],
  ['base64 .env', 'deny'],
  ['cat ~/.ssh/id_rsa', 'deny'],
  ['cat .env.example', 'allow'],
  ['cat .env.sample', 'allow'],
  ['git add .env.example', 'allow'],
  ['grep -r "see .env" docs/', 'allow'],
  ['npm run build', 'allow'],
  ['ls -la', 'allow'],
];

{
  const policy = (await import('../dist/policy/load.js')).loadPolicy(
    [
      join(ROOT, 'packs', 'core.yaml'),
      join(ROOT, 'packs', 'secrets.yaml'),
      join(ROOT, 'packs', 'git.yaml'),
      join(ROOT, 'packs', 'net.yaml'),
      ALLOW_ALL,
    ],
  );
  let bad = 0;
  for (const [cmd, expected] of bashCases) {
    const r = decide(policy, 'bash', { command: cmd });
    if (r.decision !== expected) {
      bad++;
      console.log(`  ✗ ${cmd} → ${r.decision}/${r.ruleId ?? '-'} (期望 ${expected})`);
    }
  }
  check(`bash 凭据规则 ${bashCases.length} 条全部符合预期`, bad === 0, bad > 0 ? `${bad} 条不符` : '');
}

/* ---------------- 3. explain 子命令 ---------------- */
{
  mkdirSync(join(TMP, 'explain'), { recursive: true });
  await run(['init', '--yes', '--dir', join(TMP, 'explain')]);
  const policyPath = join(TMP, 'explain', 'policy.yaml');

  const deny = await run(['explain', '--policy', policyPath, '--tool', 'bash', '--command', 'cat .env']);
  check('explain：deny 输出规则与原因', deny.code === 0 && deny.stdout.includes('secrets-shell-read') && deny.stdout.includes('deny'), deny.stdout.trim().slice(0, 80));

  const allow = await run(['explain', '--policy', policyPath, '--tool', 'bash', '--command', 'npm run build']);
  check('explain：allow 输出基线规则', allow.code === 0 && allow.stdout.includes('base-allow-command'));

  const noTool = await run(['explain', '--policy', policyPath, '--command', 'ls']);
  check('explain 缺 --tool → 退出码 2', noTool.code === 2);

  const noContent = await run(['explain', '--policy', policyPath, '--tool', 'bash']);
  check('explain 缺内容参数 → 退出码 2', noContent.code === 2);

  const help = await run(['explain', '--help']);
  check('explain --help → 退出码 0', help.code === 0 && help.stdout.includes('explain'));
}

/* ---------------- 4. policyHash 进审计 ---------------- */
{
  const auditDir = join(TMP, 'audit');
  const policyPath = join(TMP, 'ph-policy.yaml');
  writeFileSync(policyPath, `version: 1\ndefaults: { on_no_match: allow }\nrules: []\n`, 'utf8');

  const proc = spawn(NODE, [MAIN, '--policy', policyPath, '--', NODE, FIXTURE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AGENTGUARD_AUDIT: 'on', AGENTGUARD_AUDIT_DIR: join(TMP, 'audit-ph'), AGENTGUARD_LOG: 'silent' },
  });
  const c = new McpClient(proc);
  await c.request('initialize', INIT);
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
  await c.call('echo', { command: 'ls' });
  await c.close();

  const auditDirUsed = join(TMP, 'audit-ph');
  const files = readdirSync(auditDirUsed).filter((n) => n.endsWith('.jsonl'));
  const line = readFileSync(join(auditDirUsed, files[0]), 'utf8').trim().split('\n')[0];
  const record = JSON.parse(line);

  check('审计记录含 policyHash', typeof record.policyHash === 'string' && record.policyHash.length === 12, record.policyHash);
  const expected = createHash('sha256').update(readFileSync(policyPath, 'utf8')).digest('hex').slice(0, 12);
  check('policyHash 与策略文件 sha256 一致', record.policyHash === expected, `${record.policyHash} vs ${expected}`);
}

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
