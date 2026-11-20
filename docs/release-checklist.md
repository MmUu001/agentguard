# 发布清单

> 每次发版照这个顺序做。前四步没全绿就不要往下走。

## 0. 前置检查

```bash
npm whoami                       # 必须打印出你的用户名
npm view agentguard version      # 已发布过会显示版本；首次应为 404
```

`whoami` 报 `ENEEDAUTH` 就先解决登录：

```bash
npm login --auth-type=legacy
# 或用 npmjs.com 生成的 Automation token：
# npm config set //registry.npmjs.org/:_authToken=<token>
```

## 1. 门禁

```bash
npm run check:all
```

期望 11 个 suite 全绿，合计 **290 条断言**：

```
w1 20 · w2 60 · w3 24 · w4 31 · w5 76
attacks 18 · stress 9 · lint 17 · coldstart 14 · real-fs 8 · install 13
```

> `prepublishOnly` 会自动 `npm run build`，不用手动 build。但**门禁必须手动跑完**。

## 2. 发布（beta）

```bash
npm publish --tag beta
```

成功时最后一行：`+ agentguard@0.1.0`

**为什么是 `--tag beta`**：包会公开可装（`npx -y @leeruu/agentguard@beta`），但 `latest` 这个 tag 空着，
所以 `npx -y @leeruu/agentguard`（不带 tag）仍然是 404 —— 默认安装路径还没交出去。

> 包名是 scoped 的 `@leeruu/agentguard`：无 scope 的 `agentguard` 被 npm 的相似性策略
> 永久拦住（与已存在的 `agent-guard` 太像）。`publishConfig.access = public` 已写进 package.json，
> 所以不需要额外加 `--access=public`。

## 3. 发布后验证（必做，不能跳）

在**另一个目录**里从 registry 真装一遍，确认不是本地缓存骗人：

```bash
cd %TEMP% && mkdir agcheck && cd agcheck
npx -y @leeruu/agentguard@beta --version          # → 0.1.0
npx -y @leeruu/agentguard@beta init --yes --dir .\home
npx -y @leeruu/agentguard@beta check --policy .\home\policy.yaml    # 能打印规则表与预演
```

再确认默认 tag 确实是空的：

```bash
npm view agentguard dist-tags             # 应只有 { beta: '0.1.0' }
npx -y @leeruu/agentguard --version               # 应报 404（这是预期，不是故障）
```

## 4. 打 tag 与提交

```bash
git tag v0.1.0
git log --oneline | head -3
```

## 5. 转正（收集完反馈、补完规则之后）

```bash
npm dist-tag add agentguard@0.1.0 latest
npm view agentguard dist-tags             # 应出现 latest
npx -y @leeruu/agentguard --version               # 现在不报 404 了
```

转正后**同一次提交**里做完这几件事，否则文档与命令会对不上：

- `README.md`、`docs/trial-one-pager.md`、`docs/trial-invite.md`、`docs/launch-article.md`
  里的 `@leeruu/agentguard@beta` 全部去掉 `@beta`
- 各文档开头那句「现在是 beta」的提示删掉
- 重新 `git tag`（转正不改版本号就不用重打）

## 6. 发坏了怎么办

npm 的规则（`docs.npmjs.com/policies/unpublish`，已核对）：

| 情况 | 能不能撤 |
|---|---|
| 发布 < 72 小时，且没有别的包依赖它 | 可以 `npm unpublish agentguard@0.1.0` |
| 发布 > 72 小时 | 需同时满足：无依赖 + 周下载 < 300 + 单一维护者 |
| 任何情况 | **版本号永久消耗**，撤了也不能再用 `0.1.0` |
| 撤掉全部版本 | 24 小时内不能再发任何新版本 |
| 只是想警告用户 | `npm deprecate agentguard@0.1.0 "不要用这个版本"`（可下载但带警告，且从搜索里消失） |

**镜像站（npmmirror 等）会有独立副本，"公开过"这件事撤不回来。** 所以发之前先跑门禁。

## 7. 兜底：npm 一直不通怎么办

试用不依赖 npm，发 tarball 即可（材料里的命令需临时换成 tarball 形态）：

```bash
npm pack                      # → agentguard-0.1.0.tgz（约 40 KB）
```

对方拿到文件后：

```bash
npx --yes <tgz 绝对路径> init --yes
npx --yes <tgz 绝对路径> check
```

MCP 配置里把 `"-y", "@leeruu/agentguard@beta"` 换成 `"--yes", "<tgz 绝对路径>"` 即可。

## 8. 发版节奏

| 情况 | 版本号 |
|---|---|
| 补规则 / 修 bug | patch（0.1.1） |
| 新增操作符、新增子命令 | minor（0.2.0） |
| 策略语义变更（会让老策略行为不同） | minor 起步，README 里写迁移说明 |
| 破坏性变更（如 DSL 不兼容） | major（1.0.0） |
