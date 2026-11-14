# Shared agent archive protocol v1

Status: first local implementation. Codex and pi adapters are implemented;
deepseek-harness remains a future adapter. No packages, hooks or runtime
integrations are installed by the agent's own installer; Trace reads the JSONL
files the harness already writes.

## Ownership and transport

The archive owns captured source evidence and normalized events. Agent Stats owns
statistics; Agent Knowledge owns searchable evidence and subsequently derived memories.
Consumers never write the archive's SQLite tables. The first transport is a JSON
batch file exported by CLI, allowing Python and TypeScript consumers to share a
versioned contract without sharing internal database schemas. The next transport
is a read-only local HTTP feed pulled independently by each consumer. Its
endpoint, authentication, view and error contract is fixed in [the local API
document](local-api.md); the server is implemented by `agent-trace serve` in
P1, while the consumer workers are not implemented yet. Trace does not maintain
destination registries, delivery queues or consumer acknowledgment state. See
[the design](continuous-collection.md), [service configuration](service-config.md)
and [implementation TODO](../../TODO.md).

The archive requires explicit source paths, instance ID and project ID. It does
not discover or import the user's history automatically. The database's capture
mode is fixed on creation: `metadata` by default, `content` only when explicitly
selected. Metadata includes bounded prompt titles and paths and is still private.
Content capture includes prompts, answers, visible reasoning summaries, plans and
tool arguments/results. Before storage, common credential shapes and secret-named
JSON fields are replaced with explicit `[REDACTED:<kind>]` markers, and oversized
strings are externalized as verifiable local references (see
[content capture](content-capture.md)). Redaction is heuristic: it cannot reveal
hidden/encrypted reasoning and does not prove that free prose or private formats
are secret-free; select sources accordingly. No outbound network calls or model
calls are made.

## Batch envelope

```json
{
  "schema_version": 1,
  "archive_id": "persistent-uuid",
  "view": "metadata",
  "after_cursor": 0,
  "next_cursor": 12,
  "has_more": false,
  "events": []
}
```

Cursor values are nonnegative safe integers, opaque global archive sequence
positions. Events are ordered by `archive_seq`, not timestamp. A consumer starts
at zero, commits its cursor with its derived writes, and supplies its own cursor
on the next export. An empty page can advance across deleted events. Each view
has the same cursor space. Consumers keep separate state per `archive_id` and
must not switch views within that state without a fresh rebuild. An export's
upper bound is captured for that read; later events are obtained on later reads.
`next_cursor` is the last scanned position (or `after_cursor` for an empty tail).

Consumers reject unsupported versions, forward cursor gaps, invalid envelopes
and conflicting event IDs. A complete previously accepted page may be retried as
a no-op; an overlapping page extending beyond the committed cursor is rejected
and should be re-exported from the current cursor. Consumers must still process
unknown event kinds as stored evidence or skip them without losing cursor progress.

## Event envelope

```json
{
  "schema_version": 1,
  "event_id": "sha256-hex",
  "archive_seq": 1,
  "runtime": "codex",
  "instance_id": "workstation-a",
  "session_id": "native-session-id",
  "session_key": "[\"codex\",\"workstation-a\",\"native-session-id\"]",
  "project_id": "demo",
  "kind": "message.user",
  "occurred_at": "2026-01-01T00:00:00Z",
  "observed_at": "2026-01-01T00:00:01Z",
  "native_type": "event_msg.user_message",
  "source": {"path": "/selected/log.jsonl", "line": 3, "record_hash": "sha256-hex"},
  "data": {"turn_id": "turn-1", "root_turn_id": null, "model": null, "title": "User request"},
  "body": null,
  "raw": null
}
```

`body` and `raw` are ALWAYS null in the metadata view, with an allowlisted `data`
payload. Content view supplies them only if captured; missing content stays null.
In content mode `body` and `raw` are the parsed record **after redaction and
externalization**; `source.record_hash` still identifies the original line bytes
excluding LF (and CR for CRLF), so it asserts provenance and is not a hash of the
redacted copy. `body` is a convenience representation, never the authoritative
complete source record. Consumers use `event_id` to cite evidence.
`occurred_at` is null if missing/invalid; ingestion order remains available.
`runtime` identifies the harness, separate from model provider and model name.

For the Codex v1 adapter, `event_id = SHA256(JSON.stringify([runtime, instance_id,
session_id, one_based_line_number]))`. Copies/moves retain identity. Identical
content on two DIFFERENT lines is NOT deduplicated. Native IDs and parser version
are preserved when available; future adapters may use native IDs instead of
ordinal positions. Event identity must not depend on the normalizer version.
Unknown records remain `source.unknown` with their original native type and raw
payload when captured.

One session identity can be covered by several rollout files, and Codex can
rewrite a rollout in place. The archive keeps one revision per session: the
file with the greatest last event timestamp, then the greatest number of
records. A newer revision replaces the previous one; an equal revision is
reconciled in place (changed records are replaced, identical records keep their
`event_id` and sequence); an older revision is skipped without rollback.
Project changes for an existing session still fail with `SOURCE_CONFLICT`, and
consumers see ordinary events with monotonic cursors either way.

A Codex rollout can contain more than one `session_meta`: resuming a conversation
appends the new identity, and subagent rollouts repeat the parent identity after
their own. The final record is authoritative; the whole file is archived under
that `session_id` and project, and earlier identity markers are not emitted.
This matches the direct-log reader's attribution and keeps tokens with one
session. Session `title` is optional display metadata read from the source's
`session_index.jsonl` / newest readable `state_*.sqlite`; it never changes event
identity, privacy guarantees or cursor semantics.

Two rollouts folded into the same session reuse line numbers while holding
different records, so such files add their own first `session_meta` identity to
the identifier tuple: `[runtime, instance_id, session_id, first_session_id,
line]`, and carry it as the optional `source.series`. Logs with a single
identity keep the published four-element tuple, so existing identifiers never
change. The discriminator is stable inside the file and travels with
copied/moved evidence; identical content at the same position still deduplicates.
Consumers that recompute identifiers MUST include `source.series` when present
and reject an empty or session-equal series.

## Normalized kinds and allowlisted data

All ordinary events include nullable `turn_id`, `root_turn_id`, and `model`.

| Kind | Additional metadata data | Content body |
|---|---|---|
| `session.started` | `cwd`, `parent_session_id`, `forked_from_session_id`, `created_at`, `cli_version`, optional `title` (single line, max 80 characters, read beside the source) | null |
| `turn.context` | no additional fields | null |
| `turn.started` | no additional fields | null |
| `turn.completed` | no additional fields | optional final answer text (Codex `task_complete.last_agent_message`; pi exposes the terminal answer as `message.assistant`) |
| `turn.interrupted` | no additional fields | null |
| `message.user` | `title` (single line, max 80 characters) | `text` |
| `message.assistant` | no additional fields | `text` |
| `reasoning.summary` | `available` boolean | `text` if visible |
| `tool.called` | `call_id`, `name`, `input_bytes` | `arguments` (native structured value or string) |
| `tool.returned` | `call_id`, `output_bytes`, `status: result_observed` | `output` |
| `usage.snapshot` | `cumulative`, `last_usage`, `rate_limit_only`, optional `cost_usd` (nonnegative number) and `cost_source` (`provider` or `model_rates`) | null |
| `context.compacted` | no additional fields | optional summary |
| `source.unknown` | no additional fields | null; original in `raw` |
| `session.deleted` | no additional fields | null |

Content-mode bodies can contain a `content_ref` object in place of a string that
exceeded Trace's inline limit:

```json
{"content_ref": {"path": "/private/blobs/<event>-<sha256>.txt", "bytes": 4133,
                 "sha256": "<64-hex>", "media_type": "text/plain"}}
```

`content_ref` is reserved. The file holds the complete redacted string (no
truncation); readers verify the absolute path is inside the expected directory,
`bytes` and `sha256`, then read UTF-8 text. The same replacement is applied to
both `body` and `raw`. Metadata titles are redacted but bounded to 80 characters.

Usage objects allow ONLY nonnegative integer `input_tokens`, `cached_input_tokens`,
`cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`,
`total_tokens`. Absent fields are unknown, NOT zero. Input may include cached input;
output may include reasoning output; never sum every field. `usage.snapshot`
explicitly denotes cumulative source accounting, not a billable new request.
`cost_usd` is the recorded cost of the same request described by `last_usage`
(not of the cumulative snapshot). `cost_source=provider` means the provider
reported the charge; `model_rates` means the harness computed it from its own
model rate table. Consumers must not present the two as account bills, and an
absent field means unknown, NOT zero. Consumers retain cumulative reset/missing
evidence and fork inheritance warnings.
A tool return is evidence of an observed result, NOT evidence of task success.

Native `event_msg` messages and `response_item.message` can describe the same
message; content consumers must tolerate mirror records and cite their distinct
sources. Statistics consumers should prefer the adapter's bounded titles and
existing source-aware attribution rules instead of counting every representation
as a new user turn. Streaming chunks and settled messages must not be billed twice.

## Pi adapter mapping

Pi sessions are JSONL entries connected by `id`/`parentId`. The adapter
synthesizes a turn id from each user entry id; assistant terminal stop reasons
close the turn. It emits `message.user`, `turn.started`, `message.assistant`,
`usage.snapshot`, `tool.called`, `tool.returned`, `turn.completed`,
`turn.interrupted`, `context.compacted`, `session.started` and
`source.unknown` for everything else.

Usage mapping follows the v1 convention that input includes cached input:

| Pi | v1 |
|---|---|
| `usage.input` + `usage.cacheRead` | `input_tokens` |
| `usage.cacheRead` | `cached_input_tokens` |
| `usage.cacheWrite` | `cache_write_input_tokens` |
| `usage.output` | `output_tokens` |
| `usage.reasoning` | `reasoning_output_tokens` (already inside output; never added again) |
| `usage.totalTokens` | `total_tokens` |
| `usage.cost.total` | `cost_usd` |
| `usage.cost.totalFromProvider` | `cost_source=provider`, else `model_rates` |

`cumulative` is the adapter's running sum over this file, so consumers that only
understand cumulative deltas still see the same per-request usage. Pi `/fork`
and `/clone` copy entries verbatim; the header keeps the original entry
timestamps and names the source in `parentSession`. The adapter records that id
as `forked_from_session_id`, and consumers skip entries older than the new
header timestamp so inherited history is not billed twice. A session is named by
`/name` (or `--name`) through `session_info`; an unnamed session falls back to
the first readable user prompt, matching pi's own session selector. Both are
exposed as `session.started.data.title` (single line, max 80 characters).

## Storage and deletion

SQLite is the sole initial archive writer and stores content transactionally with
the normalized event. Only complete LF-terminated records are accepted; incomplete
tails are reported as pending and retried. Malformed complete records fail that
file import atomically. File size is bounded. Repeated scans currently reread
selected files; event deduplication and consumer exports are incremental, but
byte-offset tailing is deferred. Global/session ordering is preserved; no global
wall-clock ordering across independent runtimes is claimed.

This first transport has no scope-filtered feed. Agent Knowledge must be authorized
for every project present in an imported page or reject the entire transaction.
Deploy a separate archive for a narrower collection scope; do not manually drop
unauthorized events while retaining the global cursor. The local HTTP feed already
requires a loopback Host/Origin and a bearer token with explicit views; per-project
filtered streams remain future work. A parsed `raw` value cannot reproduce the
source line's whitespace/encoding, so consumers retain `record_hash` as the
archive's source assertion, not an independently verified byte hash.

`delete-session` removes captured events including body/raw and any blob files
they reference, and appends a `session.deleted` tombstone in the same transaction. Deleted sessions cannot be
silently reimported. This is an explicit erasure exception to append-only history.
Its event ID is `SHA256(JSON.stringify([runtime, instance_id, session_id,
"deleted"]))`, its source/body/raw are null, and data is empty. The same marker
cannot appear again at a different sequence position; page retries remain valid.
Consumers must delete corresponding evidence/statistics and advance their cursor
transactionally. Exports made before deletion, consumer backups, externalized blob copies and
filesystem copies are separate copies and require their own cleanup; this is not
a secure erasure guarantee. A blob written before an archive transaction that
later rolled back is an unreferenced orphan and can be removed by directory
audit. New consumers see tombstones even when prior events were removed.

## First acceptance criteria

- Synthetic Codex and pi import, duplicate import and moved-copy import produce no doubles.
- Incomplete tails resume; malformed records/conflicting rewrites do not partially commit.
- Content is absent from metadata export and statistics storage.
- Both consumers resume independently and reject gaps/conflicts/unsupported versions.
- Original evidence remains readable after the source is removed.
- Deletion is delivered and removed from both consumer projections.
- Existing agent-stats Codex tests and agent-knowledge knowledge/MCP tests remain passing after the coordinated rename; see validation.md for the executed checks. No new live Codex-host acceptance run is claimed.
