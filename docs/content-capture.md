# 正文归档（content 捕获）

状态：2026-11-14 实现脱敏、外置大输出、独立 content 库配置与消费方引用兼容，并完成**一次性真实试点**（三个项目 + 父级工作区，50 会话 / 17,086 事件，Knowledge `follow` 全量拉取与检索核对）；2026-11-14 起以两个 launchd 登录项常驻（见[常驻运行](#常驻运行macos-launchd)）。试点数字、脱敏命中/误报、孤儿 blob 缺陷、保留与回滚见[验证记录的真实试点一节](validation.md#正文归档真实试点2026-11-14)。目标与范围见工作区 [TODO](../../TODO.md) 的“正文归档”一节，协议细节见 [v1 协议](protocol.md)，服务配置见[服务配置](service-config.md)。

正文归档用于执行复盘、证据检索与后续经验提炼。它只属于 Trace 的 content 捕获模式，默认的 metadata 模式不受影响，也不会因为升级代码自动补回历史正文。

## 边界

- 只有显式选择 `capture_mode: "content"` 并新建数据库时才保存正文。已有 metadata 库保持 metadata；打开时请求不同模式会报 `CAPTURE_MODE`，不能用修改配置的方式补回历史正文。
- 正文库必须独立于正式 metadata 库（不同数据库、不同归档身份、不同 blob 目录）。两个消费方按 `archive_id` 分别维护游标，不能把同一个会话在两个归档间静默覆盖。
- 保存的是源日志中可见的内容：提示、回答、工具参数/结果、可见推理摘要与计划。不恢复隐藏/加密推理，不把摘要当执行事实，不把工具返回当任务成功。
- 脱敏是启发式保护，不是“已证明无密钥”。选择来源时仍需假设库、blob 目录和导出文件都是私密数据。

## 捕获内容

| 事件 | content 模式下保存 |
| --- | --- |
| `session.started` | 会话 `cwd`、标题与来源身份（仍在 metadata） |
| `message.user` | 用户请求、补充要求与纠正的完整文本 |
| `message.assistant` | 每条可见回答，包括中间进展 |
| `turn.completed` | Codex `task_complete.last_agent_message`（有则保存）；pi 的最终回答由终止前的 `message.assistant` 保留 |
| `reasoning.summary` | 源日志已有的可见推理摘要 |
| `tool.called` | 工具名、调用 ID 与参数（含计划类工具调用的结构化参数） |
| `tool.returned` | 返回结果原文、退出码/错误信息（若在源记录中） |
| `context.compacted` | 压缩摘要 |
| `source.unknown` | 原始记录在 `raw` 中，便于以后解释未知类型 |

## 脱敏

入库前对 `body`、`raw` 的每个字符串以及 `data.title` 执行确定性替换，命中内容变为显式的 `[REDACTED:<类别>]`，不做静默删除。结构化字段名命中敏感键（如 `password`、`access_token`、`client_secret`、`*_token`）时整个值被替换。

| 类别 | 示例形态 |
| --- | --- |
| 私钥 | `-----BEGIN ... PRIVATE KEY-----` 块 |
| 认证头/方案 | `Authorization: Bearer ...`、裸 `Bearer ...` |
| 常见 API 密钥 | `sk-...`、`ghp_...`/`github_pat_...`、`AKIA...`、`xox[baprs]-...`、`AIza...`、`glpat-...`、`npm_...` |
| JWT | `eyJ...` 三段式 |
| URL 用户信息 | `https://user:password@host` |
| 键值/JSON 字段 | `password=...`、`"token": "..."`、`api_key: ...` |
| 结构化敏感键 | `{"password": "..."}`、`{"GITHUB_TOKEN": "..."}` |

限制：

- 规则只覆盖常见形态。自由散文、代码片段、私有格式和拆分拼接的密钥仍可能漏检。
- 脱敏后 `source.record_hash` 仍是**原始源行**的哈希，不是脱敏副本的哈希；这是来源声明，不是“副本可复原原字节”的保证。
- `raw` 是脱敏后的原始解析对象。依赖逐字节原文的用途请回到源文件；协议仍只承诺解析对象与来源哈希。
- 运行日志（`serve` 的 NDJSON 事件与错误消息）在输出前再次做同样的字符串脱敏；日志不应包含正文，但错误消息可能引用路径或片段。

## 大输出外置

字符串超过 `content.max_inline_bytes`（默认 65536 字节）时，不截断，而是：

1. 先把脱敏后的完整字符串写入 `content.blob_directory` 下的文件；
2. 用 `content_ref` 对象替换该字符串，`body` 与 `raw` 同步替换，保持两者一致；
3. 文件按内容寻址：`<event_id>-<sha256>.txt`，权限 `0600`，目录 `0700`；
4. 引用结构：

```json
{
  "content_ref": {
    "path": "/private/agent-trace/content-blobs/<event-id>-<sha256>.txt",
    "bytes": 4133,
    "sha256": "<64-hex>",
    "media_type": "text/plain"
  }
}
```

可核验性：读取者应检查文件路径在预期目录内、字节数等于 `bytes`、SHA-256 等于 `sha256`。文件名带事件 ID，因此不同会话不共享文件；删除会话（或替换旧 revision）时会一并清理该会话引用的 blob。事务开始前写入 blob，若归档事务回滚，可能留下未被引用的孤立文件；它们不含比已捕获内容更多的信息，可按目录审计后人工清理。

`content_ref` 是保留键。消费方遇到带该键的对象必须按引用校验，不能当作普通正文；不认识的引用形态应拒绝整页而不是跳过。

## 消费方

- **Agent Stats**：仍只拉 `metadata`，导出与 API 固定把 `body/raw` 置空；即便归档是 content 模式，统计库也不会得到正文、脱敏标记或 blob 路径。
- **Agent Knowledge**：拉 `content`。除原有 owner/project 范围、来源引用和原文读取外，现在接受 `content_ref`：校验路径为绝对路径、`bytes` 非负整数、`sha256` 为 64 位十六进制、`media_type` 为 `text/plain`，并要求 `body` 与 `raw` 的引用一致。检索文本仍来自 `body`，因此大输出按引用路径可检索，正文需按引用读取文件并校验哈希。知识库不复制 blob，也不读取任意路径。
- 两个消费方都必须以 `archive_id` 区分内容库与正式元数据库；不能混用游标。删除墓碑仍会清除证据投影与统计会话，Trace 侧同时删除 blob。

## 试点配置

以 `agent-trace`、`agent-stats`、`agent-knowledge` 三个项目为范围、使用独立库与独立 blob 目录的示例见 [agent-trace.content.example.json](../agent-trace.content.example.json)。要点：

- `database` 使用与正式库不同的文件（例如 `content-state/trace-content.sqlite`）。
- `content.blob_directory` 指向同一个私密目录，不与源日志、代码仓库同目录。
- 每个来源的 `projects[].cwd_allowlist` 明确列出三个项目目录，不写整个 home 或 `/`。
- 首次回补用 `backfill: "all"`，之后改回 `"none"`；回补前确认磁盘、隐私与保留期。
- API 客户端沿用 `token_sha256`；Knowledge 只授权 `content`，Stats 只授权 `metadata`（若需要同时读两个归档，使用不同配置与游标）。

启动前只做校验，不建库、不扫描：

```sh
node src/cli.ts config-check --config /absolute/path/agent-trace.content.example.json
```

确认后前台启动：

```sh
node src/cli.ts serve --config /absolute/path/agent-trace.content.example.json
```

## 试点验收与回滚

合成样本至少验证：

- 用户请求、纠正、最终回答、计划参数、推理摘要、工具参数/返回均能在 content 视图读到；
- 敏感样本（常见 token、`password=`、JSON 敏感字段、URL 凭据、私钥）在 `body`、`raw`、blob 和 `serve` 日志中都被替换；
- 超过阈值的输出以引用保存，文件字节数/哈希可核验，内容不被截断；
- metadata 导出、Stats 统计库不含正文、脱敏标记或 blob 路径；
- 删除会话后事件、墓碑与 blob 的先后关系正确，消费方拉取墓碑后清空投影；
- 重启与重新导入不重复、不改变事件身份，模式不匹配时报 `CAPTURE_MODE`。

回滚：停止 content 采集进程，保留 metadata 库与两个消费方的既有游标。`content-state/` 下的数据库和 blob 目录是独立副本，按保留策略删除即可；不要把它当作正式库，也不要删除 metadata 库来“清理正文”。真实试点结束后，把实际会话数、脱敏命中、外置文件数量与复盘结论写入 [验证记录](validation.md)。

## 常驻运行（macOS launchd）

2026-11-14 起 content 采集可以常驻：`scripts/install-content-service.ts` 安装两个登录项，不再依赖前台 shell。

| 登录项 | 作用 | 日志 |
| --- | --- | --- |
| `local.agent-trace-content` | `serve --config <content 配置>`：扫描来源、脱敏入库、提供回环 API | `~/.local/share/agent-trace/content.log` / `content.err` |
| `local.agent-knowledge-follow` | Knowledge `follow`：把 content 页续读进证据库 | `~/.local/share/agent-knowledge/follow.log` / `follow.err` |

```sh
npm run install:content -- --dry-run   # 打印 plist 计划，令牌显示为 <redacted>
npm run install:content                # 停止旧任务 -> config-check -> gc -> 启动
npm run install:content -- --uninstall # 停止并移除登录项，保留数据库与日志
```

默认路径：配置 `~/.local/share/agent-trace/content.json`、令牌 `content.token`、Knowledge follow 配置 `~/.local/share/agent-knowledge/content.follow.json`，Knowledge 仓库默认取同级目录 `../agent-knowledge`。可用 `--config`、`--token-file`、`--knowledge-follow`、`--knowledge-dir`、`--no-knowledge` 覆盖。

行为与边界：

- 安装器不会替你开启采集：配置必须已是 `capture_mode: "content"` 且 `collection.enabled = true`；不满足就报错退出。
- 安装顺序固定为“停止旧任务 → `config-check` → `gc` → 写入 plist → bootstrap”。先停再回收，避免删除正在写入的 blob；`gc` 失败则中止安装。
- 两个任务都是 `RunAtLoad` + `KeepAlive` + `ThrottleInterval=30`；崩溃后由 launchd 重启，重启会重新获取采集租约、从已提交游标继续。
- 令牌只写进 plist 的 `EnvironmentVariables`（plist `0600`），不写入日志；`--dry-run` 输出会把非 `PATH` 的环境变量显示为 `<redacted>`。
- 常驻不改变协议：仍是单归档租约、单 worker、按 `archive_id` 独立游标；Stats 继续只读 metadata。
- 首次回补仍是显式动作。已回补过的库把 `collection.backfill` 改回 `"none"`，否则每次启动都会重扫全部历史（去重后事件不重复，但会浪费时间）。

### blob 回收

`gc` 删除配置目录里名字形如 `<event_id>-<sha256>.txt` 且没有任何已提交事件引用的文件。只删除配置的 blob 目录下的这一类文件名，不会碰其他文件。

```sh
node src/cli.ts gc --config ~/.local/share/agent-trace/content.json --dry-run
node src/cli.ts gc --config ~/.local/share/agent-trace/content.json
```

- 正常运行时孤儿文件应保持为 0：导入器现在只在确认会提交该 revision 后才保留 blob，旧 revision、已删除会话、冲突和存储/SQL 异常都会清掉本次写入但没有已提交事件引用的文件。
- 只有进程在写 blob 与提交事务之间被强杀（例如 `kill -9`、崩溃）才会留下孤儿；安装器启动前会回收一次，长期运行建议定期执行 `gc`。
- 归档保留期仍由使用者决定：`gc` 只清未被引用的文件，不按时间删除事件或 blob。要结束试点请按[验证记录](validation.md#正文归档真实试点2026-11-14)的清理命令整体删除。

## 尚未覆盖

- 脱敏仍有过匹配待修：`Basic/Digest/Token` 后跟普通单词会误伤散文（`basic instructions`）。这是可读性问题，不是泄漏；修正规则需要同时评估漏检。
- blob 不再由旧 revision/异常路径产生孤儿，`gc` 可回收强杀留下的文件；但未实现按时间删除事件、blob 加密或独立保留期策略。
- 未把外置正文内容复制进 Knowledge 数据库；大输出的检索命中基于引用元数据，正文读取需要访问对应 blob 并校验哈希。
- 未做按项目过滤的 content 流；窄范围仍需独立归档。
