# 发布到 GitHub（以及可选的 npm）

这份文件是给维护者看的操作单，不涉及代码。

> 文中所有链接都按 **`Rain13Sad/bcf-mnemovault`** 写。如果你的用户名或仓库名不同，
> 在仓库根目录跑一次替换即可（把 `Rain13Sad` 与 `bcf-mnemovault` 换成你的）：
>
> ```bash
> grep -rl "Rain13Sad/bcf-mnemovault" --include="*.md" --include="*.json" --include="*.yml" . \
>   | xargs sed -i 's#Rain13Sad/bcf-mnemovault#<你的用户名>/<你的仓库名>#g'
> ```

---

## 1. 首次推送

仓库已经初始化好（`main` 分支，一个提交）。在 GitHub 上**新建一个空仓库**（不要勾选
README / .gitignore / LICENSE，否则要先 pull 再处理冲突），然后：

```bash
git remote add origin git@github.com:Rain13Sad/bcf-mnemovault.git   # 或 https:// 形式
git push -u origin main
```

`git remote -v` 确认无误后，第一次 push 会带上全部历史。

## 2. 仓库设置（网页上点一遍）

README 已经改成英文为主（`README.md`）+ 四份译文（`README.zh-CN.md` / `.ja.md` / `.ko.md` / `.es.md`），
所以 About 里的描述也用英文——GitHub 的 About 只有一处，写中文会让非中文读者看不懂这个仓库是干什么的。

| 位置 | 建议值 |
| :--- | :--- |
| **About → Description** | `Long-term memory & affect for DeepSeek Harness — sparse-code cells, 4-channel recall, ~116 tokens/turn. Zero runtime deps.` |
| **About → Topics** | `dsh` `deepseek-harness` `cordis` `agent-memory` `long-term-memory` `sparse-distributed-representations` `hyperdimensional-computing` `affective-computing` `companion-ai` `typescript` |
| **About → Website** | 留空（没有独立站点，README 就是入口） |
| **Social preview** | 把 `docs/assets/social-preview.svg` 导出成 **1280×640 PNG** 再上传（GitHub 的 Social preview 只收 PNG/JPG） |
| **Settings → General → Default branch** | `main` |
| **Settings → Features** | 开 Issues；Discussions 可选 |
| **Settings → Code security** | 开 Dependabot alerts、Secret scanning、Push protection |
| **Settings → Branches** | 给 `main` 加保护：要求 PR + CI 通过 |
| **Actions → General** | Workflow permissions 选 *Read repository contents*（CI 只读） |

> 仓库主页的「About」和「Topics」只能在网页上改，不能通过 git 推送。改完之后，仓库右侧会多出一排
> 可点击的话题标签——这是别人在 GitHub 上搜到这个项目的唯一入口，值得花两分钟填。

CI 会在 push 与 PR 上跑 Ubuntu + Windows 两套：`npm ci → build → typecheck → test → check → bench:eval`，
最后用 `scripts/ci-assert-bench.mjs` 卡住 Recall@8 ≥ 0.80 / MRR ≥ 0.60 / tokens ≤ 240。
第一次跑绿之前，徽章会显示 *no status*。

## 3. 版本与发布节奏

- 版本号写在根 `package.json` 与 10 个子包里（当前都是 `0.3.1`），升级时**一起改**。
  注意 `0.3.0` 换了存储布局（MC03），发布说明里必须写明旧库需 `/mnemo rebuild --from-log`。

**发布前必跑**：`node scripts/ci-check-publish.mjs`（版本/兄弟依赖/lockfile 三项一致）。
v0.3.0 正是漏了这一步：10 个包升到 0.3.0，8 个 package.json 的兄弟依赖还写 `^0.2.0`，
结果 `npm ci` 失败、`npm install` 后编译报错，整个版本不可安装。
- `CHANGELOG.md` 用 Keep a Changelog 格式；每个发布条目至少写清「新增 / 修复 / 已知问题」。
- 打 tag：`git tag -a v0.3.1 -m "v0.3.1" && git push --tags`，再在 GitHub 上
  Draft a release，把 CHANGELOG 对应段落粘进去。

## 4. 发布到 npm

包名是 `@rain13sad/dsh-mnemo-*`（npm 账号 rain13sad 自带这个 scope，不用建组织）。
`@bcf` 这个 scope 已经被另一个同名用户占用，所以没有用它。

发布前有几个坑，都已经在仓库里处理掉了，记下来免得下次踩：

1. **内部依赖不能写 `"*"`。** npm 不会替你改写成具体版本，发出去的包会依赖"任意版本"。
   现在各包统一写 `^<同版本>`；升版本时根 package.json 与 10 个子包一起改，
   改完必须跑 `node scripts/ci-check-publish.mjs`（版本 / 兄弟依赖 / lockfile 三项一致）。
2. **`lib/` 是 gitignore 的构建产物**，但 `files` 里有它。不 build 就发，发出去的是空包。
3. **npm 包页只认包内的 README**，仓库根那份不会带过去。`npm run readmes` 会按
   `scripts/pkg-readme.mjs` 里的表重新生成 10 份。
4. **authToken 会过期。** v0.4.0 发布时 token 是好的，第二天再发就可能 `E401`。
   这不是网络问题，重试一百次也没用——必须重新 `npm login`。

### 标准流程

```bash
cd "DSH project"

node scripts/ci-check-publish.mjs     # 门禁：版本 / 兄弟依赖 / lockfile / 平台中立
npm run build                          # 必须：lib/ 是 gitignore 的产物
node scripts/publish-all.mjs --dry-run # 预演 10 个包（不需要登录）

npm whoami                             # 应输出 rain13sad；E401 就先 npm login
node scripts/publish-all.mjs           # 按依赖顺序发，逐包提示 2FA 验证码
```

`scripts/publish-all.mjs` **不是** `npm publish --workspaces` 的简写，它做了四件事：

- 按拓扑序发（core → affect/encoder/recall/consolidator/proactive/tools/settings → devkit/ui），
  避免"装 affect 时它依赖的 core 还没发"的空窗；
- **登录态预检**：`npm whoami` 失败直接停，并告诉你去 `npm login`；
- **幂等跳过**：`npm view <pkg>@<version>` 已存在就跳过，中途失败重跑整批是安全的；
- 遇到 `EOTP`/`E429` 立即停止（连续重试会触发 OTP 限流，通常要等 15 分钟）。

### 2FA：两种给码方式

```bash
node scripts/publish-all.mjs              # 交互式：npm 逐个包弹提示（需要真 TTY）
node scripts/publish-all.mjs --otp=123456 # 非交互：一次码发完全部（约 30 秒内有效）
```

> 在 IDE 的内嵌终端里，子进程可能拿不到 TTY，交互式会直接报 `EOTP`。
> 这种情况用 `--otp=`，或者换一个普通终端窗口。

### 常见错误对照

| 错误 | 含义 | 处理 |
| :--- | :--- | :--- |
| `E401 Unauthorized` | token 失效 / 未登录 | `npm login` → `npm whoami` → 重跑 |
| `EOTP` | 需要一次性验证码，或码已过期 | 交互式重跑；或 `--otp=<新码>` |
| `E429` | OTP 试太多次被限流 | 等 15 分钟，别再重试 |
| `E403 cannot publish over` | 该版本已存在 | 正常；脚本会自动跳过，或 `--only=<包>` 跳过它 |
| `EPUBLISHCONFLICT` | 同版本并发发布 | 确认 registry 上的版本，再决定是否升 patch |
| 发出的是空包 | 忘了 `npm run build` | `npm run build` 后 `--republish` |

### 发完核对

```bash
npm view @rain13sad/dsh-mnemo-core version        # 应为当前版本
npm view @rain13sad/dsh-mnemo-core dist-tags      # latest 指向它
npm access list packages                          # 应能看到 10 个包
```

---

## 5. 推送前自检

```bash
git status --porcelain          # 应该只有你这次想提交的改动
git ls-files | grep -E "(^|/)(node_modules|lib)/|\.db$"   # 必须为空
du -sh .git                     # 首次提交后应在几 MB 量级（源码 + 设计文档）
```

如果 `git ls-files` 里出现了 `packages/*/lib/`，说明 `.gitignore` 没生效（`git add -f` 过的文件
不受 ignore 约束，需要 `git rm --cached`）。
