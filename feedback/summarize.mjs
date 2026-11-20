#!/usr/bin/env node
/**
 * 汇总试用反馈：把汇总表 CSV 变成「该改哪条规则」的清单。
 *
 * 用法：
 *   node feedback/summarize.mjs [csv 路径]
 *   node feedback/summarize.mjs feedback/试用反馈汇总表.csv --include-examples
 *
 * 默认跳过编号以「示例-」开头的行，避免模板里的演示数据混进统计。
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'feedback/试用反馈汇总表.csv';
const includeExamples = process.argv.includes('--include-examples');

/** 最小 CSV 解析：支持引号包裹、"" 转义、字段内换行 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
const rows = parseCsv(raw);
if (rows.length === 0) {
  console.error(`空文件：${file}`);
  process.exit(2);
}

const header = rows[0].map((h) => h.trim());
const records = rows.slice(1).map((cells) => {
  const record = {};
  header.forEach((key, i) => {
    record[key] = (cells[i] ?? '').trim();
  });
  return record;
});

const data = records.filter(
  (r) => includeExamples || !r['编号'].startsWith('示例'),
);

if (data.length === 0) {
  console.log(`（\u6ca1\u6709\u6570\u636e\uff1a${file} \u53ea\u6709\u793a\u4f8b\u884c\uff0c\u52a0 --include-examples \u53ef\u770b\u6f14\u793a\u7edf\u8ba1\uff09`);
  process.exit(0);
}

const countBy = (key) => {
  const map = new Map();
  for (const r of data) {
    const value = r[key] === '' ? '(未填)' : r[key];
    map.set(value, (map.get(value) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};

/** 中文/全角字符在等宽字体里占两列，按 String.length 补空格会错位 */
function charWidth(code) {
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60))
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

const pad = (text, width) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

console.log(`\n反馈汇总  ${file}`);
console.log(`有效条目  ${data.length} 条${includeExamples ? '（含示例）' : '（已排除示例行）'}\n`);

console.log('按分类');
for (const [key, n] of countBy('分类')) console.log(`  ${pad(key, 12)} ${n}`);

console.log('\n按严重度');
for (const [key, n] of countBy('严重度')) console.log(`  ${pad(key, 14)} ${n}`);

console.log('\n按客户端');
for (const [key, n] of countBy('客户端')) console.log(`  ${pad(key, 22)} ${n}`);

console.log('\n按操作系统');
for (const [key, n] of countBy('操作系统')) console.log(`  ${pad(key, 14)} ${n}`);

// 「未命中规则」必须算进来：它意味着基线没覆盖这个工具，是最常见的误拦原因，
// 也是最能直接变成「往 base-allow-* 加一个工具名」的信号。
const ruleHits = data.filter((r) => (r['命中规则'] ?? '') !== '');
if (ruleHits.length > 0) {
  console.log('\n按命中规则（误拦时最该看这里：同一规则被误伤多次就该改它）');
  const map = new Map();
  for (const r of ruleHits) {
    const key = r['命中规则'] === '（未命中规则）' ? '（未命中规则 / fail-closed）' : r['命中规则'];
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  for (const [key, n] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(key, 34)} ${n}`);
  }
  const failClosed = map.get('（未命中规则 / fail-closed）') ?? 0;
  if (failClosed > 0) {
    console.log(`  ↑ ${failClosed} 条是「基线没覆盖」：优先把这些工具名加进 base-allow-*`);
  }
}

const pending = data.filter((r) => (r['处理结论'] ?? '') === '' || r['处理结论'] === '待确认');
if (pending.length > 0) {
  console.log(`\n待处理（${pending.length} 条）`);
  for (const r of pending) {
    console.log(
      `  #${r['编号']}  ${r['分类']}  ${r['工具名'] || '-'}  ${r['参数摘要'].slice(0, 60)}`,
    );
  }
}

const conclusions = data.filter((r) => (r['处理结论'] ?? '') !== '');
if (conclusions.length > 0) {
  console.log('\n处理结论分布');
  const map = new Map();
  for (const r of conclusions) map.set(r['处理结论'], (map.get(r['处理结论']) ?? 0) + 1);
  for (const [key, n] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(key, 14)} ${n}`);
  }
}

// 商业化信号：只有「有人明确说会买」才值得投入做团队版
const biz = data.filter((r) => {
  const v = r['付费场景'] ?? '';
  return v !== '' && v !== '未问';
});
if (biz.length > 0) {
  console.log('\n付费场景（团队版是否值得做，看这一栏）');
  const map = new Map();
  for (const r of biz) map.set(r['付费场景'], (map.get(r['付费场景']) ?? 0) + 1);
  for (const [key, n] of [...map.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(key, 14)} ${n}`);
  }
  const team = map.get('团队版') ?? 0;
  const industry = map.get('行业包') ?? 0;
  if (team + industry > 0) {
    console.log(`  ↑ ${team + industry} 个团队表达了付费场景，值得进一步访谈（问预算与决策人）`);
  } else {
    console.log('  ↑ 全是「不需要」：说明当下没有付费市场，先做装机量');
  }
} else {
  console.log('\n付费场景：还没人回答——试用时务必问一句「团队版你们会买吗、预算谁定」');
}

console.log('');
