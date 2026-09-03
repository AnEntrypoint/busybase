# Changelog

## v1.0.5

- CI: made auto-declaudeify report-only so it stops destroying release commits.

## v1.0.4

- `embedded`: added a real `close()` method to the embedded client — releases the underlying libSQL client so a second `createEmbedded()` call against the same database file doesn't silently open a second native handle onto an already-open file. Documented a Windows-specific native-binding limitation: `close()` does not synchronously release the OS-level file lock while the owning process keeps running.

## v1.0.3

- `embedded`: serialized `ensureCols` per table via a promise-chain lock, closing a concurrent-insert race where multiple callers could all observe "column missing" before any committed the `ALTER TABLE ADD COLUMN`, causing "duplicate column name" errors for every caller after the first.

## v1.0.2

- CI: fixed the publish workflow to build via the package's own build script — a stale `--external` flag had been bundling libSQL with a Bun-only `require` shim, breaking Node.js consumers of the published package.

## v1.0.1

- Query filters: added numeric-aware comparisons — a filter literal like `created_at >= '0'` now matches numeric-affinity columns as well as text columns, instead of matching zero rows against a column storing native INTEGER/REAL values.
- `embedded`: `ensureCols` now also runs on the UPDATE path, not just INSERT — previously the first update carrying a field the table had never seen threw `no such column`.
- Identifier quoting: table and column names are quoted in generated DDL/DML, so a name that collides with a SQL reserved word (e.g. a table called `case`) no longer causes a syntax error.
- `embedded`: added a pluggable backend selector via `registerBackend(name, factory)` and `EmbeddedConfig.backend`/`EmbeddedConfig.url` — any object implementing `@libsql/client`'s `Client` interface can back an embedded instance, not just local-file libSQL.

## v1.0.0

- Initial release: Supabase-compatible REST/WebSocket database server backed by libSQL, Ed25519 keypair auth, pluggable hooks, realtime subscriptions, embedded mode, Studio UI.
