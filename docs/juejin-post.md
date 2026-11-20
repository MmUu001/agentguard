<!--
掘金发布填写项（这些填在发布页，不要粘进正文）

标题：我给 agent 加了一道闸，拦住了自己差点删掉的构建目录
分类：开发工具（或 人工智能）
标签：MCP、AI、Node.js、安全、CLI
摘要：在 MCP 配置里把 server 命令包一层，用一份 YAML 决定 agent 哪些工具调用不许做。
      fail-closed、可审计、不联网。附 30 秒自测命令。
封面：建议自己截一张终端图，或做一张纯文字封面（1200×630）

注意：
1. 只在结尾放一次 npm 链接，不要放公众号/微信群二维码——掘金对导流敏感，会限流。
2. 代码块已标注语言，复制时保留 ``` 后的语言名。
3. 文中两张图的位置已用「【图 1】」「【图 2】」标出。
-->

上周让 agent「清理一下构建产物」，它执行了：

```bash
rm -rf ./build
```

看起来没问题。但那个项目的构建目录在仓库根，路径少写了一层，实际展开成了……还好我瞥了一眼。

这类事不是个例。我把能想到的「人类会立刻后悔」的操作列了张表，每条都写成了测试用例：

| 操作 | 后果 |
|---|---|
| `rm -rf ./build` 路径拼错成 `./` | 整个项目没了 |
| 为了「清理历史」执行 `git push --force` | 团队代码被覆盖 |
| 调试时把 `.env` 内容贴进新建的 issue | 密钥泄漏，全量轮换 |
| 逻辑 bug 导致循环调用付费 API | 一夜几百美元 |
| 在生产库执行 `DROP TABLE` | 数据不可恢复 |
| 访问 `169.254.169.254` | 云凭据被拿走 |

## 现成的方案，我都不太满意

**确认弹窗**：每个 agent 都有。问题是人的行为——弹到第三次就开始无脑点允许。

**沙箱**：确实隔离，但要换环境（路径、工具链、凭据全得搬进去），而且它只能控制「能不能跑命令」，控制不了「这条调用该不该放行」。

**各家自己的 hook**：有用，但每个 agent 的 hook 协议都不一样，装一套只覆盖一家，而且很多没有 Windows 支持。

**LLM 网关**：这类产品最近很热，但拦的是**模型 API 流量**（调了哪个厂商、花了多少 token），不看「`bash` 这个工具被传入了什么命令」。

它们不是做得不够好，是**拦的位置不对**。

## 唯一的位置：MCP 的 `command` 字段

MCP 协议里，客户端启动 server 的方式就是一个配置项：

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/projects"]
}
```

把这行包一层，就多了一道闸：

```json
{
  "command": "npx",
  "args": [
    "-y", "@leeruu/agentguard@beta",
    "--policy", "C:/Users/你/.agentguard/policy.yaml",
    "--",
    "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"
  ]
}
```

`--` 之前是网关的选项，之后是**原来那行命令原样搬过来**。agent 完全不知道中间多了个进程。

**改 agent 的源码不现实，改 agent 的配置很现实。** 这是 MCP 相比于各家 hook 最大的价值：一次实现，所有支持 stdio 启动 server 的客户端通用。

【图 1：架构示意，agent → agentguard → 真实 MCP server，建议自己画或截一张配置对比图】

## 策略是一份 YAML

```yaml
version: 1

defaults:
  on_no_match: deny      # 没写规则的调用默认拒绝

rules:
  - id: block-rm-rf-root
    match:
      tool: [bash, shell, run_command]
      args.command:
        regex: 'rm\s+(-[a-zA-Z]+\s+)*-(rf|fr)\s+/'
    decision: deny
    reason: 递归删除根目录
```

三条设计上的取舍：

**1. fail-closed。** 没匹配到任何规则就是拒绝。写漏一条规则的结果是「这次调用失败」，不是「这次调用放行」。

**2. `deny > ask > allow`，与规则顺序无关。** 在文件末尾补一条 allow，不会意外放开前面某条 deny。

**3. 不用 LLM 判断危不危险。** 要可复现、可解释、可审计。规则是 YAML，命中哪条、为什么命中，都在错误信息和审计日志里写着。

## 30 秒自测（不需要任何 AI 客户端）

内置了一个假 MCP server，走真实代理链路跑一遍：

```bash
npx -y @leeruu/agentguard@beta demo
```

输出是这样（真实运行结果）：

```text
  判定   调用               命中规则                上游
  ──────────────────────────────────────────────────────
  allow  读 ./src/index.ts  base-allow-read         已执行
  deny   读 ./.env          secrets-read-env        未执行
  deny   写 /etc/hosts      core-write-system-path  未执行
  deny   rm -rf /           core-rm-rf-root         未执行
  allow  rm -rf ./build     base-allow-command      已执行
  ask*   git push --force   core-force-push         未执行
  deny   未定义的工具       (fail-closed)           未执行
```

「未执行」是字面意思：被拦的调用根本没到上游。

注意 `rm -rf ./build` 是放行的，`git push --force-with-lease` 也是放行的——这类「安全版本」如果被误拦，产品就没人用了。

【图 2：上面这段 demo 输出在你终端里的截图（自己跑一遍截屏，比任何示意图都有说服力）】

## 它拦不住的（说清楚比藏着好）

- **只看请求方向**。工具返回值里漏出来的密钥，拦不住
- **`ask` 目前没有审批通道**，实际按拒绝处理（代理的 stdin 就是协议流，从里面读 y/n 会把 MCP 消息吃掉）
- **不通过 MCP 的子进程**，看不见
- 正则没有执行超时，写得极端的模式可能拖慢网关（有加载期告警，但不硬拦）

## 怎么接

```bash
# 1. 生成策略（不覆盖你任何客户端配置）
npx -y @leeruu/agentguard@beta init --yes

# 2. 先看它会拦什么（还没接入就能跑）
npx -y @leeruu/agentguard@beta check
```

然后把它打印的那段 JSON 粘进客户端的 MCP 配置——**是包住你已有的 filesystem server，不是新增一个**。

第一次接进去建议开观察模式：

```bash
npx -y @leeruu/agentguard@beta init --observe --force
```

只记录不拦截，跑一周看 `audit list` 里 agent 到底在干什么，再决定收紧什么。

## 最后

Apache-2.0，不联网、不需要账号、没有 telemetry，审计就是本地 JSONL，`grep` 就能查。运行时依赖只有 1 个（`yaml`）。

国内网络如果 npx 很慢，加镜像参数（实测 1.9 秒）：

```bash
npx -y --registry=https://registry.npmmirror.com @leeruu/agentguard@beta demo
```

npm：https://www.npmjs.com/package/@leeruu/agentguard

最想听的反馈是：**你的 agent 干过什么「差点出事」的事，而这个东西没拦住。** 漏拦比误拦更值得说。
