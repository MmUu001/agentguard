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

## 渠道 2 · Glama（✅ 已提交，条目已上线 2026-11-24）

**条目页（已生成）**：<https://glama.ai/mcp/servers/MmUu001/agentguard>

### 实测结论（2026-11-24）

- 列表页可达，收录量 126,885，**抓取型目录**：提交 repo URL 后自动抓取 GitHub 仓库生成条目页
- 用户表单提交后条目已生成：标题 `mcp-agentguard`、**Security + Developer Tools 双分类**自动归类、作者带 verified 标记、README 全文抓取（含 GIF 引用）
- 提交表单字段实测：Name（kebab-case）/ Description（英文）/ GitHub Repository URL
- README 抓取暴露一处旧数字残留（「11 个 suite / 290 条断言」）已于同日修复；抓取型目录跟随 repo 更新，下次抓取自动同步
- 分类预期实证：Security（`security-and-iam`）+ Developer Tools（`developer-tools`），与预期一致

---

## 渠道 3 · PulseMCP（⏸ 暂缓——全站暂停收录，等重开再提交）

提交入口：<https://www.pulsemcp.com/submit>

### 实测结论（2026-11-24）

- ⚠️ **全站暂停收录新条目**（官方横幅："New server submissions and listing changes are still paused while we rework how we ingest and manage listings"）——**暂缓提交**，等横幅消失再走一遍
- 站内搜索 "agentguard" 已有 3 个同名项目（bmdhodl / mukundakatta / shuaicongxiaomai）——将来上架后靠 owner 前缀 slug 与 Description 首句「tool-call firewall」区分
- 提交表单字段暂未实测（/submit 对非浏览器请求 403 反爬；重开后用浏览器访问）
- 双周复核时复查横幅状态；条目页 URL 模式为 `/servers/<owner>-<name>`

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
| awesome-mcp-servers | 2026-11-24 | （PR 链接待登记） | 已提交至 🔒 Security 分类，等维护者合并 |
| Glama | 2026-11-24 | https://glama.ai/mcp/servers/MmUu001/agentguard | ✅ **已上线**（抓取验证通过） |
| PulseMCP | 暂缓 | — | 全站暂停收录，等重开再提交 |

> 每完成一个填一行。双周复核时对照此表查收录与点击。

## W3 英文文章发布记录（2026-11-24 发布）

| 平台 | URL | 发布验证 |
|---|---|---|
| dev.to | https://dev.to/mmuu001/the-mcp-stdio-disclosure-wont-get-patched-i-built-a-local-guard-for-the-layer-it-named-52b6 | ✅ 线上探针全过（cover GIF/正文 GIF/代码块/无注释泄漏） |
| Hashnode | https://leeruuuu.hashnode.dev/the-mcp-stdio-disclosure-won-t-get-patched-i-built-a-local-guard-for-the-layer-it-named | ✅ 线上探针全过（正文完整/代码块/GIF/链接正常） |

> 48h 数据（浏览/回复）于 2026-11-26 回填；views 数据来自平台后台。
