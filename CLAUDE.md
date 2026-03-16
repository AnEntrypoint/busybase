# BusyBase - Technical Reference

## Architecture

BusyBase is a Supabase-compatible REST/WebSocket database server backed by LanceDB (vectordb). Bun runs TypeScript natively — no build step required.

### Source Files (src/)
- `server.ts` — Thin orchestrator: starts Bun.serve, routes `/auth/v1/*` to auth.ts, `/rest/v1/*` to rest.ts, static files, WebSocket upgrade.
- `db.ts` — LanceDB connection, table helpers (`openTbl`, `mkTbl`, `getRows`, `getAllRows`), shared utilities (`toFilter`, `clean`, `makeUser`, `makeSession`, `issueSession`, `getUser`), CORS headers, response helpers (`ok`, `err`).
- `auth.ts` — All `/auth/v1/*` handlers: keypair auth, email signup/signin, user get/update, logout, password recovery, token verify. Own state: `nonces` and `resetTokens` Maps.
- `rest.ts` — All `/rest/v1/*` CRUD handlers (GET/POST/PUT/PATCH/DELETE), vector search, hook integration.
- `hooks.ts` — Hook interface, `fireHook`, `pipeHook`, `sendEmail`, built-in SMTP. Load via `BUSYBASE_HOOKS=./my-hooks.ts`.
- `realtime.ts` — WebSocket subscriptions (Supabase realtime protocol), `broadcastChange`.
- `sdk.ts` — Browser/Node client SDK. Ed25519 keypair auth, email auth, table CRUD, realtime subscriptions.
- `embedded.ts` — In-process LanceDB mode. Use `createEmbedded({ dir })` for zero-config local usage.
- `cli.ts` — CLI: `busybase serve`, `busybase test`, plus table/auth commands.

### No Build Step
The `.js` compiled artifacts are deleted. Bun runs `.ts` files directly. `package.json` exports and `bin` point to `.ts` sources.

## Configuration (Environment Variables)
- `BUSYBASE_DIR` — Data directory (default: `busybase_data`)
- `BUSYBASE_PORT` — Server port (default: `54321`)
- `BUSYBASE_CORS_ORIGIN` — CORS origin header (default: `*`)
- `BUSYBASE_HOOKS` — Path to hooks file (optional)
- `BUSYBASE_URL` — Used in password-reset emails
- `BUSYBASE_SMTP_HOST/PORT/USER/PASS/FROM` — SMTP config for built-in email transport

## SENTINEL Pattern
Tables are pre-seeded with a `_sentinel_` row so LanceDB can infer schema. All queries filter `id != '_sentinel_'` (or `token != '_sentinel_'` for sessions). Never remove sentinel rows.

## Hooks
Return `{ error: string }` from any hook to abort the operation. Return a transformed value from `pipeHook` hooks (`beforeSelect`, `afterSelect`, `beforeInsert`, `afterInsert`, `beforeUpdate`, `afterUpdate`). Hook file loaded once at startup via `BUSYBASE_HOOKS`.

## Embedded Mode
`import { createEmbedded } from 'busybase/embedded'` — returns a client with the same interface as the HTTP SDK but running in-process. Used by zellous for zero-config local deployment.
