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

明确未验证：没有实现或启动 `serve`、HTTP 监听、扫描调度、运行锁/心跳、真实网络请求或消费方 `follow` worker；没有读取真实 Codex 历史，没有启用采集或修改全局配置。P0 契约尚未经过未参与实现的 reviewer 独立审查。
