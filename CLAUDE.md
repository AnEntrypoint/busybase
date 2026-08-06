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
- `embedded.ts` — In-process libSQL mode. Use `createEmbedded({ dir })` for zero-config local usage.
- `cli.ts` — CLI: `busybase serve`, `busybase test`, plus table/auth commands.

### Build Step
Run `bun run build` to compile `.ts` sources to `.js` artifacts in `src/`. The `package.json` exports and `bin` point to the built `.js` files. The GitHub Actions publish workflow runs all build steps before `npm publish`. When developing locally with Bun, run `bun run src/cli.ts` directly — the build is only needed for npm publishing.

## Configuration (Environment Variables)
- `BUSYBASE_DIR` — Data directory (default: `busybase_data`). SQLite file stored at `<dir>/db.sqlite`.
- `BUSYBASE_PORT` — Server port (default: `54321`)
- `BUSYBASE_CORS_ORIGIN` — CORS origin header (default: `*`)
- `BUSYBASE_HOOKS` — Path to hooks file (optional). This file is dynamically `import()`ed with full process privileges at startup — it must be an operator-controlled path (config/deploy-time), never derived from end-user input.
- `BUSYBASE_STUDIO_TOKEN` — When set, gates all `/studio*` routes behind a token check (`?token=` query param or `Authorization: Bearer` header). Unset by default for zero-config local use; set it before exposing Studio beyond localhost.
- `BUSYBASE_URL` — Used in password-reset emails
- `BUSYBASE_SMTP_HOST/PORT/USER/PASS/FROM` — SMTP config for built-in email transport
- `BUSYBASE_MAX_BODY_SIZE` — Max request body size in bytes (default: `10485760`, 10MB)

## SQLite Schema

Tables are created on-demand via `CREATE TABLE IF NOT EXISTS` with TEXT columns derived from the first inserted row's keys. New columns are added automatically via `ALTER TABLE ADD COLUMN`. Auth tables (`_users`, `_sessions`) are created at startup with fixed schemas.

No sentinel rows needed — SQLite schema is defined by CREATE TABLE, not by data inference.

## Vector Search

`.vec(embedding, limit)` performs brute-force cosine-similarity search over a JSON-encoded `vector` TEXT column (`db.ts`: `cosineDistance`, `parseVector`, `vecSearch`). Rows are fetched (respecting any other filters), scored, sorted ascending by `_distance`, and truncated to `limit`. Rows with no vector or a length-mismatched vector are excluded, never coerced. `dbInsertIn`/`dbUpdateIn` JSON-encode array/object values automatically, so `insert({ vector: [0.1, 0.2] })` stores valid JSON without the caller stringifying it.

## Hooks
Return `{ error: string }` from any hook to abort the operation. Return a transformed value from `pipeHook` hooks (`beforeSelect`, `afterSelect`, `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`). Hook file loaded once at startup via `BUSYBASE_HOOKS`.

## Embedded Mode
`import { createEmbedded } from 'busybase/embedded'` — returns a client with the same interface as the HTTP SDK but running in-process using libSQL in local file mode. Used by zellous for zero-config local deployment.

## Studio

BusyBase Studio is a zero-dependency browser UI served directly from the running server at `/studio`.

### Studio Files (studio/)
- `index.html` — Shell: sidebar nav (Tables/Auth/Realtime/SQL/Settings), dynamically loads panel modules into `#app` via ES module imports. No build step.
- `tables.js` — Table browser: lists tables via `/studio/api/tables`, shows rows, supports inline cell edit, add row, delete row.
- `auth.js` — User management: lists users from `/rest/v1/_users`, create user form posting to `/auth/v1/signup`.
- `realtime.js` — Live event log: WebSocket connection to `/realtime/v1/websocket`, scrolling log of INSERT/UPDATE/DELETE events with timestamp and payload.
- `sql.js` — Query panel: table dropdown, SQL WHERE clause input, Run button, results table.
- `settings.js` — Config viewer: fetches `/studio/config`, shows env var table and SDK usage snippet.

### Studio Server Routes (server.ts)
- `GET /studio` — 301 redirects to `/studio/` (its panel modules resolve relative imports against the request URL, so the trailing slash is required)
- `GET /studio/` — serves `studio/index.html`
- `GET /studio/*.js` — serves studio JS panel files
- `GET /studio/config` — returns `{ BUSYBASE_DIR, BUSYBASE_PORT, BUSYBASE_CORS_ORIGIN }` (no secrets)
- `GET /studio/api/tables` — returns `{ data: string[] }` of all table names via `tableNames()` from db.ts

## GUI

`src/gui.html`, served at `/` and `/gui` (server.ts `staticRoutes`), is a separate single-page admin app from Studio — a webjsx SPA styled with `anentrypoint-design` (loaded from jsdelivr CDN as a single ESM bundle: `dist/247420.js` for components/webjsx/mount, `dist/247420.css` for styles). Same CDN-availability caveat as Studio's own external dependencies: it will not load without internet access to jsdelivr.

Four tabs, driven by one module-level `S` state object and a `render()` function returned by `anentrypoint-design`'s `mount(rootEl, viewFn)`:
- **Data** — table list (persisted in `localStorage`), row browser with inline dblclick-to-edit cells, add/delete row, add/remove table
- **Auth** — keypair (anonymous Ed25519) sign-in/restore/export, email/password sign-up/sign-in
- **API Explorer** — canned REST/auth request examples, editable request textarea, Run button showing raw JSON response
- **Logs** — rolling log of every `api()` call made by the GUI itself (method, path, response), newest first

`anentrypoint-design` component API notes (undocumented in its generated `.d.ts`, confirmed by reading its bundle): `Btn`/`Alert`/`Panel` take `children` as a prop key on the single props object, NOT a second positional argument like `h()`. `TextField.onInput`/`Select.onChange` call back with `(value, event)` — the value string first, not a DOM event. `Topbar.items` is `[label, href]` tuples. `Side.sections` is `[{group, items:[{label,href,active,onClick}]}]`. `Table.rows` is array-of-arrays positional to `headers`, not array-of-objects.

### GitHub Pages (docs/)
- `docs/index.html` — Marketing site: hero, features grid, comparison table vs Supabase, quick start code tabs, footer. Pure HTML/CSS/JS, no build step. Deployed via GitHub Pages.
