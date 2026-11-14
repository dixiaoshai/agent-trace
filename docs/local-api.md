# 本机只读事件 API

状态：接口契约已在 P0 固定，`GET /v1/events` 与 `GET /v1/status` 的服务端尚未实现（P1）。当前手动 `export` 批次继续有效且语义不变。更新日期：2026-11-14。

配置与授权来源见[服务配置](service-config.md)。事件信封、游标和删除规则以 [v1 协议](protocol.md) 为准；本文只固定传输层。

## 监听与访问策略

- 只监听配置中的回环地址：`127.0.0.1`、`::1` 或 `localhost`，端口默认 `8766`。拒绝非回环 bind。
- 不因绑定回环就允许匿名访问。每个请求都必须带 `Authorization: Bearer <token>`；token 摘要和允许视图在配置文件 `api.clients` 中声明。
- Stats 客户端只授权 `metadata`，Knowledge 客户端只授权 `content`。`/v1/status` 对任何已认证客户端可读，且不包含正文或原始对象。
- `Host` 必须是回环 host 加配置端口（`127.0.0.1:8766`、`localhost:8766` 或 `[::1]:8766`）。缺失或非回环 `Host` 返回 `INVALID_HOST`，用于降低 DNS rebinding 风险。
- `Origin` 允许缺省（curl、CLI、worker）；若出现，只能是同一端口的回环 `http://` 源。`Origin: null` 或其它站点返回 `INVALID_ORIGIN`，避免浏览器跨站读取归档。
- 访问日志不得记录 token、请求正文、事件正文或原始对象。Trace 不写消费进度，也不需要消费方确认。

## `GET /v1/events`

```http
GET /v1/events?after=120&limit=500&view=metadata HTTP/1.1
Host: 127.0.0.1:8766
Authorization: Bearer <token>
Accept: application/json
```

参数：

| 参数 | 必填 | 默认 | 规则 |
| --- | --- | --- | --- |
| `after` | 否 | `0` | 非负安全整数，规范写法为 `0` 或无前导零的十进制；缺省从 0 开始 |
| `limit` | 否 | `500` | 整数 `1..1000`；不接受前导零、空值、重复参数 |
| `view` | 否 | `metadata` | `metadata` 或 `content`；必须在该客户端授权视图内 |

不接受其它参数（包括 `project_id`）。未知、重复、空值或越界参数返回明确错误，不静默取默认值。查询串超过 4096 字符返回 414。

响应体就是现有 v1 `Batch`，不增加字段：

```json
{
  "schema_version": 1,
  "archive_id": "persistent-uuid",
  "view": "metadata",
  "after_cursor": 120,
  "next_cursor": 620,
  "has_more": true,
  "events": []
}
```

- 服务端唯一批次生成逻辑是现有 `Archive.exportBatch`；HTTP 与 CLI `export` 的事件顺序、事件身份、视图投影和游标语义一致。
- `metadata` 响应始终 `body=null`、`raw=null`；`content` 只返回建库时已捕获的内容，未捕获仍为 `null`。
- `GET` 幂等，不推进服务端或消费方进度。相同范围可重试，没有“确认收货”副作用。
- `has_more=true` 时消费方立即用 `next_cursor` 续取；追平后按自身空闲间隔轮询。
- 空页可因删除标记或已有事件被删而跨过序号；`archive_seq` 允许空洞。
- 单页最多 1000 事件，序列化后上限 32 MiB。若超限，请求以 413 `PAGE_TOO_LARGE` 失败且不返回半页；消费方应减小 `page_size`/`limit` 后重试同一游标。
- 归档内所有项目共用一条序列。客户端必须被授权读取页内全部项目；Knowledge 遇到未授权项目整页拒绝。当前没有按项目过滤的流；窄范围使用独立归档。
- 游标超出归档历史或归档身份变化时返回错误，不返回空页伪装“已追平”。消费方不得自动把游标归零。

## `GET /v1/status`

不接收查询参数。任何已认证客户端可读；响应不含 token、正文、原始对象或配置文件内容。

```json
{
  "schema_version": 1,
  "protocol": {
    "schema_version": 1,
    "default_page_events": 500,
    "max_page_events": 1000,
    "max_page_bytes": 33554432,
    "views": ["metadata", "content"]
  },
  "archive": {
    "archive_id": "persistent-uuid",
    "capture_mode": "metadata",
    "high_watermark": 143
  },
  "collection": {
    "enabled": true,
    "state": "idle",
    "started_at": "2026-11-14T00:00:00.000Z",
    "heartbeat_at": "2026-11-14T00:01:00.000Z",
    "scan_interval_seconds": 30,
    "last_scan_started_at": "2026-11-14T00:00:30.000Z",
    "last_scan_finished_at": "2026-11-14T00:00:31.000Z",
    "last_scan": {
      "files": 12,
      "imported": 3,
      "skipped": 40,
      "pending": 1,
      "unmatched_projects": 1,
      "errors": 0
    },
    "last_error": null,
    "sources": [
      {
        "instance_id": "workstation-a",
        "root": "/selected/codex/sessions",
        "project_ids": ["project-a"],
        "last_scan_at": "2026-11-14T00:00:31.000Z",
        "last_error": null
      }
    ]
  }
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `protocol` | 固定协议版本与页大小/字节上限；不随配置静默变化 |
| `archive.archive_id` | 归档持久身份；消费方必须与游标分开保存并校验 |
| `archive.capture_mode` | 建库时固定的捕获模式，不代表 content 视图一定有正文 |
| `archive.high_watermark` | 已提交的最高归档序号。不是待消费事件数：删除产生空洞，各消费方游标独立 |
| `collection.enabled` | 配置是否要求采集；API-only 服务可为 `false` |
| `collection.state` | `disabled` / `starting` / `idle` / `scanning` / `degraded` / `stopped` |
| `started_at` | 本次服务进程启动时间；静态信息与本次心跳分开 |
| `heartbeat_at` | 采集/服务最近存活时间；过旧表示进程可能停滞 |
| `scan_interval_seconds` | 当前配置的扫描间隔；API-only 时为 `null` |
| `last_scan*` | 最近一次扫描的起止时间与计数 |
| `last_scan.unmatched_projects` | 因 cwd 不匹配或歧义跳过的会话/文件数；未知项目不会被猜测归属 |
| `last_scan.pending` | 因尾部半行等待下次处理的数量 |
| `last_error` / `sources[].last_error` | 最近错误代码、消息和时间；单来源失败不阻止其它来源 |
| `sources[]` | 非秘密的来源身份、根路径、项目 ID 与最近扫描健康状态 |

状态不报告“Stats/Knowledge 已消费到哪里”，Trace 不保存目标列表、投递队列或 ack 状态。离线消费方是否落后只能由消费方自己的游标判断。

## 错误格式

所有错误返回 JSON，且不包含内部堆栈或正文：

```json
{ "error": { "code": "INVALID_CURSOR", "message": "Cursor is beyond archive history" } }
```

| HTTP | `code` | 场景 |
| --- | --- | --- |
| 400 | `INVALID_INPUT` | 未知/重复/空参数、`limit` 越界、非法 `view`、status 带参数 |
| 400 | `INVALID_CURSOR` | `after` 非规范非负安全整数，或超出归档历史 |
| 401 | `UNAUTHORIZED` | 缺少、格式错误或未知 bearer token |
| 403 | `INVALID_HOST` | `Host` 缺失或不是配置端口的回环 host |
| 403 | `INVALID_ORIGIN` | `Origin` 不是同端口回环源 |
| 403 | `FORBIDDEN_VIEW` | 客户端请求未授权视图 |
| 404 | `NOT_FOUND` | 未知路径 |
| 405 | `METHOD_NOT_ALLOWED` | 非 GET 请求 |
| 413 | `PAGE_TOO_LARGE` | 序列化页超过 32 MiB |
| 414 | `QUERY_TOO_LARGE` | 查询串超过 4096 字符 |
| 500 | `INTERNAL` | 服务端/归档内部错误；不泄露事件内容 |

`errorResponse`、`httpStatusFor`、`parseEventsQuery`、`authorizeRequest`、`authorizeView` 和 `buildApiStatus` 已在 [src/api.ts](../src/api.ts) 实现并有回归测试；P1 的 HTTP 服务必须复用这些函数，不能另行定义一套宽松解析。

## 与手动批次的关系

CLI `export --view ... --output FILE` 继续保留，文件仍为同一 v1 批次，权限 `0600`，拒绝覆盖。HTTP 不取代手动导入；消费方可在自己的 `follow` worker 中使用 HTTP 分页，同时保留 `import-archive`/`archive-import` 用于离线或显式重建。切换传输方式不改变 `archive_id`、事件身份、视图或游标含义。

## 尚未实现

- `serve --config PATH`、HTTP 监听、请求路由和访问日志。
- 扫描调度、运行锁、心跳与状态源数据。
- 端到端网络故障、超时和并发验证。

这些未完成项不得在文档或部署中描述为已启用能力；见 [TODO](../../TODO.md) P1/P3。
