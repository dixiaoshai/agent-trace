# 消费方 follow 约定

状态：P0 已固定命令名、配置键、状态输出和错误分类；两个消费方的 worker 尚未实现（P2）。更新日期：2026-11-14。

本约定适用于 Agent Stats 与 Agent Knowledge 各自独立实现的同步 worker。Trace 只提供[只读事件 API](local-api.md)，不保存消费方列表、投递队列或确认游标，也不调用消费方命令。消费进度只在消费方自己的数据库中维护。

## 进程与命令

| 项目 | 前台命令 | 配置 | 固定视图 |
| --- | --- | --- | --- |
| Agent Trace | `agent-trace serve --config PATH` | [服务配置](service-config.md) | 两种视图均可提供 |
| Agent Stats | `agent-stats follow --config PATH [--db PATH]` | 本文 `agent-stats.follow.json` | `metadata` |
| Agent Knowledge | `agent-knowledge follow --config PATH` | 本文 `agent-knowledge.follow.json` | `content` |

- 三个进程独立前台运行，谁先启动都可以；Trace 不等待消费方，消费方不需要看板或 MCP 客户端保持连接。
- Stats 的 `follow` 与看板 `serve` 可分别启停；Knowledge 的 `follow` 与 `serve`（stdio MCP）可分别启停。关闭 MCP 不得停止拉取，关闭看板不得停止 Stats 拉取。
- `follow` 是独立的 Trace 消费模式。不能在 `follow` 中直读 Codex 日志，也不能把 Stats 现有 `--no-import` 当作完整的 Trace 模式。
- 前台运行，`Ctrl+C`（SIGINT）或 SIGTERM 触发优雅停止：不再取新页，等待当前本地事务结束，释放租约，输出 `follow.stopped` 后退出。不得在事务中途强制退出。
- `--db`（Stats）覆盖 follow 配置中的目标数据库，用于显式试点；不提供隐式数据库切换。Knowledge 的数据库与项目授权来自其引用的知识配置，follow 命令不得另建一套授权。

## 配置文件

两个 follow 配置都是严格 JSON，相对路径相对 follow 配置文件目录，未知键拒绝。明文 token 只从环境变量读取，不写入配置或日志。

### Agent Stats

```json
{
  "schema_version": 1,
  "trace_url": "http://127.0.0.1:8766",
  "token_env": "AGENT_TRACE_STATS_TOKEN",
  "database": "./.agent-stats/stats.sqlite3",
  "page_size": 500,
  "idle_seconds": 15,
  "request_timeout_seconds": 20,
  "max_backoff_seconds": 300
}
```

### Agent Knowledge

```json
{
  "schema_version": 1,
  "trace_url": "http://127.0.0.1:8766",
  "token_env": "AGENT_TRACE_KNOWLEDGE_TOKEN",
  "config": "./agent-knowledge.example.json",
  "page_size": 200,
  "idle_seconds": 15,
  "request_timeout_seconds": 20,
  "max_backoff_seconds": 300
}
```

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `schema_version` | 是 | 固定 `1` |
| `trace_url` | 是 | `http://` 回环地址加端口，不含路径、查询、凭据；必须是 Trace 的 `api.host`/`api.port` |
| `token_env` | 是 | 环境变量名，匹配 `[A-Z][A-Z0-9_]*`；启动时读取明文 token，缺失即失败，不回落匿名 |
| `database` | Stats 必填 | 目标 Stats 库，相对路径相对 follow 配置 |
| `config` | Knowledge 必填 | 既有 Knowledge 配置路径；数据库、`allowed_project_ids` 与 owner 规则沿用该配置 |
| `page_size` | 否 | 整数 `1..1000`；Stats 默认 500，Knowledge 默认 200。取页大小不是消费游标 |
| `idle_seconds` | 否 | 追平后的轮询间隔，整数 `1..3600`，默认 15 |
| `request_timeout_seconds` | 否 | 单次 HTTP 建连+读取上限，整数 `1..120`，默认 20 |
| `max_backoff_seconds` | 否 | 临时错误最大退避，整数 `idle_seconds..3600`，默认 300 |

`view` 不作为配置项：Stats 固定 `metadata`，Knowledge 固定 `content`。同一消费状态不得在视图间切换；需要另一种视图时使用独立目标库和显式重建。Trace 侧 token 的 `views` 必须与固定视图一致，否则启动/首请求即失败。

配置不包含：Trace 数据库路径、Trace 内部表名、待投递目标、ack 端点、自动重置开关。消费方不读写 Trace 数据库。

## 拉取循环

1. 启动时校验配置、读取 token，打开目标库，取得该目标的 worker 租约。
2. 从目标库读取已提交的 `archive_id`、视图和游标；新建目标从游标 0 开始，这是显式的新消费库，不是自动重置。
3. 请求 `GET /v1/events?after=<cursor>&limit=<page_size>&view=<fixed view>`。
4. 校验响应：协议版本、`archive_id`、视图、`after_cursor`、`next_cursor`、事件身份、项目授权和信封完整性。无效页整页拒绝。
5. 复用既有事务导入（Stats `import_batch`、Knowledge `importBatch`），在同一事务内处理事件/墓碑、更新投影和提交新游标。
6. 本地提交成功后，才把新游标视为已消费；`has_more=true` 立即续取，追平后等待 `idle_seconds`。
7. 空页且 `next_cursor` 前移时，同样在本地事务中提交该游标；空页是合法的删除/删除后推进，不算错误。
8. 进程退出后从本地已提交游标恢复。HTTP 失败、响应校验失败或本地事务回滚都不推进游标。

同一游标的成功页可以安全重试。重叠且向前延伸的页、跳页、缺少序列或身份冲突必须拒绝，不能跳过坏页继续前进。

## 同步状态

业务游标保留在各项目现有消费表中，和事件/投影一起事务提交。额外的同步记录与业务游标分开，建议字段：

| 字段 | 用途 |
| --- | --- |
| `follow_id` | 目标+来源的稳定标识，唯一约束用于并发保护 |
| `trace_url` | 最近使用的 Trace 地址 |
| `archive_id` | 已绑定归档身份；与响应不符时暂停 |
| `view` | 固定视图；与绑定不符时暂停 |
| `last_attempt_at` | 最近一次请求时间 |
| `last_success_at` | 最近一次成功提交时间 |
| `last_error_code` / `last_error_class` / `last_error_at` | 最近错误；`class` 为 `transient` 或 `permanent` |
| `lease_owner` / `lease_expires_at` | 同一目标单 worker 的运行租约 |

要求：

- 同一目标数据库、同一 `archive_id`/视图只允许一个有效 worker。第二个实例应拒绝启动并报告 `FOLLOW_LOCKED`，或使用可验证的串行化租约，不能并发写同一游标。
- 租约过期后允许接管；接管必须从数据库已提交游标继续，不能用内存状态覆盖。
- `archive_id` 变化、响应视图不符、游标超出新归档或配置改指向另一 Trace 时，进入暂停/`permanent` 状态并要求显式核对或重建。禁止静默把游标归零。
- 目标库重建是明确操作：删除/移动旧目标并用同一 Trace 从 0 回放。不能把另一个归档的同名会话直接覆盖现有统计/证据归属。
- 删除墓碑在本地事务中清除对应投影；消费到墓碑后，旧页重试或日志刷新都不能复活数据。Trace 不根据消费进度自动清理历史，保留策略单独定义。

## 状态输出

worker 在 stdout 输出逐行 JSON（NDJSON），每行一个事件，全部带 `type` 和 ISO 8601 `at`。不得输出 token、正文、原始对象或完整事件数据。

```json
{"type":"follow.started","at":"2026-11-14T00:00:00.000Z","trace_url":"http://127.0.0.1:8766","view":"metadata","archive_id":null,"cursor":0}
{"type":"follow.page","at":"2026-11-14T00:00:01.000Z","after":0,"next_cursor":500,"events":500,"has_more":true}
{"type":"follow.idle","at":"2026-11-14T00:00:03.000Z","cursor":620,"idle_seconds":15}
{"type":"follow.error","at":"2026-11-14T00:00:04.000Z","class":"transient","code":"TIMEOUT","message":"request timed out","retry_in_seconds":30,"cursor":620}
{"type":"follow.state","at":"2026-11-14T00:00:05.000Z","archive_id":"persistent-uuid","cursor":620,"last_success_at":"2026-11-14T00:00:03.000Z","last_error":null}
{"type":"follow.stopped","at":"2026-11-14T00:00:06.000Z","reason":"signal","cursor":620}
```

- `follow.page` 只在本地事务提交成功后输出；`next_cursor` 是已提交游标，不是导出的 `next_cursor` 预告。
- `follow.state` 在启动、恢复、错误状态变化和停止前输出一次，便于观察，不替代数据库。
- 启动失败或永久错误在 stderr 输出单行 JSON，并保持非零退出码：

```json
{"error":{"code":"ARCHIVE_CHANGED","class":"permanent","message":"Stored archive_id differs from the Trace response"}}
```

退出码：`0` 信号触发的正常停止；`1` 配置/启动/租约失败；`2` 已启动后遇到永久同步错误。临时错误不退出，按退避继续。

## 错误分类

| 类别 | 例子 | 行为 |
| --- | --- | --- |
| `transient` | 连接拒绝/重置、DNS、请求超时、HTTP 408/429/5xx、响应截断、SQLite `busy`/`locked` | 不推进游标；指数退避（从 `idle_seconds` 起，封顶 `max_backoff_seconds`，加适度抖动）后重试 |
| `permanent` | 缺少/错误 token（401）、视图未授权（403）、非法参数/游标（400 `INVALID_INPUT`/`INVALID_CURSOR`）、页过大（413）、协议版本或信封不合法、`archive_id` 变化、项目/owner 未授权、来源冲突、本地不变量失败、配置错误 | 停止该目标，报告明确错误；不自动归零、不跳过页面、不无限快速重试 |
| 本地事务失败 | 约束冲突、回滚、进程在提交前退出 | 游标保持原值；下一轮从已提交游标重取。重复已成功页是幂等重试 |
| 认证/配置变更 | token 轮换、端口变化、视图改动 | 重启 worker 并使用显式配置；不接受运行中静默切换 |

`PAGE_TOO_LARGE` 视为需要人工或配置层修正的永久错误：先减小 `page_size` 并重启，不能自动改写已提交状态。`429` 若带 `Retry-After`，采用该值与上限中的较小者（仍受 `max_backoff_seconds` 约束）。

## 验证边界

P2 实现时必须用临时数据库和合成日志验证：追平与空闲、分页续取、重启恢复、断网/超时退避、双实例拒绝、非法页不推进、`archive_id` 变化暂停、删除墓碑、Stats 不触碰原日志、MCP 离线时 Knowledge 继续拉取、看板/MCP 并发读取。当前尚未实现或验证这些 worker；不要把本文约定当作已启用功能。
