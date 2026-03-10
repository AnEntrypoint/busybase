# BusyBase

A drop-in headless Supabase alternative — minimal, self-hosted, no Docker required.

Built on [Bun](https://bun.sh) + [LanceDB](https://lancedb.com). Single process, file-based, supports **vector search** natively. Compatible with Supabase JS client v2 API.

## Quick Start

```sh
# Start server
bunx busybase serve

# Or download a standalone binary from Releases (no Bun required)
./busybase-linux-x64 serve
```

Server starts on `http://localhost:54321` by default.

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `BUSYBASE_PORT` | `54321` | HTTP port |
| `BUSYBASE_DIR` | `busybase_data` | Data directory |
| `BUSYBASE_URL` | `http://localhost:54321` | URL for CLI commands |

---

## CLI

The CLI is the first-class interface — all commands use the same SDK client:

```sh
busybase serve                           # Start server
busybase test                            # Run full SDK test suite
busybase signup user@example.com pass    # Register user
busybase signin user@example.com pass    # Sign in (prints token)
busybase user                            # Get current user
busybase insert todos '{"title":"Buy milk"}'
busybase query todos done=false
busybase update todos '{"done":"true"}' title=Buy\ milk
busybase delete todos title=Buy\ milk
busybase vec embeddings '[1,0,0,0]' 5   # Vector search
```

---

## SDK

```js
import BB from "busybase"; // or: const { createClient } = require("busybase")

const db = BB("http://localhost:54321", "your-api-key");
```

Mirrors the [Supabase JS client v2](https://supabase.com/docs/reference/javascript) API — `{ data, error }` response shape throughout.

---

## Auth

```js
// Sign up
const { data, error } = await db.auth.signUp({ email, password });

// Sign in
const { data, error } = await db.auth.signInWithPassword({ email, password });
// data.session.access_token, data.user

// Get current user
const { data } = await db.auth.getUser();
// data.user

// Get current session (local, no network)
const { data } = await db.auth.getSession();
// data.session

// Update user metadata / password
await db.auth.updateUser({ password: "new", data: { name: "Alice" } });

// Auth state change listener
const { data: { subscription } } = db.auth.onAuthStateChange((event, session) => {
  // events: INITIAL_SESSION, SIGNED_IN, SIGNED_OUT
});
subscription.unsubscribe();

// Sign out
await db.auth.signOut();
```

---

## Database (CRUD)

Tables are created automatically on first insert.

```js
// Insert
const { data, error } = await db.from("todos").insert({ title: "Buy milk", done: false });

// Batch insert
await db.from("todos").insert([
  { title: "Read book", done: true },
  { title: "Exercise", done: false },
]);

// Select
const { data } = await db.from("todos").select("*");

// Select specific columns
const { data } = await db.from("todos").select("title,done");

// Update
await db.from("todos").update({ done: true }).eq("title", "Buy milk");

// Delete
await db.from("todos").delete().eq("title", "Buy milk");
```

### Filters

```js
.eq("col", val)          // =
.neq("col", val)         // !=
.gt("col", val)          // >
.gte("col", val)         // >=
.lt("col", val)          // <
.lte("col", val)         // <=
.like("col", "pattern")  // LIKE '%pattern%'
.ilike("col", "pattern") // LIKE '%pattern%' (case-insensitive)
.is("col", null)         // IS NULL / IS NOT NULL
.in("col", [a, b, c])   // IN (a, b, c)
.not("col", "eq", val)  // NOT col = val
.or("col.eq.a,col.eq.b") // OR clause
```

### Modifiers

```js
.order("col", { ascending: true })
.limit(10)
.offset(20)
.range(0, 9)          // rows 0–9
.count("exact")       // adds { count: N } to response
.single()             // return object instead of array (error if 0 rows)
.maybeSingle()        // return object or null (no error if 0 rows)
```

---

## Vector Search

Store embeddings with your data, query by similarity:

```js
// Insert rows with a `vector` field
await db.from("docs").insert([
  { title: "Cats article", vector: [0.9, 0.1, 0.0, 0.0] },
  { title: "Dogs article", vector: [0.1, 0.9, 0.0, 0.0] },
]);

// Search — sorted by similarity, includes `_distance`
const { data } = await db.from("docs").select("*").vec([0.85, 0.15, 0.0, 0.0], 5);
// data[0].title === "Cats article", data[0]._distance === 0.03...

// Combine with filters
const { data } = await db.from("docs").vec([...], 10).eq("published", "true");
```

Generate vectors with any embedding model (OpenAI, Ollama, etc.) and pass them in.

---

## REST API

HTTP API compatible with Supabase REST:

| Method | Path | Description |
|---|---|---|
| `GET` | `/rest/v1/:table` | Query rows |
| `POST` | `/rest/v1/:table` | Insert rows |
| `PATCH` | `/rest/v1/:table?eq.col=val` | Update rows |
| `DELETE` | `/rest/v1/:table?eq.col=val` | Delete rows |
| `POST` | `/auth/v1/signup` | Register |
| `POST` | `/auth/v1/token` | Sign in |
| `GET` | `/auth/v1/user` | Current user |
| `PATCH` | `/auth/v1/update` | Update user |
| `POST` | `/auth/v1/logout` | Sign out |

All responses are `{ data, error }` shaped. Vector search: `GET /rest/v1/table?vec=[...]&limit=5`.

---

## Standalone Binaries

Every push to `master` builds self-contained executables — no Bun or Node required:

- `busybase-linux-x64`
- `busybase-macos-arm64`
- `busybase-windows-x64.exe`

Download from [Releases](../../releases).

---

## Architecture

- **Storage:** [LanceDB](https://lancedb.com) — Apache Arrow columnar store, fully file-based, no server process
- **Auth:** bcrypt hashing via `Bun.password`, UUID session tokens with 7-day expiry
- **Vector search:** Native ANN via LanceDB — rows without vectors get a transparent dummy `[0]`
- **CLI = SDK = Server** — all share the same structures, CLI is the test runner
- **~160 lines** server + **~80 lines** SDK
