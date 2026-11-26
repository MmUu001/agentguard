# agentguard · 试用说明（一页纸）

> 给试用者看的。可直接粘贴到文档 / Notion / 邮件正文。所有命令都实测过。

## 它是什么

**MCP 工具调用的本地防火墙。** 夹在你的 agent 和 MCP server 之间，用一份 YAML 决定「这条工具调用该不该放行」。改 MCP 配置里的一行就生效——不改 agent、不换环境、不联网。

## 它拦什么（默认策略的四个真实例子）

| agent 想做 | 默认结果 |
|---|---|
| `rm -rf /`（或 `rm -r -f /var`） | 拒绝 |
| 读 `./.env`、`~/.ssh/id_rsa` | 拒绝 |
| `git push --force`（`--force-with-lease` 放行） | 拒绝（ask 当前按拒绝处理） |
| 写 `/etc/hosts`、`~/.ssh/config` | 拒绝 |
| `rm -rf ./build`、`npm test`、`git push origin main` | 放行 |

四套策略包合计 30 条规则（`core` / `secrets` / `git` / `net`），`init` 默认装前两套（共 27 条）。规则是可读的 YAML，你可以随便改。

## 装（约 3 分钟，需要 Node ≥ 20）

### 第 1 步：先看效果（还没接入就能跑）

```bash
npx -y @leeruu/agentguard demo      # 内置假 server，直接看放行/拦截
npx -y @leeruu/agentguard init --yes
npx -y @leeruu/agentguard check     # 针对你自己的策略做预演
```

`demo` 的输出长这样（不需要任何 AI 客户端，也不写审计）：

```
 判定   调用               命中规则                上游
  allow  读 ./src/index.ts  base-allow-read         已执行
  deny   读 ./.env          secrets-read-env        未执行
  deny   rm -rf /           core-rm-rf-root         未执行
  allow  rm -rf ./build     base-allow-command      已执行
  ask*   git push --force   core-force-push         未执行
```

> 国内网络慢的话加镜像参数，实测 1.9 秒：`--registry=https://registry.npmmirror.com`

`check` 会打印一张预演表，长这样：

```
预演（拿这些调用去问策略）
  deny   rm -rf /                     ← core-rm-rf-root
  allow  rm -rf ./build               ← base-allow-command
  ask*   git push --force             ← core-force-push
  allow  git push --force-with-lease  ← base-allow-command
  deny   读 ./.env                    ← secrets-read-env
  allow  读 ./src/index.ts            ← base-allow-read
```

**这一步不改变任何东西**，只是让你看看自己会不会被误伤。

### 第 2 步：把它包进 MCP 配置

Claude Code 用 `.mcp.json`（或 `~/.claude.json`），Cursor 用 `~/.cursor/mcp.json`，Cline 在设置页的 `MCP Servers`。**三家结构一样**：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y", "@leeruu/agentguard",
        "--policy", "<家目录>/.agentguard/policy.yaml",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "<你的项目目录>"
      ]
    }
  }
}
```

要点：`--` 之前是 agentguard 的选项，之后是**你原来那行 server 命令**，原样搬过来。路径用正斜杠最省事（`C:/Users/你/...`）。

### 第 3 步：重启客户端，让它随便干点什么

被拦时 agent 侧看到的是明确错误，不是卡住：

```
-32001  Blocked by policy secrets-read-env: 敏感凭据文件（.env）
```

## 你要花多久

**10 分钟**：3 分钟装完，7 分钟跑你自己的 agent、看 `agentguard audit list` 里它到底在干什么。

## 我想知道的三件事

1. `check` 的输出里，**有没有你日常真的会用的命令被误拦**？（把你认得的那几条标出来就行）
2. 你的 agent 干过什么「差点出事」的事，是这里**没拦住**的？
3. 接入哪一步卡住了？（贴 stderr 就行）

## 它不做什么（重要）

- **不联网、不上报、不需要账号。** 策略和审计都在你本机 `~/.agentguard/`。
- **不改你的客户端配置。** 上面那段 JSON 是你自己粘的；`init` 只生成策略文件。
- 不做沙箱、不做容器隔离、不做模型 API 网关。
- **只看请求方向**：工具返回值里漏出来的密钥，它拦不住。
- 审计会把**工具名和截断到 200 字符的参数**写进 `~/.agentguard/audit/`，按天切分、保留 30 天。不想留就设 `AGENTGUARD_AUDIT=off`。

## 出问题怎么找我

```bash
# 想看它具体在做什么（macOS / Linux）
AGENTGUARD_LOG=debug <原命令>

# Windows PowerShell 写法是：
$env:AGENTGUARD_LOG="debug"; <原命令>

# 看最近的判定
npx -y @leeruu/agentguard audit list --limit 20
```

把 `check` 的 stderr 或者 `audit list` 的输出贴给我就行。**不用贴项目代码。**

## 现在能做什么、不能做什么

| | 状态 |
|---|---|
| Windows / macOS / Linux | ✅ 都在测（Windows 是重点覆盖） |
| Claude Code / Cursor / Cline | ✅ 同一份配置结构 |
| Node 版本 | 需要 ≥ 20 |
| npm 版本 | `@leeruu/agentguard@0.2.0`（latest，无 beta tag） |
| 工具返回值检查 | ❌ 没做，明确缺口 |
| 交互式审批（ask 弹确认） | ❌ 没做，`ask` 当前一律拒绝 |
