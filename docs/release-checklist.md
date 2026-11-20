# 发布清单

> 每次发版照这个顺序做。第 1 步没全绿就不要往下走。

## 0. 前置检查

```bash
npm.cmd whoami                                  # 必须打印出用户名
npm.cmd view @leeruu/agentguard dist-tags       # 已发布过会显示 tag
```

`whoami` 报 `ENEEDAUTH` 就先解决登录：

```bash
npm.cmd login --auth-type=legacy
# 或用 npmjs.com 生成的 granular token（必须勾上 Bypass 2FA）：
# npm.cmd config set //registry.npmjs.org/:_authToken=<token>
```

> **PowerShell 执行策略是 Restricted**，`npm` 会解析到 `npm.ps1` 被拒，一律用 `npm.cmd`。

## 1. 门禁

```bash
npm.cmd run check:all
```

期望 **14 个 suite / 323 条断言**全绿，约 45 秒：

```
w1 20 · w2 60 · w3 24 · w4 31 · w5 76 · attacks 18 · stress 9 · lint 17
coldstart 14 · real-fs 8 · export 9 · epipe 4 · demo 19 · install 14
```

> `prepublishOnly` 会先 `clean` 再 `build`（防止旧编译产物混进包）。但**门禁必须手动跑完**。

## 2. 发布 → 暂存 → 审批

本账号开启了 **staged publishing（暂存发布）**：`npm publish` 不再直接上线，而是先进待审队列，
由维护者用 2FA 批准后才公开。新包首次暂存时，npm 会自动创建一个 `0.0.0-stage` 占位版本占住包名。

```bash
npm.cmd publish --tag beta
```

成功时最后一行是 `+ @leeruu/agentguard@<version>`，**但这不代表已上线**。接着审批：

```bash
npm.cmd stage list                    # 找到 stage-id 与待审的版本
npm.cmd stage approve <stage-id>      # 会要 6 位 2FA 验证码
```

或者走网页：npmjs.com → 账号设置 → **Staged Packages** → 找到该版本 → **Approve** → 输入 2FA。

> 前置条件：暂存发布要求 **npm CLI ≥ 11.15.0**（`npm stage` 命令才有）。
> 若本机 npm 低于此版本，只能用网页审批。
>
> 包名是 scoped 的 `@leeruu/agentguard`：无 scope 的 `agentguard` 被 npm 的相似性策略永久拦住
> （与已存在的 `agent-guard` 太像）。`publishConfig.access = public` 已写进 package.json，
> 所以不需要额外加 `--access=public`。

**实测现象（0.1.0，2026-11-19）**：审批通过后，npm 会把 `latest` 也指向新版本，
即使发布时指定的是 `--tag beta`。也就是说「beta 期不占默认安装路径」这个设想没有成立——
`npx -y @leeruu/agentguard` 与 `npx -y @leeruu/agentguard@beta` 都能装到同一个版本。
对外文档仍统一写 `@beta`（语义上更诚实），转正时再去掉。

## 3. 发布后验证（必做，不能跳）

在**另一个目录**里从 registry 真装一遍，确认不是本地缓存骗人：

```bash
cd $env:TEMP; mkdir agcheck; cd agcheck
npx.cmd -y @leeruu/agentguard@beta --version                        # → 版本号
npx.cmd -y @leeruu/agentguard@beta demo                             # 应打印放行/拦截表
npx.cmd -y @leeruu/agentguard@beta init --yes --dir .\home
npx.cmd -y @leeruu/agentguard@beta check --policy .\home\policy.yaml
```

核对 registry 元数据与包内容：

```bash
npm.cmd view @leeruu/agentguard dist-tags
npm.cmd view @leeruu/agentguard@<version> dist.tarball
```

> ⚠️ 若刚审批完就 `npx` 报「找不到命令 / agentguard 不是内部或外部命令」，多半是**本地
> packument 缓存**里还留着占位版本 `0.0.0-stage`（它没有 bin）。加 `--prefer-online` 或换目录重试即可。

## 4. 打 tag 与提交

```bash
git -c user.name=<name> -c user.email=<email> tag -a v0.1.0 -m "v0.1.0"
git tag -n
```

tag 必须指向**已发布成功**的那个提交。

## 5. 转正（收集完反馈、补完规则之后）

```bash
npm.cmd dist-tag add @leeruu/agentguard@0.1.0 latest   # 若 latest 已经指向它，可跳过
npm.cmd view @leeruu/agentguard dist-tags
```

转正后**同一次提交**里做完这几件事，否则文档与命令会对不上：

- `README.md`、`docs/trial-one-pager.md`、`docs/trial-invite.md`、`docs/launch-article.md`
  里的 `@leeruu/agentguard@beta` 全部去掉 `@beta`
- 各文档开头那句「现在是 beta」的提示删掉
- `src/cli.ts` 的 `PUBLISHED_SPEC` 去掉 `@beta`，重新 build 并跑门禁
- 重新打 tag（改版本号才需要新 tag）

## 6. 发坏了怎么办

npm 的规则（`docs.npmjs.com/policies/unpublish`，已核对）：

| 情况 | 能不能撤 |
|---|---|
| 发布 < 72 小时，且没有别的包依赖它 | 可以 `npm unpublish @leeruu/agentguard@0.1.0` |
| 发布 > 72 小时 | 需同时满足：无依赖 + 周下载 < 300 + 单一维护者 |
| 任何情况 | **版本号永久消耗**，撤了也不能再用 `0.1.0` |
| 撤掉全部版本 | 24 小时内不能再发任何新版本 |
| 只是想警告用户 | `npm deprecate @leeruu/agentguard@0.1.0 "不要用这个版本"` |

**镜像站（npmmirror 等）会有独立副本，"公开过"这件事撤不回来。** 所以发之前先跑门禁。

## 7. 兜底：npm 一直不通怎么办

试用不依赖 npm，发 tarball 即可：

```bash
npm.cmd pack                     # → leeruu-agentguard-0.1.0.tgz（约 50 KB）
```

对方拿到文件后：

```bash
npx --yes <tgz 绝对路径> init --yes
npx --yes <tgz 绝对路径> demo
```

MCP 配置里把 `"-y", "@leeruu/agentguard@beta"` 换成 `"--yes", "<tgz 绝对路径>"` 即可。

## 8. 发版节奏

| 情况 | 版本号 |
|---|---|
| 补规则 / 修 bug | patch（0.1.1） |
| 新增操作符、新增子命令 | minor（0.2.0） |
| 策略语义变更（会让老策略行为不同） | minor 起步，README 里写迁移说明 |
| 破坏性变更（如 DSL 不兼容） | major（1.0.0） |
