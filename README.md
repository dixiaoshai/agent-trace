# Agent Trace · 共享执行归档

项目原名 `agent-archive`，现更名为 `agent-trace`。新数据默认写入 `.agent-trace/trace.sqlite`；仅当新默认库不存在、旧库已存在时，才回退到 `.agent-archive/archive.sqlite`。显式 `--db` 优先。隐藏目录只用于运行数据。

为 Agent Stats 和 Agent Knowledge 提供同一份可追溯的执行事件。首版只接入 Codex；pi 与 deepseek-harness 仅预留协议边界，尚无适配器或安装操作。

项目命名与迁移规则见[统一命名说明](../NAMING.md)。

当前闭环：**明确选择 Codex JSONL → 本地归档 → metadata/content 批次导出 → 两个消费方独立续读**。默认不扫描用户历史，不调用模型、不联网、不重新执行日志中的工具。

下一阶段采用 **无 hook 常驻采集 + 消费方主动拉取**：Trace 增加采集循环和只读事件 API，Stats 与 Knowledge 分别在自身项目实现同步任务。Trace 不维护下游清单、投递状态或执行下游命令。这是已确认方案，代码尚未实现，见[设计](docs/continuous-collection.md)与[实施 TODO](../TODO.md)。

## 文档

完整入口见 [文档索引](docs/README.md)。按需要阅读 [架构说明](docs/architecture.md)、[执行流程](docs/workflow.md)、[使用与排错](docs/usage.md)、[v1 数据协议](docs/protocol.md) 和 [验证记录](docs/validation.md)。

## 运行

要求 Node.js **24.15.0+**。源码模式使用 Node 的 TypeScript 支持和内置 SQLite，无运行时第三方依赖；安装命令使用编译后的 JavaScript 入口 `dist/cli.js`，避免 Node 对依赖目录内 TypeScript 的限制。`npm run build` 生成该入口，`npm pack` 前会自动构建。开发验证：

```sh
npm ci
npm run check
```

先运行合成例子：

```sh
npm run cli -- ingest --source fixtures/codex --instance demo-device --project demo --capture content --db .agent-trace/demo.sqlite
npm run cli -- status --db .agent-trace/demo.sqlite
npm run cli -- export --db .agent-trace/demo.sqlite --view metadata --limit 10000 --output .agent-trace/stats-page-1.json
npm run cli -- export --db .agent-trace/demo.sqlite --view content --limit 10000 --output .agent-trace/evidence-page-1.json
```

输出文件使用 `0600` 权限并拒绝覆盖已有文件。每个消费方成功导入后保存并报告自己的 `cursor`；下一次导出用该值作为 `--after`。`has_more=true` 时继续取下一页，即使没有新源文件也要取完。不要把一方的游标用于另一方。相同文件再次导入、移到归档目录或复制后导入都不会重复写入。

本模块不根据目录名猜测身份；`--instance` 标识来源设备/运行环境，`--project` 是统一项目标识。同一会话的项目绑定固定。当前会重新读取所选文件，通过事件身份去重，不是基于字节偏移的 tail 守护进程。源文件必须是完整 LF/CRLF 分行的 Codex JSONL，未结束的尾行等待下次导入；完整坏行或原位置内容变化使该文件整次导入失败。

## 两个消费方

在 `agent-stats` 目录执行：

```sh
python3 -m agent_stats --db .agent-stats/archive-demo.sqlite import-archive --input ../agent-trace/.agent-trace/stats-page-1.json
python3 -m agent_stats --db .agent-stats/archive-demo.sqlite summary
python3 -m agent_stats --db .agent-stats/archive-demo.sqlite serve --no-import
```

Agent Stats 只接受 metadata 视图；保留原有用量算法，不保存工具参数、返回正文或推理正文。归档拥有的会话不会被旧的直接日志刷新覆盖或复活。项目过滤继续使用原 `cwd`，项目显示名称使用归档的 `project_id`。

在 `agent-knowledge` 目录执行（先完成该项目的 `npm ci`）：

```sh
npm run cli -- archive-import --input ../agent-trace/.agent-trace/evidence-page-1.json --config agent-knowledge.example.json
npm run cli -- archive-search --query 幂等键 --project demo --config agent-knowledge.example.json
```

按结果的 `archive_id` 与 `event.event_id` 用 `archive-read --archive ID --event ID` 核对原始证据。MCP 新增只读 `search_archive`、`read_archive_event`。归档证据投影保存在 `<knowledge database>.archive-evidence.sqlite`，与活跃知识记录分开，查询不依赖原日志仍在磁盘。执行中的 agent 声明、工具结果不是已确认经验；模型提取、验证及晋升后续实现。

## 内容与删除

新数据库默认 `metadata` 捕获，仅保存结构字段、最多 80 字符的请求标题与来源定位。这些字段仍可能敏感。需要正文证据时，针对明确选定的来源，在新建数据库时显式使用 `--capture content`。捕获模式建立后不可静默切换。

content 会保存原始解析记录、请求/响应、工具参数和输出、可见推理摘要；不是隐藏推理，也不承诺自动识别散落在正文中的密钥。metadata 导出固定剔除 `body/raw`。原始 `record_hash` 基于源行字节；消费者保留该来源声明，但批次仅携带解析后的原始对象，不能凭其重算原始行哈希。

```sh
npm run cli -- delete-session --runtime codex --instance demo-device --session archive-demo-session --db .agent-trace/demo.sqlite
```

删除会在同一事务内清除该会话的捕获事件，并追加删除标记。两个消费方必须继续消费到该标记才能清除自己的投影；旧页重试不会复活数据。已经导出的 JSON、备份和额外文件副本需单独清理。采集器拒绝静默重新导入已删除会话。详见 [协议与可靠性约定](docs/protocol.md)。

## 验证

两个兄弟项目依赖就绪后执行：

```sh
npm run verify:consumers
```

脚本只在临时目录中使用合成会话，检查独立分页、重复导入、统计数值、正文隔离、源删除后证据读取、证据与确认知识分离、删除传播，结束后清理临时数据。测试与执行记录见 [验证记录](docs/validation.md)。

首版不含常驻采集服务、HTTP 服务、多用户认证、自动经验提取或 Inspector UI 集成。数据协议与消费方独立游标已固定，后续适配器在同一入口接入。

导出流尚无按项目授权过滤。Agent Knowledge 的项目配置须允许导出页内所有项目，否则整批拒绝。授权范围较窄时使用单独归档库；不要手工删掉页内事件并保留全局游标。
