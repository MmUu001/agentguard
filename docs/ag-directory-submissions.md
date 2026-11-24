# AgentGuard 目录提交材料（三渠道操作卡）

> 编制：2026-11-24。状态标注：**实测** = 本会话直接取证；**待校准** = 编制时该入口不可达，文案按同类格式预写，提交前需人工核对。
> 三渠道优先级：awesome-mcp-servers PR（最确定、免费）→ Glama（入口可达、需登录）→ PulseMCP（入口确认存在、提交页本机当前不可达）。

---

## 渠道 1 · awesome-mcp-servers PR（P0，你操作 10 分钟）

上游仓库：<https://github.com/punkpeye/awesome-mcp-servers>

### 流程（与 ChangeGuard PR 流程相同，网页全流程）

1. 打开上游仓库 → 右上角 **Fork** → Create fork
2. fork 里打开 README.md → 铅笔编辑
3. Ctrl+F 找分类：优先 `Security` 类分类；没有贴切的就找 `Developer Tools`
4. 在该分类列表**末尾**追加一行（下方文案直接粘）：
5. Preview 确认 → Commit changes → Contribute → Open pull request

### AG 条目文案（粘贴用）

```markdown
- [agentguard](https://github.com/MmUu001/agentguard) - Local MCP tool-call firewall: a stdio proxy that enforces a YAML policy (deny > ask > allow, fail-closed by default) on every tools/call before it reaches the real server — blocks .env/credential reads, rm -rf, system writes and secret exfiltration; JSONL audit log with policyHash, rate limits, cross-client tool-name aliases. `npx -y @leeruu/agentguard demo`
```

### PR 标题与描述（粘贴用）

```
标题：Add agentguard - local MCP tool-call firewall with YAML policy

描述：
[agentguard](https://github.com/MmUu001/agentguard) is a local stdio proxy that sits
between any MCP client and the real server, enforcing a user-editable YAML policy on
every tools/call: deny/ask/allow with explicit fail-closed default, exception
(whitelist) support, rate limits, JSONL audit with policyHash, and cross-client
tool-name alias expansion. Apache-2.0, Node >= 20, one runtime dependency. 30 rules
across 4 packs; 18 attack cases blocked, 336 assertions green.
```

> **待校准**：分类名与条目插入位置需在上游 README 里现场核对（编制时 GitHub 通道不可达，未能重读上游 README）。维护者若要求改格式，按意见修改即可。

---

## 渠道 2 · Glama（P1，你操作 5 分钟 + 登录）

提交入口：<https://glama.ai/mcp/servers> 页面的 **Add Server** 按钮

### 实测结论（2026-11-24）

- 列表页可达，收录量 126,885，**抓取型目录**：提交 repo URL 后自动抓取 GitHub 仓库生成条目页
- AG **尚未被自动收录**（`glama.ai/mcp/servers/MmUu001/agentguard` 实测 404）
- Add Server 需要登录（页面右上 Sign In / Sign Up，用 GitHub 账号 OAuth）

### 流程

1. <https://glama.ai> 右上角 **Sign In**（GitHub OAuth，用 MmUu001）
2. 进 <https://glama.ai/mcp/servers> → 点 **Add Server**
3. 填 repo URL：`https://github.com/MmUu001/agentguard` → 提交后自动抓取
4. 抓取完成后打开条目页，核对自动抓取效果（重点：描述是否取自 README 首屏、GIF 是否显示）

### 抓取效果核对要点（抓取型目录的展示 = 被抓仓库的 README 质量）

- AG README 首屏：一句话定位 + GIF + 可复制命令——抓取型目录展示所需的三件套都在
- GIF 是仓库相对路径 `docs/images/demo-agentguard.gif`，若 Glama 条目页图片断链，属目录侧渲染问题，不影响收录

### 分类预期（Glama 自动归类，无需手填）

从列表页过滤参数实证的分类 slug：`security-and-iam`（6,921 个条目）、`developer-tools`（30,520 个）——AG 预期落入这两个。

---

## 渠道 3 · PulseMCP（P2，等网络窗口或你本地浏览器）

提交入口：<https://www.pulsemcp.com/submit>

### 实测结论（2026-11-24）

- 站点可达但 `/submit` 页对非浏览器请求返回 **403**（反爬）；浏览器直访该页两次 60s 超时——页面强制加载的 recaptcha / jspm CDN 域在当前网络窗口不可达
- 入口存在性已实证（站点 footer 有「Submit server/client」→ `/submit`）
- **表单字段未实测** → 下面文案为预写版，打开表单后按字段名对号入座

### 流程（你本地浏览器直接开，避开本机网络窗口问题）

1. 浏览器打开 <https://www.pulsemcp.com/submit>
2. 按表单字段填写（预填文案见下）
3. 提交后记录 PulseMCP 给的条目 URL

### 预填文案

```text
Name: AgentGuard
URL: https://github.com/MmUu001/agentguard
Short description:
AgentGuard is a local MCP tool-call firewall — a stdio proxy that enforces a YAML
policy on every tool call before it reaches the real server. Deny/ask/allow with
fail-closed default, exceptions, rate limits, JSONL audit with policyHash, and
cross-client tool-name aliases. Try it in 10 seconds: npx -y @leeruu/agentguard demo
```

---

## 提交登记

| 渠道 | 提交日期 | 条目 URL | 状态 |
|---|---|---|---|
| awesome-mcp-servers | | | 待 PR |
| Glama | | | 待登录提交 |
| PulseMCP | | | 待表单可达 |

> 每完成一个填一行。双周复核时对照此表查收录与点击。

## W3 英文文章发布记录（2026-11-24 发布）

| 平台 | URL | 发布验证 |
|---|---|---|
| dev.to | https://dev.to/mmuu001/the-mcp-stdio-disclosure-wont-get-patched-i-built-a-local-guard-for-the-layer-it-named-52b6 | ✅ 线上探针全过（cover GIF/正文 GIF/代码块/无注释泄漏） |
| Hashnode | （待补公开 URL——用户给的是 /edit/ 编辑页地址） | 待验证 |

> 48h 数据（浏览/回复）于 2026-11-26 回填；views 数据来自平台后台。
