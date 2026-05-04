# BusyBase

[![License: MIT](https://img.shields.io/badge/License-MIT-7c6af7.svg)](LICENSE)
[![Built with Bun](https://img.shields.io/badge/Built%20with-Bun-f9f1e1.svg?logo=bun)](https://bun.sh)
[![libSQL](https://img.shields.io/badge/Storage-libSQL%2FSQLite-38bdf8.svg)](https://github.com/tursodatabase/libsql)
[![Supabase Compatible](https://img.shields.io/badge/API-Supabase%20JS%20v2-3ecf8e.svg)](https://supabase.com/docs/reference/javascript)
[![Releases](https://img.shields.io/github/v/release/AnEntrypoint/busybase?color=a78bfa)](https://github.com/AnEntrypoint/busybase/releases)

**A minimal, drop-in Supabase alternative — self-hosted, no Docker, no Postgres, no config files.**

Built on [Bun](https://bun.sh) + [libSQL](https://github.com/tursodatabase/libsql) (SQLite). Single process. File-based storage. **Ed25519 keypair auth** (anonymous-first). Supabase JS v2 compatible API. Ships as a single binary.

**[Documentation](https://anentrypoint.github.io/busybase/docs.html)** · **[Website](https://anentrypoint.github.io/busybase/)** · **[Releases](https://github.com/AnEntrypoint/busybase/releases)**

---

## Feature Table

| Feature | BusyBase | Supabase (self-hosted) | PocketBase |
|---|:---:|:---:|:---:|
| Supabase JS v2 compatible | ✅ | ✅ | ❌ |
| Single binary deploy | ✅ | ❌ | ✅ |
| No Docker required | ✅ | ❌ | ✅ |
| Ed25519 keypair auth | ✅ | ❌ | ❌ |
| Anonymous-first auth | ✅ | ⚠️ anon key | ❌ |
| File-based storage | ✅ | ❌ | ✅ |
| Pluggable hooks (18 hooks) | ✅ | ⚠️ Edge Functions | ⚠️ JS hooks |
| Zero config startup | ✅ | ❌ | ✅ |
| Built-in SMTP email | ✅ | ⚠️ external | ✅ |
| Realtime subscriptions | ✅ | ✅ | ✅ |

---

## Quick Start

```sh
# Start server (default: http://localhost:54321)
bunx busybase serve

# Or download a standalone binary — no Bun required
curl -L https://github.com/AnEntrypoint/busybase/releases/latest/download/busybase-linux-x64 -o busybase
chmod +x busybase && ./busybase serve
```

```ts
import BB from "busybase";

const db = BB("http://localhost:54321", "local");

// Anonymous-first auth — no email/password needed!
const { data: { user, session } } = await db.auth.keypair.signIn();

// Insert (auto-creates table)
await db.from("todos").insert({ title: "Buy milk", done: false });

// Query
const { data } = await db.from("todos").select("*").eq("done", false);

```

```sh
# Run the full SDK test suite against your live server
bunx busybase test
```

---

## Installation

```sh
# Run without installing
bunx busybase serve

# Install globally
bun install -g busybase

# SDK only
bun add busybase
npm install busybase
```

---

## Auth

BusyBase supports two auth flows — both return the standard `{ data, error }` shape.

### Keypair Auth (Ed25519 — anonymous-first, zero deps)

```ts
// Sign in instantly — no email, no password, no form
const { data } = await db.auth.keypair.signIn();
// data.user.id — persistent UUID, same every time
// data.session.access_token

// Backup your keypair (save these!)
const { privkey, pubkey } = db.auth.keypair.export();

// Restore on any device
await db.auth.keypair.restore(privkey, pubkey);
// Same user.id ✓

// Add email/password to a keypair account later
await db.auth.updateUser({ email: "user@example.com", password: "secret" });
```

### Email / Password

```ts
await db.auth.signUp({ email, password, options: { data: { name: "Alice" } } });
const { data: { user, session } } = await db.auth.signInWithPassword({ email, password });
await db.auth.updateUser({ password: "newpassword", data: { plan: "pro" } });
await db.auth.signOut();
```

---

## Database (CRUD)

Tables are created automatically on first insert. No schema definition required.

```ts
// Insert
const { data } = await db.from("todos").insert({ title: "Buy milk" });
await db.from("todos").insert([{ title: "A" }, { title: "B" }]); // batch

// Select
await db.from("todos").select("*");
await db.from("todos").select("id,title"); // specific columns

// Filters
await db.from("todos").select("*")
  .eq("done", false)
  .like("title", "Buy")
  .order("title", { ascending: true })
  .limit(20)
  .offset(0);

// Update
await db.from("todos").update({ done: true }).eq("id", "abc");

// Delete
await db.from("todos").delete().eq("done", true);
```

### Filter operators

| Method | SQL |
|---|---|
| `.eq(col, val)` | `col = val` |
| `.neq(col, val)` | `col != val` |
| `.gt(col, val)` | `col > val` |
| `.gte(col, val)` | `col >= val` |
| `.lt(col, val)` | `col < val` |
| `.lte(col, val)` | `col <= val` |
| `.like(col, val)` | `col LIKE '%val%'` |
| `.ilike(col, val)` | case-insensitive LIKE |
| `.is(col, null)` | `col IS NULL` |
| `.in(col, [a,b,c])` | `col IN (a, b, c)` |
| `.not(col, "eq", val)` | `NOT col = val` |
| `.or("a.eq.1,b.eq.2")` | `a=1 OR b=2` |

### Modifiers

| Method | Description |
|---|---|
| `.order(col, { ascending })` | Sort results |
| `.limit(n)` | Max rows (default: 1000) |
| `.offset(n)` | Skip N rows |
| `.range(from, to)` | Rows from–to inclusive |
| `.count("exact")` | Add `count` + `Content-Range` header |
| `.single()` | Return object (error if 0 rows) |
| `.maybeSingle()` | Return object or null (no error) |

---

## Realtime

Subscribe to table changes via WebSocket — `INSERT`, `UPDATE`, and `DELETE` events are broadcast to all active subscribers.

### WebSocket endpoint

```
ws://localhost:54321/realtime/v1/websocket
```

Subscribe to a table by sending a JSON message after connecting:

```json
{ "type": "subscribe", "table": "todos" }
```

Unsubscribe:

```json
{ "type": "unsubscribe", "table": "todos" }
```

### Event shape

```json
{
  "event": "INSERT",
  "eventType": "INSERT",
  "table": "todos",
  "new": { "id": "abc", "title": "Buy milk" },
  "old": null
}
```

`eventType` is one of `INSERT`, `UPDATE`, or `DELETE`. For `UPDATE`, both `new` and `old` are populated. For `DELETE`, `new` is `null`.

### SDK — `channel()` (Supabase-compatible)

```ts
const db = BB("http://localhost:54321", "local");

const ch = db.channel("todos-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "todos" }, (payload) => {
    console.log(payload.eventType, payload.new, payload.old);
  })
  .subscribe((status) => console.log("status:", status));

// Later:
ch.unsubscribe();

// Tear down all channels:
db.removeAllChannels();
```

Filter by event type:

```ts
db.channel("inserts-only")
  .on("postgres_changes", { event: "INSERT", schema: "public", table: "todos" }, (payload) => {
    console.log("New row:", payload.new);
  })
  .subscribe();
```

---

## Hooks

Point `BUSYBASE_HOOKS` to a TypeScript file:

```sh
BUSYBASE_HOOKS=./hooks.ts bunx busybase serve
```

All 18 hooks are optional. Return `{ error: "message" }` from any hook to abort the operation.

```ts
// hooks.ts
export const canAccess = ({ user, table, method }) => {
  if (!user && method !== "GET") return { error: "Login required" };
};

export const beforeInsert = (table, rows) => {
  if (table === "comments") rows.forEach(r => r.created_at = new Date().toISOString());
};

export const onSignup = async (user) => {
  await sendWelcomeEmail(user.email);
};

export const sendEmail = async ({ to, subject, html }) => {
  // Override built-in SMTP — use Resend, SendGrid, etc.
  await resend.emails.send({ from: "noreply@myapp.com", to, subject, html });
};
```

### All available hooks

| Hook | Category | Description |
|---|---|---|
| `onSignup(user)` | Auth | New user created |
| `onSignin(user)` | Auth | User signed in |
| `onSignout(user)` | Auth | User signed out |
| `onEmailChange(user, newEmail)` | Auth | Email update requested |
| `onPasswordReset(email, token)` | Auth | Password reset requested |
| `onUserUpdate(user, changes)` | Auth | User metadata updated |
| `onRequest(req)` | Middleware | Every HTTP request (return Response to short-circuit) |
| `canAccess({ user, table, method })` | Access | Row-level access control |
| `beforeInsert(table, rows)` | Data | Before rows inserted |
| `afterInsert(table, rows)` | Data | After rows inserted (pipe) |
| `beforeUpdate(table, rows, changes)` | Data | Before rows updated |
| `afterUpdate(table, rows)` | Data | After rows updated (pipe) |
| `beforeDelete(table, rows)` | Data | Before rows deleted |
| `afterDelete(table, rows)` | Data | After rows deleted |
| `beforeSelect(table, params)` | Data | Before query executes (pipe) |
| `afterSelect(table, rows)` | Data | After query executes (pipe) |
| `sendEmail({ to, subject, html })` | Email | Override all email sending |
| `onIssueSession(user)` | Session | Customize session payload |

---

## REST API

| Method | Path | Description |
|---|---|---|
| `GET` | `/rest/v1/:table` | Query rows |
| `POST` | `/rest/v1/:table` | Insert rows |
| `PATCH` | `/rest/v1/:table?eq.col=val` | Update rows |
| `DELETE` | `/rest/v1/:table?eq.col=val` | Delete rows |
| `GET` | `/auth/v1/keypair` | Get nonce (step 1 of keypair auth) |
| `POST` | `/auth/v1/keypair` | Verify signature (step 2) |
| `POST` | `/auth/v1/signup` | Register email/password user |
| `POST` | `/auth/v1/token` | Sign in with email/password |
| `GET` | `/auth/v1/user` | Get current user |
| `PATCH` | `/auth/v1/update` | Update user |
| `POST` | `/auth/v1/logout` | Sign out |
| `POST` | `/auth/v1/recover` | Request password reset |
| `POST` | `/auth/v1/verify` | Confirm reset token + new password |

Supports: `Prefer: return=minimal` (204 response), `Prefer: count=exact` + `Content-Range` header, CORS on all routes.

---

## CLI

```sh
busybase serve                           # Start server
busybase test                            # Full SDK e2e test suite
busybase signup user@example.com pass    # Register user
busybase signin user@example.com pass    # Sign in (prints token)
busybase user                            # Get current user
busybase insert todos '{"title":"Buy milk"}'
busybase query  todos done=false
busybase update todos '{"done":"true"}' title=Buy\ milk
busybase delete todos done=true
```

---

## Configuration

| Variable | Default | Description |
|---|---|---|
| `BUSYBASE_PORT` | `54321` | HTTP port |
| `BUSYBASE_DIR` | `busybase_data` | Data directory (SQLite file stored as `<dir>/db.sqlite`) |
| `BUSYBASE_URL` | `http://localhost:54321` | Public URL (used in reset email links) |
| `BUSYBASE_HOOKS` | — | Path to your hooks file |
| `BUSYBASE_SMTP_HOST` | — | SMTP hostname |
| `BUSYBASE_SMTP_PORT` | `587` | SMTP port |
| `BUSYBASE_SMTP_USER` | — | SMTP username |
| `BUSYBASE_SMTP_PASS` | — | SMTP password |
| `BUSYBASE_SMTP_FROM` | SMTP_USER | From address |

---

## Standalone Binaries

Every push to `master` builds self-contained executables — no Bun or Node.js required:

| Platform | File |
|---|---|
| Linux x64 | `busybase-linux-x64` |
| macOS ARM64 (Apple Silicon) | `busybase-macos-arm64` |
| Windows x64 | `busybase-windows-x64.exe` |

Download from [Releases](https://github.com/AnEntrypoint/busybase/releases).

---

## Embedded mode + Pluggable backends

`busybase/embedded` runs the full server logic in-process — no HTTP, no socket. Same Supabase JS v2 surface as the network SDK, just bound directly to the storage backend.

```ts
import { createEmbedded } from "busybase/embedded";

const bb = await createEmbedded({ dir: "busybase_data" });
const { data } = await bb.from("todos").insert({ title: "Buy milk" });
```

### Backend registry

The default backend is libSQL. Other backends register a factory that returns any object implementing `@libsql/client`'s `Client` interface — the same `execute({sql, args})` shape every busybase query already uses.

```ts
import { registerBackend, createEmbedded } from "busybase/embedded";

// Register a custom backend (any sql.js / WASM / remote shim works)
registerBackend("sqljs", async ({ url }) => {
  const { createClient } = await import("./libsql-sqljs.js");
  return createClient({ url });
});

// Use it
const bb = await createEmbedded({ backend: "sqljs", url: "file:appdb" });
await bb.from("notes").insert({ body: "running entirely in the browser" });
```

Why this matters: the [thebird](https://github.com/AnEntrypoint/thebird) browser-native web-OS ships a `@libsql/client`-shape adapter over sql.js (`docs/libsql-sqljs.js`). Registering it as a busybase backend gives thebird a full Supabase-compatible DB **inside the browser** — anonymous-first auth, REST-style filters, realtime subscriptions, hooks — without any server.

### `EmbeddedConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `dir` | `string` | `"busybase_data"` | Storage directory (libsql backend only — `mkdirSync` runs only when `backend === "libsql"`) |
| `hooks` | `Hooks` | `{}` | Optional hooks file shape — see [Hooks](#hooks) |
| `backend` | `string` | `"libsql"` | Registered backend name |
| `url` | `string` | `file:${dir}/db.sqlite` | Override the connection URL passed to the backend factory |

`registerBackend(name, factory)` is process-global and idempotent on the same name. Calling `createEmbedded({ backend })` with an unknown name throws `busybase: unknown backend '<name>'`.

---

## Architecture

- **Runtime:** [Bun](https://bun.sh) — native TypeScript, sub-ms startup, single binary compilation
- **Storage:** [libSQL](https://github.com/tursodatabase/libsql) — SQLite-compatible, file-based, `cp -r busybase_data` to backup. Default backend; swap via `registerBackend()` for sql.js / wasm / remote engines.
- **Auth:** Ed25519 via WebCrypto (zero deps) + bcrypt via `Bun.password`
- **Sessions:** UUID tokens, 7-day expiry, stored in `_sessions` table
- **CLI = SDK = Server** — the CLI uses the real SDK, making `busybase test` a true e2e test runner

---

## License

MIT — see [LICENSE](LICENSE).
