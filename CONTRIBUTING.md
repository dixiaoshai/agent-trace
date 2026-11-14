# 贡献指南

本文说明本仓库的 GitHub 工作流：分支与合并、本地检查、CI 与分支保护、敏感信息检查。运行方式和数据边界见 [README](README.md) 与[文档索引](docs/README.md)。

## 开发流程

推荐用 worktrunk 建独立工作区（`.config/wt.toml` 已配置 `post-start` 复制 `node_modules` 并构建、`pre-merge` 跑 `npm run check`）：

```bash
wt switch --create feat/short-description
# ... 修改代码并在本地跑检查（见下文）...
git push -u origin feat/short-description
gh pr create --base main --fill
# 检查通过后 squash 合并，删除分支
```

不用 worktrunk 时按普通分支流程：

```bash
git switch -c feat/short-description          # 从最新 main 拉分支
# ... 修改并检查 ...
git push -u origin feat/short-description
```

`main` 不允许直接 push，所有改动都通过 Pull Request。合并方式建议 **Squash**，保持线性历史。分支合并后删除远程和本地工作区，避免长期分叉。

> `post-start` 只在分支创建时触发；接管已有分支后，需要在新工作区里手动跑一次 `wt hook post-start`。修改 `package-lock.json` 后手动 `npm ci`，不要复用旧 `node_modules`。

## 本地检查

要求 Node.js **24.15.0+**（内置 TypeScript 与 SQLite 支持），无运行时第三方依赖。

```bash
npm ci
npm run check
```

`npm run check` 由以下步骤组成，也可以单独运行：

| 命令 | 内容 |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | `node --test tests/*.test.ts` |
| `npm run build` | `tsc -p tsconfig.build.json`，产物写入 `dist/` |
| `npm run check` | 以上三项依次执行 |

跨项目消费验证（需要兄弟项目 `agent-stats`、`agent-knowledge` 可用于 Python/Node 执行，只在临时目录生成合成数据）：

```bash
npm run verify:consumers
```

`dist/`、数据库、导出文件和 blob 目录都不提交，均由本地构建或运行产生。

> 测试和 fixtures 使用合成数据。不要让测试指向真实 `~/.codex`、`~/.pi` 或正式归档库，否则会读入真实会话内容。

## CI 流水线

配置文件：`.github/workflows/ci.yml`

**触发条件**

| 事件 | 说明 |
|---|---|
| `pull_request` → `main` | 打开 PR、往 PR 推新 commit |
| `push` → `main` | 合并后的回归检查 |
| `workflow_dispatch` | 在 Actions 页面手动触发 |

**Job 组成**

| Job | 内容 |
|---|---|
| `Node 24.15.0` | `npm ci` → `npm run check`（typecheck + test + build），runner 固定 `ubuntu-24.04` |
| `Sensitive data scan` | `python3 scripts/check_sensitive.py` |
| `CI success` | 汇总以上 Job，**只有这一个**可被设为分支保护的必需检查 |

同一分支的新 push 会取消上一次未完成的运行（`concurrency`），各 Job 有 `timeout-minutes`。

`npm run verify:consumers` 不在 CI 中运行：它需要可执行的兄弟项目 `agent-stats`/`agent-knowledge`，属于人工跨项目验证。

**本地复现**

```bash
npm ci
npm run check
python3 scripts/check_sensitive.py
```

## `main` 分支保护

分支保护当前**仍不可用**：仓库为私有，个人账号未启用 GitHub Pro，GitHub 拒绝提供分支保护。因此 `CI success` 目前是合并前的参考检查，不能强制阻止合并；合并门槛仍是约定：

- 所有改动走 PR，建议 Squash 合并；
- 合并前在最新 `main` 上复跑 `npm run check`，并确认 `CI success` 为绿；
- 跨项目行为变化再跑 `npm run verify:consumers`。

如果仓库转为公开或开通 GitHub Pro，把 `CI success` 设为必需状态检查（strict 同步、管理员不可绕过、禁止 force push/删除分支），与 agent-stats 的规则保持一致。**修改 CI Job 名称时必须同步更新必需状态检查名**，否则 PR 会永远等不到检查结果。

## 敏感信息检查

本仓库会处理真实日志路径、归档数据库和本机 API token，仓库本身只应包含代码、合成 fixtures 和示例配置。

- 入库前脱敏在 [`src/content.ts`](src/content.ts) 实现（私钥、认证头、常见 API token、JWT、URL 凭据、键值/JSON 敏感字段），同样作用于 `serve` 的日志输出；但它是启发式保护，不承诺发现所有散落密钥，详见[正文归档](docs/content-capture.md)。
- 测试里的 token 一律是合成值（如 `synthetic-metadata-token-value`），配置只保存 `token_sha256`，不保存明文。
- `.gitignore` 已覆盖 `node_modules/`、`dist/`、`.agent-trace/`、`.agent-archive/`、`*.sqlite*`、`*.export.json`，不要用 `git add -f` 绕过。

不要提交：真实 Codex/pi 会话日志、正式归档库或导出文件、`content.blob_directory` 下的正文、含真实 token 的服务配置、个人主目录绝对路径、截图。

提交前自查：

```bash
git status
git diff --cached
python3 scripts/check_sensitive.py
```

扫描规则和允许清单都在 `scripts/check_sensitive.py` 中：命中输出只显示前 4 个字符，避免 CI 日志变成泄漏源；`ALLOW` 只用于 `tests/` 里的合成 token 和文档占位符，新增条目必须写明原因。真实凭据和真实主目录路径应当删除，不要加进允许清单。

GitHub 对公开仓库启用 secret scanning push protection；私有仓库没有这道服务端防线，更不能依赖“提交后再删”。**如果误提交了敏感信息**，不要只 `git revert`：

1. 立刻在服务端**轮换/吊销**该凭证；
2. 从工作树移除并提交；
3. 如已推到远端，用 `git filter-repo` 清洗历史后 force push（需要临时关闭分支保护）。

## 修改 workflow 文件

推送 `.github/workflows/*` 需要 token 具备 `workflow` scope。若 `git push` 报：

```
refusing to allow an OAuth App to create or update workflow ... without `workflow` scope
```

二选一：

```bash
gh auth refresh -h github.com -s workflow          # 给当前 token 加权限
git remote set-url origin git@github.com:dixiaoshai/agent-trace.git   # 或改用 SSH
```

## 发布

`package.json` 仍为 `private: true`，暂未配置自动发布流水线。打包检查用 `npm pack`（`prepack` 会自动构建 `dist/`，包内只含 `dist`、README、docs 和示例服务配置）。
