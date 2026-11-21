/**
 * 跨客户端工具名别名表。
 *
 * 同一个操作在不同 Agent 客户端里叫法不同（Claude Code 叫 Bash，Cline 叫
 * execute_command，Cursor 叫 run_terminal_cmd）。规则里写任何一个名字，
 * 编译期自动展开为整组等价名 —— 消除「换一个客户端就漏配」这类问题。
 *
 * 只收录确认存在的真实工具名；拿不准的不写宁可漏。
 * 匹配时 tool 字段同时做大小写不敏感比较，所以这里不用堆大小写变体。
 */

export const TOOL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  bash: [
    'Bash', 'bash', 'Shell', 'shell',
    'run_command', 'execute_command', 'run_terminal_cmd',
    'terminal', 'powershell',
  ],
  read_file: [
    'Read', 'read_file', 'read_text_file', 'read_multiple_files',
    'view_file', 'open_file',
  ],
  search: [
    'Glob', 'Grep', 'LS', 'list_files', 'list_directory', 'directory_tree',
    'search_files', 'get_file_info', 'codebase_search',
  ],
  write: [
    'Write', 'write_file', 'write_text_file',
    'edit_file', 'Edit', 'MultiEdit', 'replace_in_file', 'write_to_file',
    'create_directory', 'move_file', 'apply_patch',
  ],
};

/** 把一组工具名展开为「自身 + 所在等价组的全部名字」 */
export function expandToolNames(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    out.add(name);
    for (const group of Object.values(TOOL_ALIASES)) {
      if (group.some((g) => g.toLowerCase() === name.toLowerCase())) {
        for (const g of group) out.add(g);
      }
    }
  }
  return [...out];
}
