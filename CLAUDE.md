# BusyBase - Technical Reference

## Architecture

BusyBase is a Supabase-compatible REST/WebSocket database server backed by libSQL (SQLite via @libsql/client). Bun runs TypeScript natively — no build step required.

### Source Files (src/)
- `server.ts` — Thin orchestrator: starts Bun.serve, routes `/auth/v1/*` to auth.ts, `/rest/v1/*` to rest.ts, static files, WebSocket upgrade.
- `db.ts` — libSQL connection, table helpers (`openTbl`, `mkTbl`, `ensureCols`, `getRows`, `getAllRows`, `dbInsert`, `dbUpdate`, `dbDelete`), shared utilities (`toFilter`, `clean`, `makeUser`, `makeSession`, `issueSession`, `getUser`), CORS headers, response helpers (`ok`, `err`).
- `auth.ts` — All `/auth/v1/*` handlers: keypair auth, email signup/signin, user get/update, logout, password recovery, token verify. Own state: `nonces` and `resetTokens` Maps.
- `rest.ts` — All `/rest/v1/*` CRUD handlers (GET/POST/PUT/PATCH/DELETE), hook integration.
- `hooks.ts` — Hook interface, `fireHook`, `pipeHook`, `sendEmail`, built-in SMTP. Load via `BUSYBASE_HOOKS=./my-hooks.ts`.
- `realtime.ts` — WebSocket subscriptions (Supabase realtime protocol), `broadcastChange`.
- `sdk.ts` — Browser/Node client SDK. Ed25519 keypair auth, email auth, table CRUD, realtime subscriptions.
- `embedded.ts` — In-process libSQL mode. Use `createEmbedded({ dir })` for zero-config local usage. Own implementation of the query/mutation helpers (identifier quoting via `qid`, numeric-aware filter comparisons, per-table `ensureCols` locking) rather than reusing db.ts's — the two are not the same code path.
- `cli.ts` — CLI: `busybase serve`, `busybase test`, plus table/auth commands.

### Build Step
Run `bun run build` to compile `.ts` sources to `.js` artifacts in `src/`. The `package.json` exports and `bin` point to the built `.js` files. The GitHub Actions publish workflow runs all build steps before `npm publish`. When developing locally with Bun, run `bun run src/cli.ts` directly — the build is only needed for npm publishing.

## Configuration (Environment Variables)
- `BUSYBASE_DIR` — Data directory (default: `busybase_data`). SQLite file stored at `<dir>/db.sqlite`.
- `BUSYBASE_PORT` — Server port (default: `54321`)
- `BUSYBASE_CORS_ORIGIN` — CORS origin header (default: `*`)
- `BUSYBASE_HOOKS` — Path to hooks file (optional)
- `BUSYBASE_URL` — Used in password-reset emails
- `BUSYBASE_SMTP_HOST/PORT/USER/PASS/FROM` — SMTP config for built-in email transport

## SQLite Schema

Tables are created on-demand via `CREATE TABLE IF NOT EXISTS` with TEXT columns derived from the first inserted row's keys. New columns are added automatically via `ALTER TABLE ADD COLUMN`. Auth tables (`_users`, `_sessions`) are created at startup with fixed schemas.

No sentinel rows needed — SQLite schema is defined by CREATE TABLE, not by data inference.

## Hooks
Return `{ error: string }` from any hook to abort the operation. Return a transformed value from `pipeHook` hooks (`beforeSelect`, `afterSelect`, `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`). Hook file loaded once at startup via `BUSYBASE_HOOKS`.

## Embedded Mode
`import { createEmbedded } from 'busybase/embedded'` — returns a client with the same interface as the HTTP SDK but running in-process using libSQL in local file mode. Used by zellous for zero-config local deployment.

### Pluggable backends (2026-05-04+)
`embedded.ts` exposes `registerBackend(name, factory)` and accepts `EmbeddedConfig.backend` + `EmbeddedConfig.url`. The factory receives `{ url }` and returns any object implementing `@libsql/client`'s `Client` interface — same `execute({sql, args})` shape every busybase query already uses. Default backend is `'libsql'`. Unknown backend names throw `busybase: unknown backend '<name>'`. `mkdirSync` only runs for the libsql backend so non-disk backends (sql.js, remote shims) work cleanly. Used by [thebird](https://github.com/AnEntrypoint/thebird) (`docs/libsql-sqljs.js`) to host busybase as a Supabase-compatible DB inside the browser via vendored sql.js.

### Closing an embedded client
The object returned by `createEmbedded()` has a `close()` method that releases the underlying libSQL client — call it before creating a second embedded client against the same database file in the same process, or the new client opens a second native handle onto an already-open file. Degrades to a no-op on backends with no local file handle to release. On Windows, the native libSQL binding does not release its OS-level file lock synchronously on `close()` while the owning process keeps running; the file only becomes removable once that process actually exits. A per-test harness needing the file removable in-process must isolate each test in its own child process.

### Concurrency: `ensureCols` per-table locking
`ensureCols` is check-then-act (read `PRAGMA table_info`, then `ALTER TABLE ADD COLUMN`) with nothing serializing it by default — concurrent callers for the same table can all observe "column missing" before any commits the `ALTER`, causing a `duplicate column name` error for every caller after the first. `embedded.ts` serializes `ensureCols` per-table via a promise-chain lock (different tables still run fully concurrently); the same call also runs on the UPDATE path (not just INSERT), since an update introducing a new field would otherwise throw `no such column` on its first use.

## Studio

BusyBase Studio is a zero-dependency browser UI served directly from the running server at `/studio`.

### Studio Files (studio/)
- `index.html` — Shell: sidebar nav (Tables/Auth/Realtime/SQL/Settings), dynamically loads panel modules into `#app` via ES module imports. No build step.
- `tables.js` — Table browser: lists tables via `/studio/api/tables`, shows rows, supports inline cell edit, add row, delete row.
- `auth.js` — User management: lists users from `/studio/api/users`, create user form posting to `/auth/v1/signup`.
- `realtime.js` — Live event log: WebSocket connection to `/realtime/v1/websocket`, scrolling log of INSERT/UPDATE/DELETE events with timestamp and payload.
- `sql.js` — Query panel: table dropdown, SQL WHERE clause input, Run button, results table.
- `settings.js` — Config viewer: fetches `/studio/config`, shows env var table and SDK usage snippet.

### Studio Server Routes (server.ts)
- `GET /studio` or `/studio/` — serves `studio/index.html`
- `GET /studio/*.js` — serves studio JS panel files
- `GET /studio/config` — returns `{ BUSYBASE_DIR, BUSYBASE_PORT, BUSYBASE_CORS_ORIGIN }` (no secrets)
- `GET /studio/api/tables` — returns `{ data: string[] }` of all table names via `tableNames()` from db.ts
- `GET /studio/api/users` — returns `{ data: User[] }` from `_users` via `getAllRows`, stripped through `clean()` (no password hash or pubkey)

### GitHub Pages (docs/)
- `docs/index.html` — Marketing site: hero, features grid, comparison table vs Supabase, quick start code tabs, footer. Pure HTML/CSS/JS, no build step. Deployed via GitHub Pages.
