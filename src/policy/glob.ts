/**
 * 轻量 glob —— 只为策略匹配服务，不追求 shell glob 的完整语义。
 *
 * 支持：`*`（不跨路径分隔符）、`**`（跨分隔符）、`**\/`（零或多级目录）、`?`、`[abc]`、`[!abc]`
 * 不支持：brace 展开 `{a,b}`、转义 `\*`（反斜杠一律当作路径分隔符，Windows 友好）
 *
 * 两个刻意的取舍：
 *   1. 匹配前把反斜杠归一成 `/`，并去掉开头的 `./`。agent 传 `./.env` 还是 `.env`
 *      取决于它的心情，规则不该关心这个。
 *   2. 大小写不敏感。Windows 文件系统本来就不敏感，`.ENV` 被放行是不可接受的方向；
 *      Linux 上误伤 `.ENV` 的概率远低于漏放 `.ENV` 的代价。
 */

export interface CompiledGlob {
  readonly source: string;
  readonly re: RegExp;
}

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/;

export function normalizeGlobInput(value: string): string {
  let out = value.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  out = out.replace(/\/{2,}/g, '/');
  return out;
}

function translate(pattern: string): string {
  const src = pattern.replace(/\\/g, '/');
  let out = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '*') {
      if (src[i + 1] === '*') {
        if (src[i + 2] === '/') {
          // `**/` 允许零级目录：`**/.env*` 必须能命中根目录的 `.env`。
          // 用 `[^/]*`（可空）而不是 `[^/]+`：绝对路径 `/home/u/.env` 的第一个字符
          // 就是 `/`，非空段匹配吃不下它，会导致整条规则对绝对路径完全失效。
          out += '(?:[^/]*/)*';
          i += 3;
          continue;
        }
        out += '.*';
        i += 2;
        continue;
      }
      out += '[^/]*';
      i += 1;
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      const body = src.slice(i + 1, end);
      const negated = body.startsWith('!') || body.startsWith('^');
      const inner = (negated ? body.slice(1) : body).replace(/[\\^]/g, '\\$&');
      out += `[${negated ? '^' : ''}${inner}]`;
      i = end + 1;
      continue;
    }

    out += REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
    i += 1;
  }

  return out;
}

export function compileGlob(pattern: string): CompiledGlob {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error('glob 必须是非空字符串');
  }
  return {
    source: pattern,
    re: new RegExp(`^${translate(pattern)}$`, 'i'),
  };
}

export function matchGlob(glob: CompiledGlob, value: string): boolean {
  return glob.re.test(normalizeGlobInput(value));
}
