# 社区发帖稿

> 三个版本：**长文**（V2EX / 掘金 / 博客）、**短文**（即刻 / X）、**英文**（Reddit r/mcp、HN）。
> 所有命令与输出都是实测过的，不是示意。

---

## 发之前先看这 5 条

1. **标题里不要出现「求试用」「跪求」「帮忙测试」**——一出现就变成广告，社区会直接降权。
2. **第一段写具体事故，不要写产品介绍**。人对"我也遇到过"有反应，对"我做了个工具"没有。
3. **链接只出现一次，放最后**。
4. **主动写出已知限制**（响应侧没做、ask 等于拒绝）。评论区一定会问，先说出来比被打脸强。
5. **同一天不要多个群刷**。发一个地方，看反应，再决定下一个。

---

## 一、长文版（V2EX「分享创造」/ 掘金 / 个人博客）

**标题**（任选）：
- 我给 agent 加了一道闸，拦住了自己差点删掉的构建目录
- agent 执行 `rm -rf ./build` 时路径写错会怎样——我做了个本地闸

**正文**：

```
上周让 agent「清理一下构建产物」，它执行了：

    rm -rf ./build

看起来没问题。但那个项目的构建目录在仓库根，路径少写了一层，实际展开成了……还好我瞥了一眼。

这类事不是个例。我把能想到的「人类会立刻后悔」的操作列了张表，每条都写成了测试用例：
rm -rf 根目录、读 .env、git push --force、curl | sh、DROP TABLE、访问 169.254.169.254。

现成的方案我都不太满意：
- 确认弹窗：点第三次之后就开始无脑允许了
- 沙箱：要换环境，而且控制不了「这条命令该不该跑」
- 各家自己的 hook：每个 agent 协议都不一样，装一套只覆盖一家，Windows 还没有
- LLM 网关：拦的是模型 API 流量，不看「bash 这个工具被传入了什么命令」

它们不是做得不够，是拦的位置不对。

MCP 协议里，客户端启动 server 的方式就是一个配置项：

    { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/projects"] }

把这行包一层，就多了一道闸：

    { "command": "npx",
      "args": ["-y", "@leeruu/agentguard@beta",
               "--policy", "…/policy.yaml",
               "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"] }

agent 完全不知道中间多了个进程。策略是一份 YAML：

    - id: block-rm-rf-root
      match:
        tool: [bash, shell, run_command]
        args.command: { regex: 'rm\s+(-[a-zA-Z]+\s+)*-(rf|fr)\s+/' }
      decision: deny

判定优先级是 deny > ask > allow，跟规则顺序无关；没写规则的调用默认拒绝（fail-closed）；
所有判定落在本地 JSONL，按天切分，grep 就能查。

不想装、不想接也能先看效果——内置了一个假 MCP server，走真实代理链路：

    $ npx -y @leeruu/agentguard@beta demo

     判定   调用               命中规则                上游
     allow  读 ./src/index.ts  base-allow-read         已执行
     deny   读 ./.env          secrets-read-env        未执行
     deny   写 /etc/hosts      core-write-system-path  未执行
     deny   rm -rf /           core-rm-rf-root         未执行
     allow  rm -rf ./build     base-allow-command      已执行
     ask*   git push --force   core-force-push         未执行
     deny   未定义的工具       (fail-closed)           未执行

  「未执行」是字面意思：被拦的调用根本没到上游。

默认装 core + secrets 两套策略包（19 条规则），再加 5 条基线放行，一共 24 条；
另外还有 git / net 两套可选（四套全装是 27 条规则）。

说清楚它拦不住的：
- 只看请求方向。工具返回值里漏出来的密钥，拦不住
- ask 目前没有审批通道，实际按拒绝处理
- 不通过 MCP 的子进程，看不到

Apache-2.0，不联网、不上报、不需要账号。策略和审计都在 ~/.agentguard/。

https://www.npmjs.com/package/@leeruu/agentguard

最想听的反馈是：你的 agent 干过什么「差点出事」的事，而这个东西没拦住。
```

---

## 二、短文版（即刻 / X）

```
给 agent 加了一道本地闸。

起因是它执行 `rm -rf ./build`，路径少写了一层，差点删到仓库根。

做法是在 MCP 配置里把 server 命令包一层，用 YAML 决定哪些调用不许做。
不改 agent、不换环境、不装沙箱。

不接入也能先跑（内置假 server，30 秒）：

    npx -y @leeruu/agentguard@beta demo

      deny   rm -rf /           ← 拦住
      deny   读 ./.env          ← 拦住
      allow  rm -rf ./build     ← 放行
      allow  git push --force-with-lease   ← 安全版本，故意放行

Apache-2.0，不联网、不上报。`init` 默认生成 24 条规则（基线 + core + secrets），装完即用。

它拦不住返回值里的密钥泄漏——只看请求方向，这点我在 README 里写明了。

想知道你们的 agent 干过什么"差点出事"的事，是我漏掉的那种。
```

---

## 三、英文版（Reddit r/mcp / Show HN）

**Title**: `Show: A local permission gateway for MCP tool calls (YAML, fail-closed)`

```
I kept hitting the same failure mode: the agent runs `rm -rf ./build`, the path is
one level off, and it takes out the repo root instead.

Existing options didn't fit:
- confirmation prompts: by the third one you're just clicking Allow
- sandboxes: different environment, and they can't decide "should this command run"
- per-agent hooks: different protocol for every client, no Windows support
- LLM gateways: they sit on model API traffic, not on MCP tool calls

So I put the interception point where every MCP client agrees: the `command` field.

    { "command": "npx",
      "args": ["-y", "@leeruu/agentguard@beta", "--policy", "...", "--",
               "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"] }

The agent doesn't know there's an extra process. Policy is YAML. Priority is
deny > ask > allow regardless of rule order; anything without a matching rule is
denied (fail-closed); every decision is appended to a local JSONL file.

No client needed to see it work — there's a built-in fake MCP server:

    $ npx -y @leeruu/agentguard@beta demo

     allow  读 ./src/index.ts  base-allow-read         已执行
     deny   读 ./.env          secrets-read-env        未执行
     deny   rm -rf /           core-rm-rf-root         未执行
     allow  rm -rf ./build     base-allow-command      已执行

("未执行" = the call never reached upstream.)

What it does NOT do, explicitly:
- only inspects the request direction — secrets leaking back in tool output are not caught
- `ask` has no approval channel yet, so it's treated as deny
- child processes that bypass MCP are invisible to it

Apache-2.0, no telemetry, no account, audit stays in ~/.agentguard/.

https://www.npmjs.com/package/@leeruu/agentguard

What I actually want: the near-miss your agent had that this thing would not catch.
```

---

## 四、评论区应对（大概率会被问到的五个）

**「这不就是沙箱吗？」**
> 沙箱要换环境（路径、工具链、凭据都得搬进去）；这个不换环境，是在你原来的配置上加一层规则。
> 沙箱管「能不能跑命令」，这个管「这条调用该不该放行」。

**「hook 也能做，为什么要多一层代理？」**
> hook 要逐家适配，每家协议不同，Windows 上很多根本没有。
> MCP 是这些客户端唯一的共同扩展点，一次实现就通用。改动只是把 server 命令包一层。

**「为什么不用 LLM 判断危不危险？」**
> 要可复现、可解释、可审计。LLM 三样都做不到。
> 规则是 YAML，命中哪条、为什么命中，都在错误信息和审计里写着。

**「会不会误伤正常操作？」**
> 会。所以有两条退路：`check` 在**不接入**的情况下预演会拦什么；`dry_run` 只记录不拦截。
> 建议第一次接就开 `--observe` 跑一周，看审计再收紧。

**「安全吗？会不会偷偷上传数据？」**
> 不联网、不需要账号、没有 telemetry。审计就是本地 JSONL，路径是 `~/.agentguard/audit/`。
> 源码在包里是编译产物，逻辑可以看；运行时依赖只有 `yaml` 一个。

---

## 五、发布节奏（别一次全铺）

| 天 | 发哪里 | 目的 |
|---|---|---|
| D4 | V2EX「分享创造」 | 拿第一波真实反馈 |
| D5 | 掘金（加代码块与架构图） | 长尾搜索流量 |
| D6 | 即刻 / X 短文 | 熟人圈扩散 |
| D7 | Reddit r/mcp（英文版） | 海外长尾 |

**发完当天不要反复顶帖**，第二天看评论再回。V2EX 顶帖会被当刷屏。
