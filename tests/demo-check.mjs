/**
 * W11 验收 · `agentguard demo`
 *
 * 这个命令的产品意义是「不装任何 agent 也能自证」：
 *   1. 没有策略文件时用内置默认策略，演示不能全是 deny
 *   2. 四种判定都要出现：allow / deny / ask / fail-closed
 *   3. 被拦的调用不能到达上游（表里显示"未执行"）
 *   4. 演示不写用户真实审计目录
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MAIN = resolve(ROOT, 'dist', 'main.js');
const NODE = process.execPath;
const TMP = join(ROOT, '.tmp', 'demo');

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : '  ' + detail}`);
};

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function run(args, env = {}) {
  const emptyHome = join(TMP, 'home');
  mkdirSync(emptyHome, { recursive: true });

  return new Promise((res) => {
    const proc = spawn(NODE, [MAIN, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        USERPROFILE: emptyHome,
        HOME: emptyHome,
        AGENTGUARD_LOG: 'silent',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      res({ code: 'timeout', stdout, stderr });
    }, 60000);
    proc.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    proc.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    proc.once('close', (code) => {
      clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}

console.log('agentguard · demo\n');

/* ---------------- 1. 无策略文件也能跑 ---------------- */
const auditDir = join(TMP, 'audit');
const plain = await run(['demo'], { AGENTGUARD_AUDIT_DIR: auditDir });

check('退出码 0', plain.code === 0, String(plain.code));
check('没有策略文件时用内置默认策略', plain.stdout.includes('内置默认策略'));
check('没有和本地判定不一致的告警', !plain.stdout.includes('不一致'), '');
check('演示不写审计目录', !existsSync(auditDir));

check('出现 allow 且指向基线规则', /allow\s+读 \.\/src\/index\.ts\s+base-allow-read/.test(plain.stdout));
check('出现 deny 且指向 secrets 规则', /deny\s+读 \.\/\.env\s+secrets-read-env/.test(plain.stdout));
check('出现 deny 且指向 core 规则', /deny\s+rm -rf \/\s+core-rm-rf-root/.test(plain.stdout));
check('出现 ask（强制推送）', /ask\*\s+git push --force\s+core-force-push/.test(plain.stdout));
check('出现 fail-closed（未定义工具）', /deny\s+未定义的工具\s+\(fail-closed\)/.test(plain.stdout));
check(
  '被拦的调用标注「未执行」',
  /deny\s+读 \.\/\.env\s+secrets-read-env\s+未执行/.test(plain.stdout),
);
check(
  '放行的调用标注「已执行」',
  /allow\s+读 \.\/src\/index\.ts\s+base-allow-read\s+已执行/.test(plain.stdout),
);
check('给出合计行', /合计：allow 2 \/ deny 4 \/ ask\* 1/.test(plain.stdout), '');

/* ---------------- 2. 指定策略 ---------------- */
const allowAll = resolve(HERE, 'fixtures', 'allow-all.yaml');
const permissive = await run(['demo', '--policy', allowAll]);

check('--policy 指向 allow-all 时全部放行', /合计：allow 7 \/ deny 0 \/ ask\* 0/.test(permissive.stdout), '');
check('策略来源显示为指定文件', permissive.stdout.includes('allow-all.yaml'));

/* ---------------- 3. 坏策略 ---------------- */
const broken = join(TMP, 'broken.yaml');
writeFileSync(broken, "version: 1\nrules:\n  - id: a\n    match:\n      tool: bash\n      args.x: { regex: '([' }\n    decision: deny\n", 'utf8');

const bad = await run(['demo', '--policy', broken]);
check('坏策略 → 退出码 2', bad.code === 2, `exit=${bad.code}`);
check('坏策略的错误指向具体字段', bad.stderr.includes('regex 无效'));

/* ---------------- 4. 参数错误 ---------------- */
const noValue = await run(['demo', '--policy']);
check('--policy 缺值 → 退出码 2', noValue.code === 2);

const unknown = await run(['demo', '--nope']);
check('未知参数 → 退出码 2', unknown.code === 2);

const help = await run(['demo', '--help']);
check('--help → 退出码 0', help.code === 0 && help.stdout.includes('内置'));

rmSync(TMP, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
