/**
 * 策略包：既随包分发（package.json 的 files 含 packs/），也能被 init 落到用户目录。
 *
 * 这里只做「读文本 + 元数据」，不做校验 —— 校验统一走 loadPolicy，
 * 这样包和用户手写的策略走的是同一条路，不会有第二套规则解释器。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PackInfo {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  /** init 默认勾选 */
  readonly defaultOn: boolean;
}

export const PACKS: readonly PackInfo[] = [
  {
    id: 'core',
    title: '灾难性误操作',
    summary: 'rm -rf 根目录/系统目录、强制推送、破坏性 SQL、下载即执行、写系统目录、磁盘级破坏',
    defaultOn: true,
  },
  {
    id: 'secrets',
    title: '凭据泄漏',
    summary: '读 .env / 私钥 / 云凭据、访问云元数据端点、把密钥发到外部',
    defaultOn: true,
  },
  {
    id: 'git',
    title: '版本库破坏',
    summary: 'reset --hard、clean -fdx、删除远端分支、丢弃工作区改动',
    defaultOn: false,
  },
  {
    id: 'net',
    title: '误触内网与付费接口',
    summary: '内网地址、支付类接口、单窗口调用上限',
    defaultOn: false,
  },
];

/** dist/packs.js → ../packs/ = 包根目录下的 packs/ */
export function packsDir(): string {
  return fileURLToPath(new URL('../packs/', import.meta.url));
}

export function packPath(id: string): string {
  return join(packsDir(), `${id}.yaml`);
}

export function findPack(id: string): PackInfo | undefined {
  return PACKS.find((pack) => pack.id === id);
}

export function readPackText(id: string): string {
  if (findPack(id) === undefined) {
    throw new Error(`未知的策略包 "${id}"（可用：${PACKS.map((p) => p.id).join(', ')}）`);
  }
  return readFileSync(packPath(id), 'utf8');
}
