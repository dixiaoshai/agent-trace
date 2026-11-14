# 首版验证记录

日期：2026-11-14（Asia/Shanghai）。环境：Node.js v24.15.0、系统 Python 3；全部输入为合成数据。没有读取用户真实历史会话，没有安装 pi/deepseek-harness，也没有调用模型或配置常驻采集。

以下首版记录中的 Agent Stats 和 Agent Knowledge 是当前名称；原执行时项目名分别为 `agent-stat` 和 KnowRelay。新名称下的代码检查和跨项目回归已完成，结果见末节；尚未重新运行真实 Codex 宿主验收。

## 已实际执行

| 范围 | 命令 | 结果 |
|---|---|---|
| Agent Trace | `npm run check` | TypeScript 检查及 7 项测试通过 |
| Agent Stats | `python3 -m unittest discover -s tests` | 80 项通过；包含原有 HTTP 回归，测试仅绑定本机回环地址 |
| Agent Knowledge（当时名为 KnowRelay） | `npm run check` | TypeScript 检查、38 项测试及构建通过；包含真实 stdio MCP 调用 |
| 三项目端到端 | 在 agent-trace 执行 `npm run verify:consumers` | 通过，结束后临时目录已清理 |
| 差异检查 | 在 Agent Stats 执行 `git diff --check` | 通过 |

三项目端到端使用实际 Archive、实际 Python/TypeScript CLI，而非模拟消费函数。导入 11 条事件；删除前 Agent Stats 得到 1 会话、1 轮、140 token、1 工具调用。两个消费方分别使用 3 条和 4 条的分页大小，独立保存游标，并逐页重试验证幂等。元数据/统计库没有合成工具私密正文标记；Agent Knowledge 在原始日志删除后仍能读取完整证据，且该证据不出现在确认知识检索中。消费删除标记后，统计会话归零、证据检索为空。

额外的统计对照使用既有 Agent Stats 合成生成器的 12 会话、193 事件：通过直接日志入口和共享归档入口得到同样的会话、轮次、工具及 token 汇总（12 会话、30 轮、30 工具调用、336000 已知 token）；包括用量缺失的情况。此项由实现代理执行，主代理另外执行上述全套回归与三项目端到端验收。

## 独立审查

未参与实现的 reviewer 检查了采集、原始/元数据投影、消费事务、游标、删除、来源身份和项目范围。发现 Agent Knowledge 未核验删除事件的专用 ID，可能接受复用普通事件身份的错误墓碑。已修复，并增加错误 ID 保留证据、有效删除、不同序号重复删除拒绝以及原页合法重放的回归；reviewer 定向复核通过，无剩余确认缺陷。

## 已知范围

- 批次导出/导入模式；尚无常驻采集、HTTP、调度或自动执行。
- 只实现 Codex，尚未用真实历史日志验证所有客户端版本。
- 每次重读选定文件后去重；增量事件出口已实现，字节偏移 tail 未实现。
- 正文仅在显式 content 捕获时保存，不声称自动发现任意正文中的密钥。
- 只保存来源可见推理摘要及 opaque 原始字段，不恢复隐藏推理。
- 页流不按项目授权过滤；Agent Knowledge 对含越权项目的整页拒绝，窄范围使用独立归档库。
- 删除在各消费方接收到墓碑后生效；旧导出文件、备份另行清理。
- 消费方只能保留来源声明的 record_hash，不能从解析对象独立验证原行字节哈希。
- 经验提取、验证晋升及派生记忆失效传播尚未实现；当前交付是执行证据链。

## 统一命名回归（2026-11-14）

三个目录与包主名称现为 `agent-trace`、`agent-stats`、`agent-knowledge`，规则见[统一命名规范](../../NAMING.md)。实际重新执行：

- Agent Trace：`npm run check`，类型检查、8 项测试及 JavaScript 构建通过。包含旧默认数据库回退、新默认优先和显式 `--db` 覆盖。
- Agent Stats：完整 Python 回归 80 项通过。
- Agent Knowledge：`npm run check`，类型检查、40 项测试及构建通过。包含旧类名别名、配置新名优先/旧名回退、实际 stdio MCP 和验收判定器回归。
- `npm run verify:consumers` 使用新目录完成两消费方独立分页、幂等、证据读取及删除传播，结果通过。
- Agent Trace 实际 `npm pack` 后解包至临时 `node_modules/agent-trace`，执行包声明的 `dist/cli.js help` 成功。未全局安装或发布。
- 两个 skill 的 `quick_validate.py` 通过，20 份当前文档的本地链接通过。

独立审查发现直接把 TypeScript 源文件作为 npm bin 会在依赖安装目录下被 Node 拒绝；已改为构建的 JavaScript bin，并通过上述打包布局验证和审查复核。兼容旧 MCP 轨迹的固定拒答校验亦经定向复核，额外字段、额外回答和工具调用仍会被拒绝。未读取用户真实历史或修改全局宿主配置。

## P0 配置与接口契约（2026-11-14）

实际执行：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Agent Trace | `npm run check` | 类型检查、20 项测试和 JavaScript 构建通过 |
| 示例配置 | `node src/cli.ts config-check --config agent-trace.service.example.json` | 通过；数据库未创建，采集与 API 均为关闭 |
| 文档链接 | 本地 Markdown 相对链接检查 | 新增/修改文档的本地链接通过 |

新增测试覆盖：

- 服务配置严格对象/字段/类型校验，未知键、非回环监听、重复客户端/来源、非法 token 摘要和视图均以 `INVALID_CONFIG` 拒绝。
- 数据库、来源 `root` 和 `cwd_allowlist` 相对配置文件目录解析；省略数据库时新默认库优先、旧 `.agent-archive` 回退；显式 `--db` 覆盖。
- `cwd` 路径段边界、嵌套最长匹配、缺失/相对路径拒绝和同深度歧义。
- token 的 SHA-256 摘要、`Bearer` 认证、Host/Origin、客户端视图授权和重复 header 拒绝。
- `/v1/events` 参数默认值、规范整数、重复/未知/空参数、1000 事件上限和 4096 字符上限。
- 错误映射、`/v1/status` 信封（归档身份、高水位、采集健康）以及不泄露 token/正文。
- `config-check` 不创建数据库、不回显 token 摘要，示例配置保持可加载且默认关闭采集与 API。

P0 当时明确未验证（P1 已补齐，见下节）：没有实现或启动 `serve`、HTTP 监听、扫描调度、运行锁/心跳、真实网络请求或消费方 `follow` worker；没有读取真实 Codex 历史，没有启用采集或修改全局配置。P0 契约尚未经过未参与实现的 reviewer 独立审查。

## P1 Trace 常驻采集与 API（2026-11-14）

实际执行：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Agent Trace | `npm run check` | 类型检查、32 项测试和 JavaScript 构建通过 |
| 构建入口 | `node dist/cli.js help` | 成功列出 `serve --config PATH [--db PATH]` |
| 跨项目批次回归 | `npm run verify:consumers` | 通过；使用临时库与合成日志，仍验证独立分页、幂等、正文隔离和删除传播 |
| 示例配置 | `node src/cli.ts config-check --config agent-trace.service.example.json` | 通过；仍不建库、不扫描、不监听 |

新增测试覆盖：

- `backfill=none` 首次只记录基线，追加后整文件重读并导入；`backfill=all` 首次导入。
- 归档前按 `session_meta.cwd` 匹配项目；未匹配文件跳过并计数，配置修正后同一来源重新尝试。
- 半行等待、完整坏行回滚、同位置内容重写冲突、文件移动/复制去重、超大来源文件报错、删除会话不被扫描复活。
- 单个来源不可用或文件出错时，其他来源继续扫描；状态记录来源错误并进入 `degraded`。
- 单归档租约竞争拒绝第二实例、过期接管、续租失败检测和任务不重入。
- `GET /v1/events` 复用 `exportBatch`：分页、视图授权、metadata 无正文、重复 GET 不改变高水位或消费进度；非法游标/参数、Host/Origin、未知路径、非 GET 和 32 MiB 页上限返回明确错误。
- `GET /v1/status` 返回归档身份、高水位、采集状态、心跳、最近扫描和来源健康，不泄露 token/正文。
- API-only 服务不获取采集租约、`scan_interval_seconds=null`，并拒绝扫描；采集与 API 都关闭时拒绝启动。
- CLI `serve` 收到 SIGTERM 后正常退出、输出 `serve.stopped`，并释放租约；结束后可用新连接重新获取租约。
- 服务事件为 NDJSON，只包含身份、状态、计数、错误代码和时间，不含 token、正文或原始对象。

明确未验证：

- 没有读取用户真实 Codex 历史，没有启动真实长期采集或修改全局 Codex 配置。
- 没有运行 Stats `follow`、Knowledge `follow`、MCP 离线同步、看板并发读取或断网/超时/双机矩阵；这些属于 P2/P3。
- 网络测试只使用 `127.0.0.1` 回环和合成日志；没有验证非回环部署、浏览器前端或大规模日志吞吐。
- 5 分钟采集租约用于避免长文件导入期间被误接管，但未做长时间运行和强制崩溃恢复实测。
- P1 尚未由未参与实现的 reviewer 独立审查。

## 正文归档保护（2026-11-14）

实际执行（合成数据，未读取真实会话，未启用真实 content 采集）：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Agent Trace | `npm run check` | 类型检查、57 项测试和 JavaScript 构建通过 |
| 跨项目批次回归 | `npm run verify:consumers` | 通过；临时库与合成日志，metadata 统计隔离、content 证据与删除传播不变 |
| content 示例配置 | `node src/cli.ts config-check --config agent-trace.content.example.json` | 通过；仍不建库、不扫描、不监听 |
| Agent Knowledge | `npm run check`（content_ref 兼容） | 类型检查、42 项测试和构建通过 |
| 跨项目 content 引用 | 合成 70 KB 工具输出 → Trace `ingest`/`export` → Knowledge `archive-import`/`archive-search`/`archive-read`（worktree） | 通过；blob 已脱敏、`content_ref` 可检索并可原样读回引用元数据 |

新增覆盖：

- 常见凭据形态（私钥、Bearer/Authorization、`sk-`、GitHub/AWS/Slack/JWT/Google/GitLab/npm token、URL userinfo、键值/JSON 敏感字段、结构化敏感键）在 `body`、`raw`、`data.title` 中被替换为显式 `[REDACTED:<类别>]`，`source.record_hash` 仍指向原始源行；`serve` 日志事件递归脱敏。
- 超过 `max_inline_bytes` 的字符串写入 `0600` blob 文件（目录 `0700`），内容完整且已脱敏；`body` 与 `raw` 同步替换为带绝对路径、`bytes`、`sha256`、`media_type` 的 `content_ref`；重新读取可逐字节校验哈希与长度，没有截断。
- 重复导入不产生重复事件或新 blob；内容相同的 revision 和解后不会删除仍被引用文件；`delete-session` 清除会话事件、墓碑与 blob。
- metadata 导出仍固定 `body/raw=null`，且不含密钥、blob 路径或正文；content 库模式仍固定，不能由已有 metadata 库切换。
- `content` 配置严格校验（整数范围、未知键、绝对/相对路径、`~` 拒绝），默认值与数据库同目录；示例配置使用独立数据库、三个项目 allowlist、codex/pi 来源和关闭的采集/API。
- Agent Knowledge 接受并校验 `content_ref`（绝对路径、非负字节数、64 位 SHA-256、`text/plain`，且 `body` 与 `raw` 一致），拒绝截断、相对路径和错误哈希；检索、读取与项目范围限制保持。

明确未验证：

- 未在真实 Codex/pi 历史或三个试点项目上启用 content 采集，未统计真实脱敏命中/误报，未评估真实复盘价值；也未安装 LaunchAgent 或修改正式 metadata 库。
- 未实现 blob 自动垃圾回收、加密、独立保留期，也未把外置正文复制到 Knowledge；大输出正文读取仍需访问 blob 并按哈希校验。
- 未运行 Stats/Knowledge `follow` 端到端、断网/超时矩阵或未参与实现的 reviewer 审查。

## follow 真实进程端到端（2026-11-14）

实际执行：`npm run verify:follow`，使用临时目录、回环端口、合成 Codex fixture，启动真实 `agent-trace serve`（API only）、真实 Python Agent Stats `follow` 和真实 TypeScript Agent Knowledge `follow`（未合并分支通过 `AGENT_KNOWLEDGE_DIR` 指向 worktree）。未读取用户真实历史，未改动正式数据库或 LaunchAgent。

结果（脚本输出）：

```json
{"passed":true,"synthetic_only":true,"trace_high_watermark":15,"stats":{"sessions":1,"turns":1,"tokens":140,"tools":1},"knowledge_appended_events":4,"independent_stop_and_resume":true,"terminal_cursor":14}
```

验证内容：

- 初始 11 个事件由两个 worker 分别拉到；`GET` 不改变采集高水位，Stats 得到 1 会话 / 140 token / 1 工具调用，Knowledge 可按项目检索 content 证据。
- 向合成源追加整行并再次 `ingest`：两个独立游标自动前进（Stats 11→12），无需手工搬批次。
- 停止 Stats 后追加：Knowledge 与 Trace 继续工作，Stats 游标冻结且统计 Token 不变；重启 Stats 从冻结游标补取（12→13），Token 仍为 140、工具仍为 1，统计库无工具正文。
- 停止 Knowledge 后追加：Stats 继续到 14；重启 Knowledge 补齐证据，无重复事件 ID。
- 两个消费方都停止后追加：Trace 仍可 ingest 并提供 `/v1/status`（高水位 15）；重启 Knowledge 从离线游标补到 4 条追加事件，检索结果无重复。

明确未覆盖：真实 Codex/pi 长跑、真实网络中断/Trace 重启/租约过期矩阵、跨机部署、目标库重建交互、blob 外置正文读取、未参与实现的 reviewer 审查。

## 正文归档真实试点（2026-11-14）

用户明确要求完成工作区 `TODO.md` “正文归档”最后一项，因此在真实 Codex/pi 历史上做了一次**一次性** content 回补试点。试点不常驻、不装 LaunchAgent、不改正式 metadata 库与 Stats 库，数据落在独立目录，可按“保留、清理与回滚”整段删除。

### 范围与决定

| 项 | 决定 |
| --- | --- |
| 归档库 | `~/.local/share/agent-trace/content-state/trace-content.sqlite`（`capture_mode: content`，archive_id `a3911c1b-bc08-4785-a473-5f4527e71688`） |
| blob 目录 | `~/.local/share/agent-trace/content-state/blobs`（`0700`，文件 `0600`） |
| 项目范围 | `agent-trace`、`agent-stats`、`agent-knowledge`，并包含历史拼写 `agent-stat`/`agent-knpwledge`、旧名 `knowrelay` 与两个 worktree 目录 |
| 父级范围 | 追加 `plugins-workspace` = `.../plugins` 本身。三个项目的会话多数从父目录启动，若不包含它 `agent-trace` 项目回补结果为 0 会话 |
| 回补策略 | `backfill: "all"`，一次回补后停止进程；不改回 `none` 也不常驻 |
| API | 仅回环 `127.0.0.1:18767`，只授权 `agent-knowledge` 的 `content` 视图；未授权 Stats |
| 消费方 | Knowledge `follow` 指向该试点库；Stats metadata 链路不变，不参与本次试点 |
| 配置文件 | `~/.local/share/agent-trace/content-pilot.json`、`content-pilot.token`；`~/.local/share/agent-knowledge/pilot.json`、`pilot.follow.json`，均 `0600` |

### 实际执行

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 配置校验 | `node src/cli.ts config-check --config .../content-pilot.json` | 通过；未建库、未扫描、未监听 |
| 回补 | `node src/cli.ts serve --config .../content-pilot.json`，首个 `collection.scan` 后观察 | `files=189 imported=16969 skipped=10921 pending=0 unmatched_projects=103 errors=0` |
| 规模 | 归档库统计 | 50 会话、17,086 事件（含后续追加）、86 个已导入文件；103 个范围外文件被 `unmatched_projects` 跳过 |
| 项目分布 | `sessions` 表 | `agent-stats` 17（codex 16 + pi 1）、`agent-knowledge` 10（codex）、`plugins-workspace` 23（pi 14 + codex 9）、`agent-trace` 0 |
| 事件类型 | `events.payload.kind` | `source.unknown` 5158、`usage.snapshot` 2759、`tool.returned` 2636、`tool.called` 2630、`message.assistant` 1954、`reasoning.summary` 1116、`message.user` 270、`turn.started` 196、`turn.completed` 188、`turn.context` 122、`session.started` 50、`turn.interrupted` 7 |
| Knowledge 拉取 | `node dist/interfaces/cli.js follow --config .../pilot.follow.json` | 17,086 条事件全部进入证据库，17,086 行 / 17,086 个唯一 `event_id`；游标 17,142（含删除造成的序号空洞） |
| 证据库体积 | `~/.local/share/agent-knowledge/pilot.sqlite.archive-evidence.sqlite` | 128 MB（正文按页复制进证据库，blob 不复制） |
| 检索与读取 | `archive-search --query 敏感数据审计 --project agent-stats`、`archive-search --query redact|deleteSession`、`archive-read --event <id>` | 命中真实对话与工具记录；`archive-read` 返回来源 path/line/record_hash 并接受 `content_ref` 校验 |
| metadata 隔离 | `node src/cli.ts export --view metadata --limit 2 --db <试点库>` | `body/raw` 均为 `null` |
| 重启一致性 | 停止后以同一配置再次 `serve` | archive_id 不变，事件数 = `count(distinct event_id)`，未变化文件全部 `skipped`，无重复事件 |
| 真实断连重试 | 停止 Trace 后保持 Knowledge worker 运行，再以同一配置重启 Trace | worker 记录 `follow.error CONNECTION_ERROR(transient)` 且不退出；Trace 恢复后从已提交游标续传，证据库无重复 `event_id` |
| 优雅停止 | SIGTERM 分别发送给 Trace 与 worker | 均输出 `serve.stopped` / `follow.stopped`，采集租约释放为 0 行 |

### 脱敏命中与误报

657 个事件、2,447 处替换（同一字符串在 `body` 与 `raw` 中各计一次；计数含被采集会话里引用的标记文本，例如本试点自身的讨论，因此略高于真实替换数）。类别分布：`secret` 1,509、`credential` 504、`userinfo` 139、`api_key` 108、`github_token` 37、`aws_key` 15、`private_key` 15、`google_key` 14、`gitlab_token` 14、`npm_token` 14、`slack_token` 12、`jwt` 12、`openai_key` 5、`bearer` 5；另有 `depth` 25 / `depth_limit` 19 是会话文本在讨论这两个标记本身，不是本次替换。

真实命中可核对：

- `gh auth status` 的 `Token:` 行、`Authorization: Bearer/Basic …` 头、URL 内嵌凭据、工具 JSON 参数中的密钥字段均被替换为显式标记；
- 8 个外置 blob 内也含 `[REDACTED:…]`，说明外置前已脱敏；
- 对 8 类高信号形态（`sk-`、`ghp_`、`AKIA`、`xox*`、`eyJ` JWT、长 `Bearer`、私钥块、URL 凭据）做库内全量扫描，0 命中；URL 规则的少量命中经人工核对为 JSON 结构串误匹配与替换后标记本身。

过匹配（误报）已确认：

- `\b(?:Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._~+/-]{8,}` 会命中普通散文：`basic instructions`、`Basic authentication`、`digest algorithm` 等被替换成 `[REDACTED:credential]`；504 处 `credential` 标记中约 418 处没有认证上下文。
- 键值文本规则会命中代码与散文：`"js-tokens": "^7.29.7"`、`80% fewer tokens: …`、`TOKEN=<占位符>`、`Authorization: $OPENAI_API_KEY` 中的变量引用。
- 影响是可读性与复盘质量下降（内容被替换而非泄漏）；捕获代码本身和测试文本也会被替换，属预期。

### 外置文件与孤儿 blob

- 51 个 `content_ref`、32 个唯一文件、7,153,689 字节；路径在 blob 目录内、长度与 SHA-256 全部校验通过，权限 `0600`（目录 `0700`），没有截断。
- 磁盘实际 107 个文件，其中 75 个（70%）没有被任何已提交事件引用，全部产生于首次回补（20:04 批次）。这些文件不含比已提交内容更多的信息，但说明清理逻辑有缺口。
- 根因（读代码确认）：`Archive.importFile` 在按 revision 排名决定是否导入**之前**就写出 blob；当判定为旧 revision（`apply === false`）而早退、或命中 `SESSION_DELETED`/`SOURCE_CONFLICT` 时，刚写入的文件不会被删除。文档所述“替换 revision 会清理 blob”只覆盖“已提交后再被替换/删除”的路径。
- 修复（同一批次实现）：导入器现在记录本次写出的 blob，在处理旧 revision、已删除会话、项目冲突以及存储/SQL 异常时删除这些文件中没有被已提交事件引用的部分；另加 `gc` 命令回收历史遗留。新回归覆盖“旧 revision 被跳过”和“已删除会话拒绝导入”两条路径，`gc` 只删形如 `<event_id>-<sha256>.txt` 的未引用文件。修复后对这 75 个文件执行 `gc`，已全部回收（119 MB 剩余，32 个文件全部可校验）。

### 复盘效果

用真实会话做了一次题目式复盘，链路可用：

- “agent-stats 仓库转 public 前做过什么敏感数据审计？”→ `archive-search --project agent-stats --query 敏感数据审计` 命中对应 assistant 回答，`archive-read` 返回来源文件、行号、`record_hash`，可直接作为证据引用；
- “Trace 的 `redact`/`deleteSession` 是怎么实现的？”→ 命中 `plugins-workspace` 下真实工具调用与返回（读取 `src/content.ts`、`cli.ts` 的输出），能定位到具体命令与结果；
- 跨项目检索按 `project_id` 过滤有效，`content_ref` 事件可读回引用元数据。

限制：`agent-trace` 项目自身 0 会话（其历史会话 cwd 为 `plugins-workspace`），所以“三个项目各自复盘”实际只有两个项目有独立材料；会话标题、`source.unknown` 占比（5,158）偏高，字段解释仍依赖源日志。

### 保留、清理与回滚

- 保留期：试点数据保留 30 天（至 **2026-12-14**）或用户决定结束时删除，二者取先；未实现自动 GC/加密/独立保留期策略。
- 数据位置：`~/.local/share/agent-trace/content-state/`（140 MB：库 + blob）、`~/.local/share/agent-knowledge/pilot.sqlite.archive-evidence.sqlite`（128 MB）、四个 `0600` 配置/令牌文件。
- 清理（先确认无进程）：

```sh
pgrep -f content-pilot.json || true
pgrep -f pilot.follow.json || true
rm -rf ~/.local/share/agent-trace/content-state
rm -f  ~/.local/share/agent-trace/content-pilot.json ~/.local/share/agent-trace/content-pilot.token
rm -f  ~/.local/share/agent-knowledge/pilot.sqlite* ~/.local/share/agent-knowledge/pilot*.json
```

- 回滚：正式 metadata 库（`~/.local/share/agent-trace/trace.sqlite`）、Stats 库与三个 LaunchAgent 全程未改；删除上面两组目录即回到试点前。Knowledge 证据库独立于活跃知识库，删除不影响知识检索与既有游标（试点用的是新库，没有既有游标）。
- 孤儿文件审计（若保留库）：比较 `blobs/` 文件名集合与库内 `content_ref.path` 文件名集合，差集人工确认后删除。

### 操作提示

- `nohup node … & echo $!` 记录的是包装 subshell 的 PID：对 `$!` 发 SIGTERM 只杀 subshell，真实进程继续持租约，直到 TTL（观察到 `COLLECTION_LOCKED` 持续约 5 分钟）。停止试点进程请用 `pgrep -f <config 路径>` 或前台运行。
- 会话文件在试点期间持续追加（当前 pi 会话也被采集），因此事件计数会缓慢增长；记录数字以本节快照为准。

### 明确未验证

- 未把 content 采集做成常驻服务或 LaunchAgent；未评估长期磁盘增长与 blob GC 策略。
- 未在真实会话上验证 `delete-session` 的删除传播（合成测试已覆盖）；未做 Knowledge MCP/skill 在真实宿主中的 content 检索验收。
- 未给 Stats 授权 content 归档（按设计 Stats 只读 metadata），因此“Stats 面对 content 归档仍无正文”只在合成与配置层面验证。
- 未解决脱敏过匹配与孤儿 blob 两个缺陷；未由未参与实现的 reviewer 复审本试点结论。

## 常驻 content 采集（2026-11-14）

把试点库变成常驻服务：不再一次性回补，而是 launchd 托管扫描、脱敏入库，Knowledge `follow` 常驻续读。仍然只有三个项目 + 父级工作区的范围，正式 metadata 库、Stats 库和 Stats 的 LaunchAgent 未改。

### 代码与配置

- `src/store.ts`：导入器记录本次写入的 blob，在旧 revision（`apply === false`）、`SESSION_DELETED`、`SOURCE_CONFLICT`、存储或 SQL 异常时删除这些文件中**没有被任何已提交事件引用**的部分；新增 `pruneOrphanBlobs()`，只把 blob 目录内形如 `<event_id>-<sha256>.txt` 且未被引用的文件当作候选。
- `src/cli.ts`：新增 `gc --config PATH [--db PATH] [--dry-run]`，输出 `{directory,files,referenced,orphans,removed,dry_run}`；metadata 库调用会报 `CAPTURE_MODE`。
- `scripts/install-content-service.ts` + `npm run install:content`：安装 `local.agent-trace-content` 与 `local.agent-knowledge-follow`。顺序为“停止旧任务 → `config-check` → `gc` → 写 plist → bootstrap”，支持 `--dry-run`（令牌显示为 `<redacted>`）与 `--uninstall`。
- 配置：`content-pilot.json`/`pilot.*` 更名为 `~/.local/share/agent-trace/content.json`、`content.token`，以及 `~/.local/share/agent-knowledge/content.json`、`content.follow.json`、`content.sqlite*`；`collection.backfill` 改为 `"none"`（历史已回补），Knowledge follow 的 `idle_seconds` 15 / `max_backoff_seconds` 300。

### 实际执行

| 步骤 | 命令/动作 | 结果 |
| --- | --- | --- |
| 回归 | `npm run check` | 类型检查、59 项测试（+2）与构建通过 |
| 孤儿回收 | `node src/cli.ts gc --config .../content.json --dry-run` → `gc` | 107 个文件、32 引用、75 孤儿；实际删除 75，目录 119 MB、剩 32 个文件 |
| 安装 | `node --experimental-strip-types scripts/install-content-service.ts` | 两个登录项 `state = running`，`KeepAlive`/`RunAtLoad` |
| 首轮扫描 | `~/.local/share/agent-trace/content.log` | `files=190 imported=334 skipped=306 pending=0 unmatched_projects=103 errors=0`；`backfill: "none"` |
| Knowledge 续读 | `~/.local/share/agent-knowledge/follow.log` | 从游标 17,142 续到 17,488，证据库 17,432 行，`last_error_code` 清空 |
| 无损校验 | 逐条比对 `content_ref` | 32 个文件、51 个引用、字节数与 SHA-256 全部通过 |
| 重启 | `launchctl kickstart -k gui/$(id -u)/local.agent-trace-content` | 旧进程输出 `serve.stopped`（SIGTERM），新进程同 archive_id 重新获取租约，`imported=7`，无重复 |
| 重启后收口 | 等待一轮扫描 + follow | 新增 4 条事件被拉取，游标 17,500，证据库 17,444 |
| 常驻期间孤儿 | `gc --dry-run`（服务运行中，只读） | `files=32 referenced=32 orphans=0` |
| 日志 | `content.log` / `content.err` / `follow.log` / `follow.err` | 只有 NDJSON 计数与状态；`content.err`、`follow.err` 为空；日志 `0600` |

### 明确未验证

- 没有做长时间（天级）运行观察，未验证磁盘增长曲线、归档保留与定期 `gc` 的节奏。
- 未做真实 `kill -9` / 断电留下的孤儿回收演练；`gc` 只在已有 75 个真实孤儿上验证过。
- 未修脱敏过匹配（`Basic/Digest/Token` + 普通单词），也未做 reviewer 独立复审。
- Knowledge 侧未安装 MCP/skill 接入，仍只有 `follow` 与 CLI 检索。
