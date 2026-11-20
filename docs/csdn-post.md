<!--
CSDN 发布填写项（不要粘进正文）
标题：MCP 权限网关实战：给 AI Agent 的工具调用加一道本地防火墙（附可复现 Demo）
分类：人工智能（或 后端 / 开发工具）
标签：MCP、AI、Node.js、安全、CLI（最多 5 个）
原创：原创
封面：用 docs/images/agentguard-cover.png（1200×630），或直接选文中第一张图
摘要：在 MCP 配置里把 server 命令包一层，用一份 YAML 决定 agent 哪些工具调用不许做。
      fail-closed、可审计、不联网，附 30 秒自测命令。
-->

# 前言

> 本文适合：正在用 Cline / Cursor / Roo Code 等工具跑 MCP server 的开发者。
> 读完你会得到：一个能在 30 秒内自测的本地权限闸，以及一套可以直接改的 YAML 策略写法。

先说结论：**给 agent 加防线，最省事的位置不是 agent 本身，而是它调 MCP 工具的那一层。**

下面是完整过程，所有命令和输出都实测过。

**环境要求**

| 项 | 要求 |
|---|---|
| Node | ≥ 20 |
| 系统 | Windows / macOS / Linux（Windows 专门测过 `.cmd` 垫片与含空格路径） |
| 客户端 | 任意以 stdio 启动 MCP server 的客户端 |

---

# 一、这类事故长什么样

上周让 agent「清理一下构建产物」，它执行了：

```bash
rm -rf ./build
```

看起来没问题。但那个项目的构建目录在仓库根，路径少写了一层，实际展开成了整个仓库。还好我瞥了一眼。

把「人类会立刻后悔」的操作列一张表，每条都能用一条命令复现：

| 操作 | 后果 |
|---|---|
| `rm -rf ./build` 路径拼错成 `./` | 整个项目没了 |
| 为了「清理历史」执行 `git push --force` | 团队代码被覆盖，不可恢复 |
| 调试时把 `.env` 内容贴进新建的 issue | 密钥泄漏，全量轮换 |
| 逻辑 bug 导致循环调用付费 API | 一夜几百美元 |
| 在生产库执行 `DROP TABLE` | 数据不可恢复 |
| 访问 `169.254.169.254` | 云凭据被拿走 |

**agent 在执行命令这件事上，没有「手滑了一下」这个缓冲。**

---

# 二、为什么现成方案都不太够

| 方案 | 问题 |
|---|---|
| 确认弹窗 | 人的行为问题：弹到第三次就开始无脑点允许 |
| 沙箱 / 容器 | 要换环境（路径、工具链、凭据全得搬进去）；且只能控制「能不能跑命令」，控制不了「这条调用该不该放行」 |
| 各家自己的 hook | 每个 agent 的 hook 协议都不一样，装一套只覆盖一家，很多没有 Windows 支持 |
| LLM 网关 | 拦的是**模型 API 流量**（厂商、token 用量），不看「`bash` 这个工具被传入了什么命令」 |

它们不是做得不够好，是**拦的位置不对**。

---

# 三、把拦截点放在 MCP 的 `command` 字段

MCP 协议里，客户端启动 server 的方式就是一个配置项：

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/projects"]
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
    "npx", "-y", "@modelcontextprotocol/server-filesystem", "D:/projects"
  ]
}
```

`--` 之前是网关的选项，之后是**原来那行命令原样搬过来**。agent 完全不知道中间多了一个进程。

（在这里插入图片：`docs/images/csdn/arch.png`）

*图 1｜拦截点在 MCP 的 command 字段，被拒绝的调用根本到不了 server*

**为什么是这里**：改 agent 的源码不现实，改 agent 的配置很现实。MCP 是所有这类客户端唯一的共同扩展点——一次实现，全部通用。

---

# 四、策略就是一份 YAML

```yaml
version: 1

defaults:
  on_no_match: deny          # 没有任何规则命中时：拒绝（fail-closed）

rules:
  - id: block-rm-rf-root
    match:
      tool: [bash, shell, run_command]
      args.command:
        regex: 'rm\s+(-[a-zA-Z]+\s+)*-(rf|fr)\s+/'
    decision: deny
    reason: 递归删除根目录

  - id: protect-secrets
    match:
      tool: [read_file, read_multiple_files]
      args.path:
        glob: ["**/.env", "**/*.pem", "**/id_rsa*"]
    decision: deny
    reason: 敏感凭据文件
```

三条设计上的取舍，值得单独说：

**1. fail-closed。** 没匹配到任何规则就是拒绝。写漏一条规则的结果是「这次调用失败」，不是「悄悄放行」。

**2. `deny > ask > allow`，与规则顺序无关。** 在文件末尾补一条 allow，不会意外放开前面某条 deny——这一条消除了一整类「我明明写了 deny 为什么没生效」的调试。

**3. 不用 LLM 判断命令危不危险。** 要可复现、可解释、可审计，LLM 三样都做不到。规则是 YAML，命中哪条、为什么命中，都在错误信息和审计日志里写着。

匹配语义：`glob` / `regex` / `equals` / `in` / `prefix` 五种操作符；同一操作符多值是 OR，同一规则多字段是 AND。

---

# 五、30 秒验证：不用装任何客户端

内置了一个假 MCP server，走**真实的代理链路**跑一遍，不需要你接任何 AI 客户端：

```bash
npx -y @leeruu/agentguard@beta demo
```

（在这里插入图片：`docs/images/csdn/terminal-demo.png`）

*图 2｜demo 的真实输出，7 次调用 4 次被拦*

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

「未执行」是字面意思：**被拦的调用根本没到上游**。

注意两个放行项，这是设计上刻意的：

- `rm -rf ./build` 必须放行，否则正常开发瘫痪
- `git push --force-with-lease` 也放行——它是强制推送的安全版本，写错一个字符就会误伤所有人

---

# 六、接入你的客户端

```bash
# 1. 生成策略（不会修改你任何客户端配置）
npx -y @leeruu/agentguard@beta init --yes

# 2. 预览它会拦住什么（还没接入就能跑）
npx -y @leeruu/agentguard@beta check
```

`init` 会在 `~/.agentguard/` 下生成 `policy.yaml` 和四个策略包，并打印一段可以直接复制的 JSON。

（在这里插入图片：`docs/images/csdn/config-diff.png`）

*图 3｜改动只有 args 这几行，客户端的 server 名保持不变*

**关键：要包住你已有的 server，不是新增一个。** 否则会出现两个能力相同、工具列表重复的 server，agent 挑着用，你也不知道拦截生效在哪条路径上。

第一次接进去建议先开观察模式：

```bash
npx -y @leeruu/agentguard@beta init --observe --force
```

只记录不拦截，跑一周看审计：

```bash
npx -y @leeruu/agentguard@beta audit list --limit 20
npx -y @leeruu/agentguard@beta audit stats --since 7d
```

先看，再拦。这才是这类工具的正确启动姿势。

---

# 七、它拦不住什么（写在前面比被打脸好）

| 限制 | 说明 |
|---|---|
| 只看请求方向 | 工具**返回值**里漏出来的密钥，拦不住 |
| `ask` 没有审批通道 | 实际按拒绝处理。代理的 stdin 就是协议流，从里面读 y/n 会把 MCP 消息吃掉 |
| 不通过 MCP 的子进程 | agent 自己起进程，看不到 |
| 正则无执行超时 | 极端写法可能拖慢网关，有加载期告警但不硬拦 |

这些在 README 里都写明了。**安全类工具最忌讳把「没做」说成「做了」**——第一次翻车时，信任就没了。

---

# 八、小结

- 拦 agent 的位置，最省事的是 **MCP 的 `command` 字段**：只改配置，不动代码
- 策略用 **YAML + fail-closed**：可读、可审计、可解释
- **默认拒绝**比默认放行更安全，但必须配一组基线放行，否则接上去就瘫痪
- 先 `check` 预览、再 `--observe` 观察，最后才收紧

项目 Apache-2.0，运行时依赖只有 1 个（`yaml`），不联网、不需要账号、审计写在本地 `~/.agentguard/audit/`。

npm 地址：https://www.npmjs.com/package/@leeruu/agentguard

国内网络如果 npx 慢，加镜像参数（实测 1.9 秒）：

```bash
npx -y --registry=https://registry.npmmirror.com @leeruu/agentguard@beta demo
```

---

如果试了，最想听到的反馈是：**你的 agent 干过什么「差点出事」的事，而这个东西没拦住。** 漏拦比误拦更有价值——误拦只是烦，漏拦是真的会出事。
