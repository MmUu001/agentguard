# Show HN 发布包

> 发布窗口：周二–周四 08:00–10:00 PT（= 北京时间周三–周五 00:00–02:00，深夜场）。
> 入口：news.ycombinator.com → submit。标题不带「Show HN:」前缀由表单类型生成，直接填标题即可。
> 发布后 10 分钟内自己发第一条评论（草稿见文末）——HN 惯例，把局限先摆出来能显著改善评论区风向。

## 标题（二选一，≤80 字符）

```
Show HN: AgentGuard – Local firewall for MCP tool calls, YAML policy, fail-closed
```

```
Show HN: I built a stdio proxy that blocks MCP agents from reading .env
```

（推荐第一个：技术描述型在 HN 更稳；第二个更抓眼但像营销。）

## 正文（HN submit 的 text 字段，可直接粘）

```
AgentGuard is a local stdio proxy that sits between your AI agent and any MCP
server. You wrap the server's command line in your existing MCP config, and every
tools/call passes a YAML policy check before it reaches the real server:
deny > ask > allow, fail-closed by default. Blocks .env reads, rm -rf, system
path writes, credential exfiltration to issues/PRs, and cloud metadata endpoints.
JSONL audit log with policy hashes, rate limits, cross-client tool-name aliases.

It is not a gateway and not a sandbox: single process, one config line, no
services, no accounts, no telemetry. Apache-2.0, Node >= 20, one runtime
dependency. 30 rules across 4 packs, 18 attack cases blocked, 336 assertions.

Try it without wiring anything up (built-in fake server, real proxy):

    npx -y @leeruu/agentguard demo

Repo: https://github.com/MmUu001/agentguard
npm: @leeruu/agentguard
```

## 首评（发布后你自己发的第一条 comment）

```
Author here. Stating the limits up front, since a security tool that oversells
is worse than useless:

- Requests only. If a tool's *response* leaks a secret, this does not catch it.
- "ask" has no interactive approval channel -- stdin is protocol traffic -- so
  ask resolves to refusal. Use --observe mode first if you want logging without
  blocking.
- Regex policies get a ReDoS warning at load time but no execution timeout yet.
- Known bypass class, reported by a reader on the dev.to launch post: Windows
  directory junctions (mklink /J) and \\?\ prefixes defeat lexical path matching.
  Fix tracked (realpath resolution on write paths), not shipped yet. If you
  *deny* system paths lexically, treat that as best-effort, not a guarantee.

Design choice worth noting: it only parses lines containing "tools/call".
Everything else -- including server-to-client messages like sampling/createMessage --
is forwarded as raw bytes, verified byte-for-byte against direct connections.
```

## 预答质疑（评论区准备，按需取用）

**Q: Why not just use a sandbox / Docker?**
> Different layer: a sandbox changes the environment (paths, toolchain, credentials
> all move inside), and it only answers "can this run at all". AgentGuard answers
> "should this specific call be allowed" in your real environment with zero setup.
> They compose fine -- run the proxy inside a sandbox if you want both.

**Q: Every agent already has confirmation prompts.**
> Humans stop reading dialogs after the third one. A policy file is consistent,
> auditable, and fail-closed; a popup is neither. Also this covers all clients
> with one rule set instead of per-agent hook systems (many without Windows support).

**Q: Why YAML and not an LLM judging danger?**
> Reproducibility. An auditor can read a YAML rule, a verdict, and a rule id in
> the JSONL log. "The model thought it was probably fine" is not auditable.

**Q: Open core -- will you rug the free tier?**
> The AG plan explicitly keeps Core un-cropped forever: proxy, engine, all 4
> packs, audit, explain are free and stay free. The paid tier is compliance
> mapping packs, report templates, and support -- content and humans, not code
> gates. If that ever changes, the fork will be trivial and everyone knows it.

**Q: Isn't this just one more YAML config to maintain?**
> `init --yes` generates a dev-baseline policy (common reads allowed, secrets and
> destructive ops blocked). Most users start from that and adjust on audit
> evidence, not from a blank file.

## 发布检查单

- [ ] 窗口：周二–四 08:00–10:00 PT
- [ ] 标题已选定（不带自己的营销腔）
- [ ] 发帖后 10 分钟内贴首评
- [ ] 前 2 小时内盯评论区（HN 前 2 小时决定命运）
- [ ] 每条质疑用上面清单应对；没准备到的诚实说「good point, noted in the issue tracker」
- [ ] 48h 后把帖子链接与评论数发我登记
