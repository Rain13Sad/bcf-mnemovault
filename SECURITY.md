# 安全与隐私

这个项目的特殊之处：**它的数据库里存的是用户的对话**。所以"安全"在这里不只是"别被 RCE"，
还包括"记忆不该出现在它不该出现的地方"。

## 报告漏洞

请走 GitHub 的私密渠道：仓库页 → **Security** → **Report a vulnerability**
（Security Advisory）。**不要**先开公开 issue——记忆系统的问题一旦公开，受影响的是已经装了它的用户。

报告里请包含：影响范围、复现方式、你判断的严重程度。首次响应通常在 7 天内；
修复会在 CHANGELOG 里记为 `security`，必要时发 GitHub Security Advisory。

## 威胁模型（v0.2 已实现的边界）

| 面 | 现状 | 说明 |
| :--- | :--- | :--- |
| **落盘位置** | `ctx.baseDir/mnemo/vault.db` + `blob/` | 权限跟随宿主进程用户；本项目不做额外加密 |
| **静态加密** | ❌ 未实现 | 依赖磁盘加密（BitLocker / FileVault / LUKS）。这是已知缺口 |
| **跨用户隔离** | ✅ `cell.scope` + `cell.session` | 检索期过滤：`scopeKey` 不匹配且非 `global` 不可见；`kind=0` 情景记忆不跨会话。多用户 ACL 的地基已就位，但**没有**用户身份认证——身份由部署方传入 |
| **出站泄露** | ✅ `blockMemoryInEgress` | 走 egress 守卫，用 Bloom 过滤器拦"记忆原文出现在出站内容里"；Bloom 按 cell 数惰性重建（装载时库是空的，那时建表等于永不生效） |
| **PII 脱敏** | ✅ `piiRedaction` | 写入前对邮箱/手机号/证件号做掩码；规则是正则，不是模型判断 |
| **遥测 / 外联** | ✅ 无 | 除宿主自身的模型调用外，本项目不发起任何网络请求 |
| **命令面权限** | ✅ 条件审批 | 用户明说"记住"免审；`memory_forget` 等破坏性操作走 `ctx.approval` |
| **重建与删除** | ✅ 带确认 | `/mnemo rebuild --from-log --yes` 先报出将被丢弃的 cell 数，再要求 `--yes` |

## 部署方需要自己做的事

1. 打开磁盘加密；把 `dbPath` 放在受控目录，别放共享盘。
2. 多用户部署时，每个请求显式传 `scopeKey: 'user:<id>'`——不传就是 `user:local`，所有用户共享。
3. 定期备份 `vault.db` 与 `blob/`（两者必须同时备份，残差是分开存的）。
4. 不要把 `vault.db` 提交进任何仓库——`.gitignore` 已经拦了 `*.db`，但别指望它兜底。

## 支持范围

项目处于 preview（基线 DSH `0.2.1-rc.3`），只为最新 minor 版本提供修复。
