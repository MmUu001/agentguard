# agentguard

MCP 的本地权限网关。夹在 agent 与真实 MCP server 之间，用 YAML 策略决定「这条工具调用该不该放行」。

> 状态：**W8 完成**（代理 + 策略引擎 + 拦截 + 审计 + 策略包 + 加固）。剩下打包分发与首批用户（W9–12）。

## 快速开始

```bash
agentguard init                 # 生成 ~/.agentguard/policy.yaml（交互式选策略包）
agentguard check                # 预览它会拦住什么
# 把 init 打印的 JSON 片段粘进 Claude Code / Cursor / Cline 的 MCP 配置
```

实测冷启动（全新 HOME，含真实 filesystem server 首次成功调用）：**3.3 秒**。

`init` **不会修改你的客户端配置**，只生成策略文件并打印可直接复制的片段。

## 现状

**W1 · 代理**

- stdin/stdout 原样双向转发，四个消息方向全部透传（含 server → client 的 `sampling/createMessage`）
- 不解析 → 不重新序列化：转发走原始 Buffer，逐字节保真
- 无行长度上限（2 MiB 单行实测通过）
- Windows 下 `.cmd` / `.bat` 垫片（`npx`、`pnpm` 等）可按 PATH + PATHEXT 解析启动
- stdout 只走协议流，诊断全部进 stderr

**W2 · 策略引擎**

- YAML → strict schema 校验 → 编译，任何一条写错 = 加载失败（不静默忽略）
- 五种操作符：`glob` / `regex` / `equals` / `in` / `prefix`
- 判定优先级 `deny > ask > allow`，同档取声明在前的第一条
- 未命中走 `defaults.on_no_match`，默认 `deny`（fail-closed）
- `dry_run` 只记录不拦截，审计里仍保留原始判定
- 多策略文件按顺序合并，规则 id 全局唯一
- 判定耗时 P99 **0.02ms**（4 条规则）/ **0.9ms**（1000 条规则未命中）

**W3 · 拦截路径**

- `tools/call` 先判定再转发；`deny` 时用**原 id** 回 `-32001`，upstream 根本收不到这条消息
- 快速路径：不含 `"tools/call"` 的行完全不解析
- `ask` 无审批通道时明确拒绝（不静默放行、不阻塞）
- 上游崩溃：未完成的调用回 `-32603`，client 不会一直等
- 策略加载失败 → 退出码 2 且上游不会被启动；无策略文件 → deny-all + stderr 告警

**W4 · 审计与观察模式**

- 每次 `tools/call` 判定落一行 JSONL：`ts / reqId / tool / args / decision / ruleId / reason / ms / session / agent`
- 按天切分 `~/.agentguard/audit/YYYY-MM-DD.jsonl`，保留 30 天（启动时按文件名清理）
- 参数深度截断（默认 200 字符），大文件内容不会把日志撑爆
- `agent` 取自 `initialize` 的 `clientInfo.name`；`session` 每进程 4 位十六进制
- `dry_run` 与 `ask` 保留 `raw` 字段 —— 观察模式下能看到「本会拦下什么」
- `limits` 真正执行：超限回 `-32004` 并落审计
- 写入 0.007ms/条（异步入队），退出前 flush；目录不可写时告警但不阻断转发

```bash
agentguard audit list --limit 20 --decision deny
agentguard audit stats --since 7d
agentguard audit export --format csv
```

环境变量：`AGENTGUARD_AUDIT_DIR`（审计目录）、`AGENTGUARD_AUDIT=off`（关闭）、`AGENTGUARD_AUDIT_KEEP_DAYS`（保留天数）、`AGENTGUARD_LOG=debug|info|warn|error`

**W5 · 策略包与 init / check**

四套策略包（`packs/`）：

| 包 | 覆盖 | 默认 |
|---|---|---|
| `core` | rm -rf 根目录/系统目录（含 `-r -f` 拆写）、强制推送、破坏性 SQL、下载即执行、写系统目录、磁盘级破坏 | ✅ |
| `secrets` | 读 .env 家族（排除 `.example`）/私钥/云凭据、云元数据端点、密钥外发 | ✅ |
| `git` | reset --hard、clean -fdx、删除远端分支、丢弃工作区改动 | — |
| `net` | 内网地址、支付接口、单窗口调用上限 | — |

- `init` 生成 `~/.agentguard/policy.yaml` + `packs/` 副本，**写盘前会用加载器自校验**生成的文本
- dev profile 附带基线放行（常见读写/命令工具），否则 fail-closed 会让 agent 一接入就瘫痪；`--profile strict` 关闭基线
- `--observe` 生成观察模式；`--packs` 选包；`--force` 才覆盖已有策略
- `check` 打印规则表 + 13 条样例调用的预演结果，让人一眼看懂"它会拦什么"

**W7–8 · 测试与加固**

- 方案第 9 章的 18 条攻击用例统一出口（`npm run check:attacks`），全部跑在 `init` 生成的真实产物上
- 压力：8 MiB 单行、1000 次连续调用（往返 p99 1.19ms）、33 条规则判定 p99 0.07ms
- 编码：CRLF 行尾、行首 UTF-8 BOM、策略文件 BOM+CRLF 全部兼容
- 正则回溯：加载期体检，识别 `(a+)+` 类嵌套量词并在 stderr 告警；四套策略包零告警（有单测守着）
- 冷启动计时：init 193ms + check 161ms + 真实 server 首次成功调用 2.9s，合计 3.3s

## 用法

```bash
agentguard [--policy <file>]... -- <真实 mcp server 命令> [参数...]
```

策略来源（优先级从高到低）：

1. `--policy` 指定的文件（可重复，按顺序合并）
2. `~/.agentguard/policy.yaml`
3. 都没有 → 内置 deny-all + stderr 告警（**不会因为没配置就放行**）

退出码：`0` 正常 / `1` upstream 启动失败 / `2` 用法或策略配置错误。

示例：

```bash
npx -y agentguard --policy ~/.agentguard/policy.yaml \
  -- npx -y @modelcontextprotocol/server-filesystem /projects
```

客户端配置（三家的 JSON 结构完全一样，只是文件位置不同）：

**Claude Code** —— 用户级 `~/.claude.json` 的 `mcpServers`，或项目根 `.mcp.json`

**Cursor** —— `~/.cursor/mcp.json`

**Cline** —— VS Code 设置里 `MCP Servers` → `Edit Config`（写的就是同一个 JSON）

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y", "agentguard",
        "--policy", "C:/Users/me/.agentguard/policy.yaml",
        "--",
        "npx", "-y", "@modelcontextprotocol/server-filesystem", "/projects"
      ]
    }
  }
}
```

三个要点：

1. `--` 之前是 agentguard 的选项，之后是**原来那行 server 命令**，原样搬过来即可。
2. `--policy` 用**绝对路径**。Windows 上 JSON 里写正斜杠（`C:/Users/...`）最省事，写反斜杠要双写。
3. 想给多个 server 都套上，就把每个 server 的 `command`/`args` 各包一层——它们互不影响。

被拦时 agent 侧看到的是明确错误，不是卡住：

```
{"jsonrpc":"2.0","id":7,"error":{"code":-32001,
  "message":"Blocked by policy secrets-read-env: 敏感凭据文件（.env）",
  "data":{"ruleId":"secrets-read-env","reason":"敏感凭据文件（.env）","decision":"deny","dryRun":false}}}
```

## 接入排障

| 现象 | 先查什么 |
|---|---|
| 所有工具调用都被拒 | 没加载到策略，或规则没覆盖这个工具。跑 `agentguard check --policy <你的文件>` 看预演；确认 `--policy` 路径是绝对路径且存在 |
| 客户端显示 server 连不上 | 看客户端日志里 agentguard 的 stderr。策略语法错误会让它 exit 2 并且**不会启动上游** |
| 某个工具莫名被拦 | 它的工具名不在基线放行列表里（`base-allow-*`），或命中了某条 deny。`agentguard audit list --decision deny` 直接看是哪条规则 |
| 想先观察不拦截 | `agentguard init --observe --force`，或把策略里 `dry_run` 改成 `true` |
| Windows 下提示找不到命令 | agentguard 已处理 `.cmd` 垫片；如果仍失败，把上游命令换成显式路径（如 `node C:/path/to/server.js`） |

## 策略 DSL

```yaml
version: 1

defaults:
  on_no_match: deny    # deny | allow | ask（默认 deny）
  dry_run: false       # true = 只记录不拦截

rules:
  - id: block-rm-rf-root          # 全局唯一，会进审计日志
    match:
      tool: bash                  # 裸值 = equals；数组 = in
      args.command:               # args 字段必须写成操作符对象
        regex: 'rm\s+(-[a-zA-Z]+\s+)*-(rf|fr)\s+/'
    decision: deny                # allow | deny | ask
    reason: 递归删除根目录

limits:                           # W2 解析并校验，W4 才执行
  - tool: bash
    max_calls: 200
    window: 1h
```

匹配语义：

| 要素 | 规则 |
|---|---|
| 字段路径 | `tool` 或 `args.<点号路径>`，支持数组下标 `args.files.0.path` |
| 操作符 | `glob` / `regex` / `equals` / `in` / `prefix` |
| 多值 | 同一操作符的多个取值是 OR |
| 多字段 | 同一规则的多字段是 AND |
| 实参数组 | 逐个元素判定，任一命中即命中 |
| 优先级 | `deny > ask > allow`；同档取声明在前的第一条 |
| 大小写 | `glob` / `regex` 不敏感（安全优先），其余精确匹配 |

## 开发

```bash
npm install          # 运行时依赖只有 yaml；devDeps 是 typescript / @types/node
npm run build        # tsc -> dist/

npm run check:w1     # W1 验收：差分比对 + 6 类边界
npm run check:w2     # W2 验收：判定语义 + 20 种非法策略 + 性能
npm run check:w3     # W3 验收：拦截路径 / ask / dry_run / 上游崩溃 / 无策略文件
npm run check:w4     # W4 验收：审计字段 / 截断 / 限流 / 查询导出 / 保留期
npm run check:w5     # W5 验收：四套包 / 误伤检查 / init 产物 / check 预演
npm run check:attacks    # 18 条攻击用例（方案第 9 章）
npm run check:stress     # 8 MiB / 1000 次调用 / CRLF / BOM / 判定延迟
npm run check:lint       # 正则回溯风险
npm run check:coldstart  # 全新 HOME 的 3 分钟冷启动计时
npm run check:real   # 真实 filesystem server：透传比对 + 拦 .env 放行普通文件
npm run check:pkg    # 安装包边界：pack → 干净目录安装 → 实跑
npm run check:all    # 以上全部
```

## 发布

`prepublishOnly` 会先 `npm run build`，所以 dist 一定是当前源码编译出来的。

```bash
npm run check:all      # 11 个 suite / 290 条断言必须全绿
npm publish            # 需要先 npm login
```

包内只含 `dist/` + `packs/` + README + LICENSE（20 个文件，约 40 KB），不含源码、测试与 source map。

## 设计取舍（与方案一致）

| 决策 | 原因 |
|---|---|
| 转发原始字节，不 JSON 往返 | 浮点精度、字段顺序、转义都会变，client 可能比对失败 |
| 自建行分割器，不用 readline | 大 JSON 会被行缓冲截断 |
| 三路 stdio 全部 pipe | 继承 fd 等于把代理短路 |
| Windows 自己拼 cmd 行 | Node 的 `shell: true` 只做空格拼接，带空格的参数会被劈开 |
| 日志只写 stderr | stdout 是协议流，写一个字就污染 |
| `args.*` 必须显式写操作符 | 裸值只能当 equals，用户写 `'**/.env*'` 时想表达的几乎一定是 glob |
| regex / glob 加载期预编译 | 写错的规则必须启动就报，不能等第一次调用 |

## 已知边界（不藏着）

| 边界 | 影响 | 状态 |
|---|---|---|
| **只看请求，不看响应** | 工具返回值里泄漏密钥拦不住（方案第 5 章「内容含 sk- 的输出」需要响应侧规则引擎） | 未做，后续版本 |
| **正则无执行超时** | 用户写 `(a+)+$` 这类模式，恶意输入能把网关卡住（实测 26 字符 → 2.6s）。已做加载期告警，但**不会硬拦** | 告警已上；worker + 超时待做 |
| **ask 没有审批通道** | `ask` 一律按拒绝处理，不会弹交互确认 | 设计如此（代理 stdin 就是协议流，读 y/n 会吃掉 MCP 消息） |
| **没有域名 allowlist** | 「生产域名白名单外」这类规则表达不了，只能逐条 deny | DSL 限制 |
| **审计写失败不阻断转发** | 目录只读/磁盘满时告警后停写，代理继续工作 | 有意的取舍，避免一个坏路径让网关变砖 |
| **限流是固定窗口** | 窗口边界最多放过 2 倍瞬时流量 | 对本产品的诉求（防整夜烧钱）足够 |
