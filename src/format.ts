/**
 * 终端文本对齐。中文/全角字符在等宽字体里占两列，按 `String.length` 补空格会错位。
 * cli 与 demo 共用同一套，保证两处输出宽度一致。
 */

function charWidth(code: number): number {
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += charWidth(char.codePointAt(0) ?? 0);
  return width;
}

export function pad(text: string, width: number): string {
  const current = displayWidth(text);
  return current >= width ? text : text + ' '.repeat(width - current);
}
