# 发布到 GitHub（以及可选的 npm）

这份文件是给维护者看的操作单，不涉及代码。

> 文中所有链接都按 **`Rain13Sad/mnemo-vault`** 写。如果你的用户名或仓库名不同，
> 在仓库根目录跑一次替换即可（把 `Rain13Sad` 与 `mnemo-vault` 换成你的）：
>
> ```bash
> grep -rl "Rain13Sad/mnemo-vault" --include="*.md" --include="*.json" --include="*.yml" . \
>   | xargs sed -i 's#Rain13Sad/mnemo-vault#<你的用户名>/<你的仓库名>#g'
> ```

---

## 1. 首次推送

仓库已经初始化好（`main` 分支，一个提交）。在 GitHub 上**新建一个空仓库**（不要勾选
README / .gitignore / LICENSE，否则要先 pull 再处理冲突），然后：

```bash
git remote add origin git@github.com:Rain13Sad/mnemo-vault.git   # 或 https:// 形式
git push -u origin main
```

`git remote -v` 确认无误后，第一次 push 会带上全部历史。

## 2. 仓库设置（网页上点一遍）

| 位置 | 建议值 |
| :--- | :--- |
| **About → Description** | DeepSeek Harness 的记忆与情感插件包族：稀疏码晶格 · 四路召回 · 双相巩固 · 情感内核 |
| **About → Topics** | `dsh` `deepseek-harness` `cordis` `agent-memory` `sparse-distributed-representations` `affective-computing` `companion-ai` `typescript` |
| **About → Website** | 留空（没有独立站点，README 就是入口） |
| **Settings → General → Default branch** | `main` |
| **Settings → Features** | 开 Issues；Discussions 可选 |
| **Settings → Code security** | 开 Dependabot alerts、Secret scanning、Push protection |
| **Settings → Branches** | 给 `main` 加保护：要求 PR + CI 通过 |
| **Actions → General** | Workflow permissions 选 *Read repository contents*（CI 只读） |

CI 会在 push 与 PR 上跑 Ubuntu + Windows 两套：`npm ci → build → typecheck → test → check → bench:eval`，
最后用 `scripts/ci-assert-bench.mjs` 卡住 Recall@8 ≥ 0.80 / MRR ≥ 0.60 / tokens ≤ 240。
第一次跑绿之前，徽章会显示 *no status*。

## 3. 版本与发布节奏

- 版本号写在根 `package.json` 与 10 个子包里（当前都是 `0.2.0`），升级时**一起改**。
- `CHANGELOG.md` 用 Keep a Changelog 格式；每个发布条目至少写清「新增 / 修复 / 已知问题」。
- 打 tag：`git tag -a v0.2.0 -m "v0.2.0" && git push --tags`，再在 GitHub 上
  Draft a release，把 CHANGELOG 对应段落粘进去。

## 4. 发布到 npm（可选，当前未发布）

包名是 `@bcf/dsh-mnemo-*`，需要 npm 上存在 `@bcf` 这个 scope（组织）。如果拿不到，
先改成你自己的 scope（同样要改 `scripts/scaffold.mjs`、`scripts/patches.mjs` 与各包之间的 import）。

发布前有两个坑：

1. **内部依赖写的是 `"*"`。** npm 不会自动把它改写成具体版本，发布出去的包会依赖"任意版本"。
   发布前把它们改成 `"^0.2.0"`：

   ```bash
   node -e "
   const fs=require('fs'),path=require('path');
   const v=require('./package.json').version;
   for(const d of fs.readdirSync('packages')){
     const p=path.join('packages',d,'package.json'); const j=JSON.parse(fs.readFileSync(p));
     for(const k of ['dependencies','peerDependencies'])
       for(const n of Object.keys(j[k]||{})) if(n.startsWith('@bcf/')) j[k][n]='^'+v;
     fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');
   }"
   ```

2. **`lib/` 是 gitignore 的构建产物。** `files` 字段里包含它，所以发布前必须先 `npm run build`，
   否则发出去的是空包。建议顺序：

   ```bash
   npm run verify                     # 先绿
   npm publish --workspaces --access public   # 依赖顺序由 npm 处理，必要时逐包发
   ```

发布后记得把 README 的「安装」一节从"从源码安装"改成 `npm i @bcf/dsh-mnemo-core`。

## 5. 推送前自检

```bash
git status --porcelain          # 应该只有你这次想提交的改动
git ls-files | grep -E "(^|/)(node_modules|lib)/|\.db$"   # 必须为空
du -sh .git                     # 首次提交后应在几 MB 量级（源码 + 设计文档）
```

如果 `git ls-files` 里出现了 `packages/*/lib/`，说明 `.gitignore` 没生效（`git add -f` 过的文件
不受 ignore 约束，需要 `git rm --cached`）。
