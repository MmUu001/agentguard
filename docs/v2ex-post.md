# V2EX 发布包（「分享创造」节点）

> 节点：v2ex.com/go/create（分享创造）。
> V2EX 语境：技术水平高、反感营销腔、欣赏「诚实边界」与工程细节。基于掘金文改写：更短、更硬核、删掉全部情绪铺垫。
> 发帖用主账号（leer，有 101 阅读底子），比小号观感好。

## 标题

```
agentguard：给 MCP 工具调用加本地策略闸（一份 YAML，fail-closed，Apache-2.0）
```

## 正文

```markdown
场景不新：agent 执行 `rm -rf ./build` 时路径少写一层、把 `.env` 内容贴进 issue、循环调用付费 API。确认弹窗弹到第三次人就开始无脑点允许，沙箱要换环境，各家的 hook 协议互不通用且很多没有 Windows 支持。

所以我做了 agentguard：一个 stdio 代理，在 MCP 配置里把 server 命令包一层，每次 tools/call 先过一遍 YAML 策略再转发。`--` 之前是代理选项，之后是原来那行命令原样搬——agent 侧完全无感，所有支持 stdio 启动 server 的客户端通用。

设计取舍（认为是卖点的）：

- fail-closed：没匹配到规则即拒绝。写漏规则的结果是这次调用失败，不是放行
- deny > ask > allow 与声明顺序无关，文件末尾补 allow 不会意外放开前面的 deny
- 不用 LLM 判断危险。命中哪条规则、为什么，都在错误码和 JSONL 审计里，可解释可对账
- 只解析含 "tools/call" 的行，其余（含 server→client 的 sampling/createMessage）原字节转发，逐字节与直连比对过
- 不联网、不注册、无 telemetry；审计是本地 JSONL 按天切分 30 天保留，grep 可查

内置 4 套策略包（30 条规则）：core（rm -rf / 系统路径 强推 DROP TABLE）、secrets（.env/私钥/169.254.169.254/密钥外发/bash 读凭据）、git（reset --hard clean -fdx）、net（内网地址 支付接口 限流）。

30 秒自测（不需要任何 AI 客户端，内置假 server 走真实代理链路）：

npx -y @leeruu/agentguard demo

拦不住的（先说清）：

- 只看请求方向，工具返回值里的密钥泄漏管不了
- ask 无审批通道，按拒绝处理（stdin 是协议流，读 y/n 会把 MCP 消息吃掉）
- Windows 目录 junction（mklink /J）和 \\?\ 前缀能绕过词法路径匹配——dev.to 上有人指出的，修复（写路径 realpath 归一化）已排进 0.2.2
- 正则只有加载期回溯告警，无执行超时

最想听的反馈：你的 agent 干过什么「差点出事」的事，而这个东西没拦住。漏拦比误拦值得说。

GitHub（含中文 README）：https://github.com/MmUu001/agentguard
npm：@leeruu/agentguard（Node >= 20，运行时依赖只有 yaml）
```

---

## 发帖与运营要点

- **节点**：分享创造（create）。勿发到「程序员」等大节点——分享创造的自我推广容忍度最高，且要求真实项目 + 可访问链接（都满足）
- **诚实边界段保留**：V2EX 对「全都能拦」式文案的抵触极强，「拦不住的」段是信任来源，别删
- **V2EX 特色风险预答**：
  - 「这和 Dify/各家平台的权限开关有什么区别」→ 答：平台开关绑定单一平台且多为 ask 语义；本工具一份策略覆盖所有 stdio 客户端，且 deny 与顺序无关、可审计
  - 「27 条/30 条规则够干什么的」→ 答：规则是能自己写的 YAML（5 种操作符、args 点号路径匹配），内置包只是起点；重要的是语义（fail-closed、优先级、审计 policyHash）
  - 「Windows junction 绕过」→ 已被 dev.to 读者指出，承认 + 修复排期，别回避
- **48h 内回帖**；有人提真实场景就邀请开 GitHub issue
- 发完把帖子链接发我登记（G1 曝光指标之一）
