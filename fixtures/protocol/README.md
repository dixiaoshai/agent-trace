# Protocol v1 conformance fixtures

Status: draft, not yet wired into any consumer's CI. Owner: Agent Trace.
Protocol reference: [`docs/protocol.md`](../../docs/protocol.md), transport and
consumer behavior: [`docs/local-api.md`](../../docs/local-api.md),
[`docs/consumer-follow.md`](../../docs/consumer-follow.md).

These fixtures describe the **page contract** shared by every archive consumer
(Agent Stats, Agent Knowledge, Agent Journal). They are tiny and synthetic: no
real session content, paths or credentials. They exist so each consumer can test
its *own* validator against the *same* accept/reject corpus without importing
another consumer's code.

## Layout

```text
valid/
  content-page-1.json          # one small session: started, user, tool, usage, final
  content-deletion-page.json   # tombstone for that session; apply after cursor 6
  content-ref-page.json        # externalized content_ref body (do not read the path)
  metadata-empty-page.json     # empty metadata tail; metadata consumers only
invalid/                       # 16 pages, each with exactly one contract violation
manifest.json                  # expected outcome and rationale per fixture
generate.mjs                   # source of truth; run after editing
```

## How consumers should use them

1. Load `manifest.json`.
2. For every `valid` fixture: feed it to your page validator with fresh state and
   expect acceptance. For `content-page-1.json` followed by
   `content-deletion-page.json`, expect the cursor to move `6 → 7` and the
   session evidence to be removed, with a replayed old page not resurrecting it.
3. For every `invalid` fixture: expect a **permanent** rejection, no cursor
   advance and no partial writes. `expected_code` maps the semantic failure to
   the codes named in `consumer-follow.md`; translate to your own code if your
   consumer uses different names (the Knowledge manual importer reports
   `INVALID_ARCHIVE` for all of them).
4. Do not import the fixtures into production storage or copy them into a
   consumer's own test data without keeping the manifest outcome.

The two transports share the same contract: a CLI `export` file and an HTTP
`/v1/events` page have the same envelope, event identity and cursor semantics.

## Cases that are state-dependent, not standalone fixtures

- `ARCHIVE_CHANGED`: feed a page after binding a different `archive_id`.
- `VIEW_UNAVAILABLE`: `/v1/status` reports `archive.capture_mode = "metadata"`.
- `PAGE_TOO_LARGE`: server-side 413; reduce `limit` and retry the same cursor.
- `FOLLOW_LOCKED` / lease takeover: consumer state, not page content.

## Identity and field rules encoded here

- `session_key = JSON.stringify([runtime, instance_id, session_id])` for every
  event.
- Codex `event_id = sha256(JSON.stringify([runtime, instance_id, session_id, source.line]))`;
  add `source.series` when present (not used in these fixtures).
- Deletion `event_id = sha256(JSON.stringify([runtime, instance_id, session_id, "deleted"]))`,
  with `source`, `body`, `raw` null and `data` empty.
- `archive_seq` strictly increases inside a page, never exceeds `next_cursor`,
  and the page always starts at the consumer's committed cursor.
- Usage token counts are nonnegative integers; absent fields are unknown, not zero.
- `content_ref` is `{path: absolute, bytes, sha256, media_type: "text/plain"}`.
- Metadata view pages carry `body = raw = null`.

## Regenerate

```sh
node generate.mjs
```

The generator computes all identities itself and fails if a valid page violates
the identity rules above.

## Validation record (2026-11-15)

Checked against the local Agent Knowledge build (`dist/interfaces/cli.js`,
57 tests passing) with a temporary database and `allowed_project_ids: ["fixture"]`:

- `valid/content-page-1.json` → accepted, cursor 6, imported 6.
- `archive-search hello` → 3 hits; `archive-read` → the expected event.
- `valid/content-deletion-page.json` → accepted, cursor 7, imported 0.
- After deletion: search returns `[]`; reading the old event returns `NOT_FOUND`.
- `valid/content-ref-page.json` → accepted; reading returns the event with the
  `content_ref` unchanged (the blob path is not read).
- All 16 `invalid/*.json` → rejected with `INVALID_ARCHIVE` and the cursor did not
  advance (messages included "Invalid event ID", "Invalid session key",
  "Invalid content reference", "Archive cursor gap", "Invalid deletion marker",
  "Unexpected metadata field", "Invalid usage", and the strict envelope errors).
- `valid/metadata-empty-page.json` is deliberately not importable by the
  content-only Knowledge importer; it targets metadata consumers.

This is fixture-level validation, not a replacement for Trace's ingest tests or
for a real-host acceptance run.
