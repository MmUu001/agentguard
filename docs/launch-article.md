# 你的 agent 会 `rm -rf` 你的项目。给它加一道只在本地生效的闸。

上周有个朋友给我看他的终端记录。他要 agent「清理一下构建产物」，agent 执行了：

```bash
rm -rf ./build
```

看起来没问题。但他那个项目的构建目录配在仓库根，`./build` 前面少写了一个 `./dist/` 之类的前缀，实际展开成了……他的原话是「还好我瞥了一眼」。

这类事不是个例。我把能想到的「人类会立刻后悔」的操作列了一张表，每一条都写成了测试用例：

| 场景 | 后果 |
|---|---|
| `rm -rf ./build` 路径拼错成 `./` | 整个项目没了 |
| agent 为了「清理历史」执行 `git push --force` | 团队代码被覆盖，不可恢复 |
| 调试时把 `.env` 内容贴进新建的 issue | 密钥泄漏，全量轮换 |
| 循环调用付费 API（逻辑 bug） | 一夜几百美元 |
| 在生产库执行 `DROP TABLE` | 数据不可恢复 |
| 访问 `169.254.169.254` | 云凭据泄漏 |

我一条都没全遇到过。但这不重要——**每一条都能用一条命令复现**，而 agent 在执行命令这件事上，没有「手滑了一下」这个缓冲。

## 现成的方案为什么不管用

**确认弹窗。** 每个 agent 都有。问题是人的行为：弹到第三次就开始无脑点允许，弹到第三十次连内容都不看了。用户关掉弹窗的方式不是「配好规则」，是「找到设置里那个开关」。

**沙箱。** Docker / 虚拟机确实隔离，但代价是换一个环境跑。你的项目路径、你的工具链、你的凭据，全得搬进去。而且它只能控制「能不能跑命令」，控制不了「这条命令该不该跑」。

**各家自己的 hook。** 有用，但每个 agent 的 hook 协议都不一样，装一套只覆盖一家。我查了一下 GitHub 上最接近我们想法的项目（`SumonMSelim/agentguard`，54 星）：它支持 9 个 agent，通过 Homebrew / apt / 手动克隆安装，依赖 `bash + jq`，平台写的是 `macOS | Linux`。

**LLM 网关。** 这类产品最近很热（`apache/casbin-gateway`，650 星），但它拦的是**模型 API 流量**——你调了哪个厂商、花了多少 token、是不是你付钱的那个端点。它不看「`bash` 这个工具被传入了什么命令」。

这四类都不是「做得不够好」，是**拦的位置不对**。

## 唯一的位置

MCP 协议里，客户端启动 server 的方式是一个配置项：

```json
{ "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/projects"] }
```

把这行包一层，就多了一道闸：

```json
{ "command": "npx", "args": ["-y", "@leeruu/agentguard", "--policy", "…/policy.yaml",
                             "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"] }
```

**改 agent 的源码不现实，改 agent 的配置很现实。** MCP 是这些客户端唯一的共同扩展点——一次实现，Claude Code、Cursor、Cline 全都通吃，而且 agent 完全不知道中间多了一个进程。

这就是 `agentguard`。它不是平台，不是沙箱，是一个 2,477 行的本地代理。

## 五个必须坚持的设计决定

**1. fail-closed：没写规则 = 拒绝。**

默认值选 `deny`。写漏一条规则的结果是「这次调用失败」，不是「这次调用放行」。策略文件解析失败？直接不启动，绝不带病运行。

这条会有代价：初次接入会误伤。所以 `init` 生成的策略里带了一组「基线放行」——常见读写、命令工具默认允许，危险动作交给规则兜。想严一点的用 `--profile strict`，一条 allow 都不生成。

**2. `deny > ask > allow`，跟规则顺序无关。**

在文件末尾补一条 allow，不会意外放开前面某条 deny。规则顺序只影响「同档取哪条」，不影响结果。这消除了一整类「我明明写了 deny 为什么没生效」的调试。

**3. 不用 LLM 判断「这条命令危不危险」。**

必须可复现、可解释、可审计。LLM 一样都做不到。规则是 YAML，命中哪条、为什么命中，都在错误信息和审计里写着。

**4. 转发原始字节，不做 JSON 往返。**

代理要解析才能判定 `params.name` 和 `params.arguments`，但转发时保留原始字符串。解析完再 `JSON.stringify` 会改浮点精度、字段顺序、转义形式——对上游来说这就是「代理破坏了协议」。

**5. `ask` 目前等于「明确拒绝」，不是「静默放行」。**

代理的 stdin 就是 MCP 协议流，从里面读 `y/n` 会把协议消息吃掉。真要弹交互确认，必须另开控制终端，而这个环境在绝大多数 MCP 客户端里根本不存在。所以在拿到可靠的审批通道之前，`ask` 的行为就是拒绝，错误信息里写清楚「需要人工确认，当前无审批通道」。

方向永远是 fail-closed，绝不为了让功能看起来完整而放行。

## 它实际长什么样

```bash
$ npx agentguard init

已生成（24 条规则，0 条限流）
  ~/.agentguard/policy.yaml
  ~/.agentguard/packs/core.yaml
  ~/.agentguard/packs/secrets.yaml

模式      拦截
基线      dev：放行日常开发工具
未匹配    deny（fail-closed）
```

装完先看它会拦什么，而不是直接接进 agent：

```bash
$ npx agentguard check

预演（拿这些调用去问策略）
  deny   rm -rf /                     ← core-rm-rf-root
  deny   rm -r -f /var                ← core-rm-rf-split-flags
  allow  rm -rf ./build               ← base-allow-command
  ask*   git push --force             ← core-force-push
  allow  git push --force-with-lease  ← base-allow-command
  deny   curl … | bash                ← core-pipe-to-shell
  deny   psql DROP TABLE              ← core-sql-destructive-command
  deny   读 ./.env                    ← secrets-read-env
  allow  读 ./src/index.ts            ← base-allow-read
  deny   写 /etc/hosts                ← core-write-system-path
  deny   未定义工具                   ← (未命中规则)
```

注意 `git push --force-with-lease` 是放行的——它是强制推送的安全版本，写成一条规则就会误伤，所以正则里带了 `(?!-)`。

真实 filesystem server 过代理后，agent 侧看到的是：

```
读 app.ts     → "export const ok = true;\n"
读 .env       → -32001  Blocked by policy secrets-read-env: 敏感凭据文件（.env）
写 /etc/hosts → -32001  Blocked by policy core-write-system-path: 写入系统目录或凭据目录
```

**是明确的错误，不是卡住，不是崩溃。** 这一条我专门测过：被拦的调用在 agent 里要表现为一次失败的工具调用，这个会话才能继续。

```bash
$ npx agentguard audit stats

总计      3 条
判定      deny 2  /  allow 1

按规则
  core-write-system-path  1
  secrets-read-env        1
  base-allow-read         1
```

## 我把它测到了什么程度

自测清单，全部可复现：

- **18 条攻击用例全部拦截**，20 条日常开发操作**零误伤**（`rm -rf node_modules`、`git push origin main`、`psql SELECT`、读 `.env.example`…）
- **真实 filesystem server**：直连 vs 过代理，响应逐字节相同（含中文、含空格路径）
- 8 MiB 单行不截断；1,000 次连续调用往返 p99 **1.19ms**；33 条规则判定 p99 **0.073ms**
- Windows 专项：`.cmd` 垫片、带空格路径、CRLF 行尾、行首 UTF-8 BOM
- 冷启动：`init` → 真实 server 首次成功调用 **3.3 秒**；把 check 和 audit 也算上，整段 demo 7.9 秒
- 336 条断言 / 15 个测试套件，包括「策略写错必须拒绝启动」「上游崩溃时未完成请求收到错误码」这类边角

## 它现在拦不住的（说清楚比藏着好）

**响应方向。** 代理只看请求。工具返回的内容里带密钥，我拦不住——方案里有「内容含 `sk-` 就拒绝」，但那需要在响应侧再加一套判定，这版没有。所以 `secrets` 包拦的是「agent 把密钥读出来 / 发出去」，不是「密钥漏回来」。

**正则执行超时。** JS 没有。用户写一条 `(a+)+$`，agent 递上 26 个字符就能让网关卡 2.6 秒（实测）。现在的做法是加载期体检 + 告警，**不会硬拦**。真正的解法是把正则丢进 worker 加超时，这版没做。

**域名白名单。** 「生产域名之外一律拒绝」表达不了，DSL 只有逐条 deny/allow。

**不通过 MCP 的子进程。** 如果 agent 自己起子进程、不经过 MCP 工具，这个网关看不到。

## 试试看

```bash
npx -y @leeruu/agentguard init
npx -y @leeruu/agentguard check
```

然后把 `init` 打印的 JSON 片段粘进你的 MCP 配置（Claude Code 的 `.mcp.json`、Cursor 的 `~/.cursor/mcp.json`、Cline 的设置页，结构一样）。

第一次接进去，建议先加 `--observe`：

```bash
npx -y @leeruu/agentguard init --observe --force
```

它只记录不拦截，跑一周，`npx -y @leeruu/agentguard audit list --json` 看你的 agent 到底在干什么。**大概率你会被它吓到**，然后才知道该收紧什么。这才是这个工具真正的使用姿势——先看，再拦。

---

`agentguard` 是 Apache-2.0 开源的，运行时依赖 1 个（`yaml`）。策略包里的每条规则都是可读的 YAML，欢迎改、欢迎骂。

源码：https://github.com/MmUu001/agentguard
npm：https://www.npmjs.com/package/@leeruu/agentguard

如果你被某条规则误伤了，或者你的 agent 干了件我没想到的事，那正是我最想听的反馈——**误伤和漏拦，是这类工具唯一真正的失败方式**。
