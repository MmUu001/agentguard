/**
 * 日志：**只能写 stderr**。
 *
 * 这是方案第 3 章第 1 号坑 —— 往 stdout 写一个字节的日志，client 的 JSON 解析就崩，
 * 表现为「配置完之后 server 直接连不上」，而且极难定位。所以这里不提供任何
 * 写 stdout 的入口，也不依赖 console（console.log 就是 stdout）。
 *
 * 级别用环境变量控制，默认 warn：agent 的 stderr 会被客户端当「服务器日志」展示，
 * 默认别刷屏。排查问题时 `AGENTGUARD_LOG=debug`。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function currentThreshold(): number {
  const raw = (process.env.AGENTGUARD_LOG ?? 'warn').trim().toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.warn;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return /^[\w./:-]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

export function log(level: Exclude<LogLevel, 'silent'>, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < currentThreshold()) return;

  let line = `agentguard[${level}] ${message}`;
  if (fields !== undefined) {
    for (const [key, value] of Object.entries(fields)) {
      line += ` ${key}=${formatValue(value)}`;
    }
  }
  process.stderr.write(line + '\n');
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log('debug', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log('info', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log('warn', message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log('error', message, fields),
};
