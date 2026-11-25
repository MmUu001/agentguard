# 5 分钟接入指南

> 目标：让 agent 在你的真实工作环境里跑起来，并且**第一次读 `.env` 就被明确拒绝**。
> 全程不需要 API key、不需要注册账号、不需要联网（除了从 npm 下载这一个包）。
> 以 **Cline**（VS Code 扩展，免费，可接任意模型）为演示客户端；Cursor / Claude Code / Roo Code 的配置结构完全一样，位置见第 3 步。

## 前置

- Node ≥ 20（`node --version` 确认）
- 一个支持 MCP 的客户端（下表任选其一）

| 客户端 | MCP 配置位置 |
|---|---|
| **Cline**（本指南演示） | VS Code → Cline 侧栏 → MCP Servers 图标 → Configuration → Edit Config |
| Roo Code（VS Code） | 同 Cline |
| Cursor | `~/.cursor/mcp.json` |
| Claude Code | 项目根 `.mcp.json`，或用户级 `~/.claude.json` |
| 其他（Cherry Studio / Trae 等） | 找到 MCP 配置项，结构一样 |

## 第 1 步 · 生成策略文件（一条命令）

```bash
npx -y @leeruu/agentguard init --yes
```

你会看到类似输出（规则数以实际为准）：

```text
已生成（27 条规则，0 条限流）
  ~/.agentguard/policy.yaml
  ~/.agentguard/packs/core.yaml
  ~/.agentguard/packs/secrets.yaml

模式      拦截
基线      dev：放行日常开发工具
未匹配    deny（fail-closed）
```

这一步做了三件事：生成策略文件、装上 `core` + `secrets` 两套规则包（日常开发常用的读写会放行，敏感文件与破坏性命令会被拦）、打印一段**属于你的** MCP 配置片段。

> 命令不会改写你的任何客户端配置——片段是打印出来给你自己粘的。

## 第 2 步 · 先看它会拦什么（可选但推荐）

```bash
npx -y @leeruu/agentguard check
```

打印规则表 + 13 条样例调用的预演结果。看着不放心，就先走观察模式：

```bash
npx -y @leeruu/agentguard init --observe --force
```

观察模式**只记录不拦截**：agent 的每次工具调用都会被记进审计日志，但不阻塞。跑几天确认无误伤，再把策略里的 `dry_run: true` 改回 `false`。

## 第 3 步 · 把片段粘进客户端配置

打开第 1 步输出里给你的 JSON 片段（或直接用下面这份通用版），粘进客户端的 MCP 配置：

```json
{
  "mcpServers": {
    "filesystem (经 agentguard)": {
      "command": "npx",
      "args": [
        "-y", "@leeruu/agentguard",
        "--policy", "C:/Users/me/.agentguard/policy.yaml",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "C:/projects"
      ]
    }
  }
}
```

三个要点：

1. `--` 之前是 agentguard 的选项，**之后是原来那行 server 命令**，原样搬过来即可。想给多个 server 都套上，就把每个 server 的 `command`/`args` 各包一层，互不影响。
2. `--policy` 用**绝对路径**。Windows 上 JSON 里写正斜杠（`C:/Users/...`）最省事，反斜杠要双写。
3. agentguard **不会替你改客户端配置**——`init` 只生成文件和打印片段，粘贴这一步永远是你自己来。

保存后重启客户端（或点 Reload MCP），配置生效。

## 第 4 步 · 验证（30 秒）

在客户端里对 agent 说：

```
读一下 C:/projects/.env 的内容
```

预期结果——**agent 收到的是一条明确的错误，不是卡住**：

```json
{"error":{"code":-32001,"message":"Blocked by policy secrets-read-env: 敏感凭据文件（.env）"}}
```

同时看一眼审计：

```bash
npx -y @leeruu/agentguard audit list --limit 5
```

刚才那次调用应该在列表里，`decision=deny`、`ruleId=secrets-read-env`。

## 卡住了？

| 现象 | 先查什么 |
|---|---|
| 所有工具调用都被拒 | 策略没加载，或规则没覆盖这个工具。跑 `agentguard check` 看预演；确认 `--policy` 是绝对路径且存在 |
| 客户端显示 server 连不上 | 看客户端日志里 agentguard 的 stderr——策略语法错误会让它退出且**不会启动上游** |
| 某个工具莫名被拦 | `npx -y @leeruu/agentguard audit list --decision deny` 直接看是哪条规则 |
| Windows 提示找不到命令 | agentguard 已处理 `.cmd` 垫片；仍失败就把上游命令换成显式路径（如 `node C:/path/to/server.js`） |

## 下一步

- 完整说明（策略 DSL、全部子命令、测试）：[README](../README.md)
- 单次调用判定查询：`agentguard explain --policy <文件> --tool bash --command "cat .env"`
- 每日/每周审计报表：`agentguard audit stats --since 7d`、`agentguard audit export --format csv`
