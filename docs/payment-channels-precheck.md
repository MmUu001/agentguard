# 收款通道纸面预检（G3 前置扫雷）

> 预检日期：2026-11-24。性质：纸面核查（官方文档 + 多源交叉），**未做 KYC 实测**。
> 结论时效：检索级证据，标注核对时间；进入 G3 实际注册动作前需回源复核。
> 背景：方案 7 章风险表将「收款通道地区限制」列为最高风险；本预检将 G3 原定顺序「Lemon Squeezy → Paddle → Gumroad」改写。

## 结论速览

| 通道 | 大陆个人卖家 | 结论 | 依据 |
|---|---|---|---|
| **Paddle** | ✅ **实证可行** | **首选** | 官方：「works with software businesses anywhere in the world except unsupported countries」——不支持名单全是制裁国，中国大陆不在其中；且有北京海淀个人以 Individual seller, country China 走完注册+KYC+上架全流程的公开实证（GitHub GoldPulse 文档，2026-11 查证） |
| Gumroad | ⚠️ 可注册但提现痛 | 备选 | 120 国可注册，但**银行打款国家名单不含中国大陆**（名单从 Hong Kong 直接到 India）；大陆卖家只能走 PayPal 提现（另收 2%、USD 结算、提现链路长）；官方明确不支持 Payoneer/TransferWise；抽成 10%+$0.50（直销）/30%（Discovery） |
| Lemon Squeezy | ❌ 出局 | — | **官方宣布关停**："no longer accepting new sign-ups and will shut down on March 31, 2027"；官方继任指向 Stripe Managed Payments |
| Stripe Managed Payments | ❌ 出局 | — | Stripe 支持国家列表不含中国大陆，个人/公司均无法直接开户；Managed Payments 沿用 Stripe 主体要求 |
| Pocketsflow / Creem | ⚠️ 观察 | 备胎 | 新兴 MoR，明文支持大陆个人收款到 CN 银行账户（Pocketsflow 2%/笔）；但平台小、2026 年新上、跑路/封号风险未验证——**不作主路径**，双周复核时顺带观察 |

## G3 通道排序（修订版）

```
首选：Paddle（Individual seller, country China——大陆个人路径有公开实证）
备选：Gumroad（PayPal 提现，磨损大但可行）
观察：Pocketsflow / Creem（新兴 MoR，双周复核时看存活与口碑）
出局：Lemon Squeezy（关停）、Stripe Managed Payments（地区不支持）
```

## Paddle 前置要求（G3 启动前须备齐）

1. **产品网站**——Paddle 卖家审核需要产品页（公开实证案例用的是 Vercel 站点）。纯 GitHub repo 大概率不够。届时用 GitHub Pages 挂一个单页（定位 + GIF + 定价 + 条款四件套，1-2 小时工作量）。**这是 G3 的前置任务，P2 结束前做好即可。**
2. KYC 材料：身份证/护照 + 与注册地址一致的地址证明（实证案例：海淀地址 + 100192 邮编）
3. 审核期间支持邮箱用域名邮箱（实证案例提示：避免随机 Gmail 过审）

## 费率备忘（G3 定价时用）

- Paddle：MoR 模式，费率按其当前公开报价（注册时确认，$39 买断单价下磨损约 5%+$0.50 量级——以官方为准）
- Gumroad：直销 10% + $0.50；PayPal 提现再加 2%；Discovery 渠道 30%
- Pocketsflow：2%/笔 + 卡处理费（对 $39 买断约为 $1.3，磨损最小——但平台风险未验证）

## 来源与时效

| 事实 | 来源 | 核对时间 |
|---|---|---|
| LS 关停公告 | docs.lemonsqueezy.com/help/getting-started/supported-countries 顶部横幅 + lemonsqueezy.com/blog/saying-goodbye-to-lemon-squeeezy | 2026-11-24 |
| Paddle 不支持名单（大陆不在列） | paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle | 2026-11-24 |
| 大陆个人 Paddle 全流程实证 | github.com/bistuwangqiyuan/goldpulse/docs/paddle-seller-onboarding.md（Individual seller, country China，海淀地址 KYC） | 2026-11-24 |
| Gumroad 银行打款名单不含大陆 | getpaidatlas.com/provider/gumroad（引 gumroad.com/help/article/13，2026-10-30 核对）+ 中文评测（2026-11-08） | 2026-11-24 |
| Gumroad 不支持 Payoneer/TransferWise | gumroad.com/help/article/223（官方） | 2026-11-24 |
| Pocketsflow 大陆收款 | pocketsflow.com/sell-online-from/china（2026-11-02 自称核对） | 2026-11-24（平台可信度未验证） |

> 本文档随 G3 推进更新；注册实测后在此追加「实测记录」小节。
