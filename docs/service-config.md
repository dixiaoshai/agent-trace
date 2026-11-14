# 服务配置

状态：P0 配置契约与校验已实现，可用 `config-check` 检查。前台 `serve`、扫描调度和 HTTP 监听尚未实现（P1），因此本文件描述的是已固定的配置格式，不是当前可启动的常驻服务。更新日期：2026-11-14。

目标设计见[常驻采集与主动拉取](continuous-collection.md)，本机读取接口见[本机 API](local-api.md)，消费方约定见[消费方 follow 约定](consumer-follow.md)。

## 命令与副作用

```sh
node src/cli.ts config-check --config agent-trace.service.example.json
node src/cli.ts config-check --config PATH --db OVERRIDE.sqlite
```

`config-check` 只读取并校验配置文件，不创建数据库、不扫描来源、不监听端口、不写访问日志。`--db` 与既有命令一致，显式覆盖配置里的数据库路径。

成功时输出规范化后的配置 JSON（相对路径已按配置文件目录解析）；`token_sha256` 不会回显。失败时退出码为 1，错误代码为 `INVALID_CONFIG`，消息给出字段路径，例如 `config.collection.sources[0].root: ...`。未知字段一律拒绝，避免拼写错误静默扩大采集范围或访问权限。

示例文件：[agent-trace.service.example.json](../agent-trace.service.example.json)。示例默认关闭采集与 API；启用前必须替换占位路径和 token 哈希。`config-check` 通过不代表来源目录已存在或数据库捕获模式匹配，这些在 `serve` 启动时检查。

## 完整格式

```json
{
  "schema_version": 1,
  "database": ".agent-trace/trace.sqlite",
  "capture_mode": "metadata",
  "collection": {
    "enabled": true,
    "scan_interval_seconds": 30,
    "backfill": "none",
    "sources": [
      {
        "instance_id": "workstation-a",
        "root": "/absolute/path/to/selected/codex/sessions",
        "projects": [
          { "project_id": "project-a", "cwd_allowlist": ["/absolute/path/to/project-a"] }
        ]
      }
    ]
  },
  "api": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 8766,
    "clients": [
      { "id": "agent-stats", "views": ["metadata"], "token_sha256": "<64-hex>" },
      { "id": "agent-knowledge", "views": ["content"], "token_sha256": "<64-hex>" }
    ]
  }
}
```

### 顶层字段

| 字段 | 必填 | 默认 | 规则 |
| --- | --- | --- | --- |
| `schema_version` | 是 | — | 当前固定为 `1` |
| `database` | 否 | 配置目录下的 `.agent-trace/trace.sqlite` | 相对路径相对配置文件；显式路径优先，不静默迁移或复制存量数据 |
| `capture_mode` | 否 | `metadata` | `metadata` 或 `content`；数据库建立后模式固定，`serve` 发现不一致会报 `CAPTURE_MODE` |
| `collection` | 是 | — | 采集配置对象 |
| `api` | 是 | — | 本机 API 配置对象 |

### `collection`

| 字段 | 必填 | 默认 | 规则 |
| --- | --- | --- | --- |
| `enabled` | 是 | — | 是否调度扫描；关闭时仍可用 `serve` 暴露已有归档 |
| `scan_interval_seconds` | 否 | `30` | 整数 `1..3600` |
| `backfill` | 否 | `none` | `none`：首次成功扫描只记录现有文件的基线身份，不导入既有文件；之后变化（含追加）触发整文件重读。`all`：首次扫描即导入当前选中的全部文件。两种模式都按整文件重读去重，都不做字节偏移 tail |
| `sources` | 是 | — | 来源数组；`collection.enabled=true` 时不能为空 |

来源对象：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `instance_id` | 是 | 稳定来源实例 ID，写入事件身份；同一 Codex 安装使用同一值 |
| `root` | 是 | 文件或目录，递归接收 `.jsonl`；相对路径相对配置文件；不跟随符号链接；单文件上限 128 MiB，来源文件数上限 10000 |
| `projects` | 是 | 至少一个项目范围；同一来源内 `project_id` 不得重复 |

项目范围对象：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `project_id` | 是 | 写入事件的统一项目 ID |
| `cwd_allowlist` | 是 | 至少一个目录；会话 `metadata.cwd` 必须等于或位于其中之一 |

### `api`

| 字段 | 必填 | 默认 | 规则 |
| --- | --- | --- | --- |
| `enabled` | 是 | — | 是否提供只读 HTTP |
| `host` | 否 | `127.0.0.1` | 只能是 `127.0.0.1`、`::1`、`localhost`；不提供非回环监听 |
| `port` | 否 | `8766` | 整数 `1..65535`；不要与 Stats 看板（默认 8765）冲突 |
| `clients` | 否 | `[]` | 客户端能力列表；`api.enabled=true` 时必须非空，不支持匿名访问 |

客户端对象：

| 字段 | 必填 | 规则 |
| --- | --- | --- |
| `id` | 是 | 稳定客户端 ID，用于状态与排错；全部客户端内唯一 |
| `views` | 是 | `metadata` / `content` 的非空子集，不得重复；Stats 只配 `metadata`，Knowledge 只配 `content` |
| `token_sha256` | 是 | bearer token 的 64 位 SHA-256 十六进制摘要；不得与其他客户端重复 |

生成 token 与摘要（明文只交给对应消费方，Trace 配置只保存摘要）：

```sh
# 例如 Stats 侧保存 AGENT_TRACE_STATS_TOKEN
TOKEN="$(openssl rand -hex 32)"
printf %s "$TOKEN" | shasum -a 256   # macOS；Linux 可用 sha256sum
printf %s "$TOKEN"                    # 写入消费方自己的环境/密钥存储
unset TOKEN
```

配置文件包含来源路径、cwd 和项目名，仍属私有信息；建议 `chmod 600`。Trace 不保存明文 token，也不把 token、正文或原始事件写入访问日志。

## 路径与数据库兼容

- `database`、来源 `root` 和 `cwd_allowlist` 的相对路径都相对**配置文件所在目录**，不是进程当前目录。因此从任意目录启动都得到同一结果。
- 不支持 `~` 展开；配置 `~/...` 会被拒绝，使用绝对路径或相对路径。
- `--db` 覆盖保持既有 CLI 语义：相对路径相对当前工作目录，而不是配置文件。
- 省略 `database` 时沿用既有默认规则：配置目录下 `.agent-trace/trace.sqlite` 优先；仅当它不存在且旧 `.agent-archive/archive.sqlite` 存在时使用旧库。显式 `database` 或 `--db` 始终优先。
- 显式路径不存在时会新建空归档；不会自动回退到旧库，也不会移动、复制或删除存量数据。切换数据库前必须规划消费方游标与重建，不能把同一会话静默交给另一个归档。
- `capture_mode` 只在建库时生效。对已有库请求不同模式会在打开时报 `CAPTURE_MODE`；不要另建库来“切换”同一会话的捕获模式。

## 项目匹配规则

采集器在归档一个会话之前，用 `session_meta` 的 `cwd` 与同一来源的 `projects[].cwd_allowlist` 做词法路径包含匹配：

- `cwd` 必须是非空绝对路径；缺失、相对路径或越界路径不导入，计为 `PROJECT_UNMATCHED`。
- 按路径段比较，`/work/app` 不会匹配 `/work/application`；`..` 会先规范化。
- 多层 allowlist 同时匹配时取最长（最具体）的目录。不同项目在相同深度并列匹配时视为歧义，计为 `PROJECT_AMBIGUOUS`，该会话跳过直到配置修正。
- 不解析符号链接；配置应使用 Codex 在会话元数据中记录的同一路径形式。
- 不要用 `/`、整个 home 或过宽目录作为 allowlist；这会把该来源下所有会话归入同一项目。
- 未知项目只跳过并可观察，不自动归入默认项目。日期目录可能混有多个项目，不能按目录名猜测归属。

`projectForCwd` 已实现上述规则并有回归测试；采集器在 P1 中直接复用。被跳过的文件不写归档，扫描状态只作为优化，归档提交前不会推进检查点。

## 默认值汇总

| 项 | 默认 |
| --- | --- |
| 数据库 | `<配置目录>/.agent-trace/trace.sqlite`（旧库存在时回退 `.agent-archive/archive.sqlite`） |
| 捕获模式 | `metadata` |
| 采集开关 | 由 `collection.enabled` 明确指定 |
| 扫描间隔 | 30 秒 |
| 历史回补 | `none` |
| API 地址 | `127.0.0.1:8766` |
| API 客户端 | 无；启用 API 时必须显式配置 |
| 页大小 | 请求默认 500，最大 1000（见[本机 API](local-api.md)） |

## 当前范围与下一步

已实现：严格配置解析、路径解析与兼容规则、项目/cwd 匹配、token 摘要与视图能力校验、请求与状态契约类型。

未实现：`serve --config` 命令、来源扫描调度、运行锁/心跳、SQLite 与 HTTP 生命周期、`GET /v1/events`、`GET /v1/status`。这些属于 [TODO](../../TODO.md) 的 P1；消费方 `follow` 属于 P2。不要因为配置可校验就假定常驻采集或自动同步已经启用。
