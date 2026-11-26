# Reddit 发布包（r/mcp + r/ClaudeAI）

> 两帖内容不同侧重点，**不要同一天发**（Reddit 对跨 sub 相同内容敏感）——隔 2–3 天。
> 发前必读各 sub 置顶版规（Rules）；两版都按「自我分享被允许但反感硬广」的口径写。
> 本机网络访问 Reddit 不稳定，用你自己 Chrome 发。

---

## 帖 1 · r/mcp（技术受众，偏工具评估视角）

**标题**：

```
AgentGuard: a local stdio proxy that enforces YAML policies on MCP tool calls (fail-closed, Apache-2.0)
```

**正文**：

```
I kept seeing "my agent deleted things / read .env / force-pushed" posts, and the
existing answers are either full sandboxes (change your whole environment) or
per-agent hook systems (one set per client, no Windows support). So I built a
third option: a single stdio proxy you wrap around any MCP server command in
your existing config.

What it does: every tools/call goes through a YAML policy check before reaching
the real server. deny > ask > allow, fail-closed by default. Ships with 4 rule
packs (30 rules): destructive commands, system paths, secret files (.env reads,
private keys, cloud metadata endpoints), credential exfiltration to issues/PRs,
git history rewrites, rate limits. JSONL audit log, policy hashes, explain
subcommand for single-call verdicts.

Not a gateway, not a sandbox: one process, one config line, no services, no
accounts, no telemetry. Forwards everything except tools/call as raw bytes
(byte-verified against direct connections).

Known limits, stated up front: requests only (response-side leaks not caught);
"ask" without an approval channel = refusal; Windows junctions/\\?\ prefixes
defeat lexical path matching (tracked, fix in progress); regex has load-time
ReDoS warnings but no execution timeout.

30-second test with no client needed (built-in fake server, real proxy):

npx -y @leeruu/agentguard demo

Repo (Apache-2.0, Node >= 20): https://github.com/MmUu001/agentguard

What I most want to hear: things your agent almost did that this would NOT have
caught. Misses are more useful than praise.
```

---

## 帖 2 · r/ClaudeAI（用户视角，故事切入）

**标题**：

```
I wrapped my MCP servers in a local policy proxy after my agent rm -rf'd the wrong directory
```

**正文**：

```
Last month I asked an agent to "clean up build artifacts". It ran rm -rf ./build
-- from the wrong directory. Nothing unrecoverable, but that was the moment I
realized the confirmation dialog had trained me to click "allow" without reading.

So I built AgentGuard: a stdio proxy that wraps any MCP server command in your
config. Every tool call goes through a YAML policy before reaching the server.
Fail-closed by default: anything not explicitly allowed is denied, and an
undefined tool gets refused rather than silently passed.

What it blocks out of the box: .env reads, private keys, cloud metadata
endpoints, rm -rf variants, system path writes, force-pushes, credential
exfiltration into issues/PRs. What it deliberately allows: --force-with-lease,
rm -rf ./build inside your project -- because a guard that breaks normal work
gets uninstalled in a day.

It also writes a JSONL audit log, so you can actually see what your agent has
been doing (grep-able, local only, 30-day retention).

Try it with zero setup (no client needed):

npx -y @leeruu/agentguard demo

Honest limits: requests only, response-side leaks not caught; "ask" = refusal;
Windows junctions can defeat lexical path checks (known, fix in progress).

Repo: https://github.com/MmUu001/agentguard (Apache-2.0, single runtime dep)

If your Claude ever did something you had to undo -- what was it? That's the
list I'm building test cases from.
```

---

## 预答质疑清单（两帖通用，回复时取用）

1. **「为什么不用 sandbox/Docker？」** —— 不同层：沙箱换环境且只答「能不能跑」，本工具答「这条调用该不该放行」且不换环境；两者可叠加。
2. **「各 agent 都有 hook/权限系统了」** —— 每个 agent 一套协议、装一套只覆盖一家、很多不支持 Windows；本工具一份 YAML 覆盖所有 stdio 客户端。
3. **「YAML 配置地狱」** —— `init --yes` 生成 dev 基线（常用读写放行），从审计证据出发收紧，不从空白文件开始。
4. **「junction/`\\?\` 绕过」** —— 已承认、已记录、修复在 0.2.2 计划里；当前 deny-by-default 使其影响面主要在「用户显式放行目录含 junction」场景。
5. **「open core 背刺疑虑」** —— Core 不裁剪是写进方案的承诺，付费卖的是内容/证据/支持；真背刺了 fork 成本对所有人都是三行 patch，社区有兜底。
6. **「能不能看 X 工具的响应？」** —— 不能，请求方向 only，这是 README 里写明的缺口。

## 发布检查单

- [ ] 读两版规（尤其自我推广条款）
- [ ] 帖 1 → r/mcp；隔 2–3 天帖 2 → r/ClaudeAI
- [ ] 帖内命令发前自查一遍（`@beta` 已去）
- [ ] 前 24h 内回复所有评论（语气：承认局限优先）
- [ ] 每帖链接与评论数发我登记
