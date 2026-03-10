# BusyBase

A drop-in headless Supabase alternative — minimal, self-hosted, no Docker required.

Built on [Bun](https://bun.sh) + [LanceDB](https://lancedb.com) (file-based vector database). Single process, no external services, supports **vector search** natively.

## Quick Start

```sh
# Run directly with Bun
bunx busybase

# Or download a standalone binary from Releases (no Bun required)
./busybase-linux-x64
```

Server starts on `http://localhost:54321` by default.

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `BUSYBASE_PORT` | `54321` | HTTP port |
| `BUSYBASE_DIR` | `busybase_data` | Data directory |

---

## Client SDK

```js
import BB from "busybase";

const db = BB("http://localhost:54321", "your-api-key");
```

Mirrors the [Supabase JS client](https://supabase.com/docs/reference/javascript) API.

---

## Auth

```js
await db.auth.signUp("user@example.com", "password");
await db.auth.signIn("user@example.com", "password");
const user = await db.auth.getUser();
await db.auth.signOut();
```

---

## Database (CRUD)

```js
// Insert (auto-creates table on first insert)
await db.from("todos").insert({ title: "Buy milk", done: false });
await db.from("todos").insert([
  { title: "Read book", done: true },
  { title: "Exercise", done: false },
]);

// Query
const todos = await db.from("todos")
  .select("title,done")
  .eq("done", false)
  .order("title", { ascending: true })
  .limit(10);

// Update
await db.from("todos").update({ done: true }).eq("title", "Buy milk");

// Delete
await db.from("todos").delete().eq("title", "Buy milk");
```

### Filter operators

| Method | SQL equivalent |
|---|---|
| `.eq(col, val)` | `col = val` |
| `.neq(col, val)` | `col != val` |
| `.gt(col, val)` | `col > val` |
| `.gte(col, val)` | `col >= val` |
| `.lt(col, val)` | `col < val` |
| `.lte(col, val)` | `col <= val` |
| `.like(col, val)` | `col LIKE '%val%'` |
| `.ilike(col, val)` | case-insensitive LIKE |

---

## Vector Search

Store embeddings alongside your data, query by similarity:

```js
// Insert rows with a `vector` field
await db.from("docs").insert([
  { title: "Cats article", vector: [0.9, 0.1, 0.0] },
  { title: "Dogs article", vector: [0.1, 0.9, 0.0] },
  { title: "Fish article", vector: [0.0, 0.0, 1.0] },
]);

// Search — returns rows sorted by similarity with `_distance`
const results = await db.from("docs").select("*").vec([0.85, 0.15, 0.0], 5);
// results[0].title === "Cats article"
// results[0]._distance === 0.03...

// Combine with filters
const results = await db.from("docs")
  .vec([0.85, 0.15, 0.0], 10)
  .eq("published", "true");
```

Generate vectors externally (OpenAI, local models, etc.) and pass them in — BusyBase stores and searches them.

---

## REST API

Plain HTTP — compatible with Supabase's REST interface:

| Method | Path | Description |
|---|---|---|
| `GET` | `/rest/v1/:table` | Query rows |
| `POST` | `/rest/v1/:table` | Insert rows |
| `PATCH` | `/rest/v1/:table?eq.col=val` | Update rows |
| `DELETE` | `/rest/v1/:table?eq.col=val` | Delete rows |
| `POST` | `/auth/v1/signup` | Register |
| `POST` | `/auth/v1/token` | Sign in |
| `GET` | `/auth/v1/user` | Current user |
| `POST` | `/auth/v1/logout` | Sign out |

Vector search via HTTP:
```
GET /rest/v1/docs?vec=[0.85,0.15,0.0]&limit=5
```

---

## Standalone Binaries

Every push to `master` builds self-contained executables — no Bun or Node required:

- `busybase-linux-x64`
- `busybase-macos-arm64`
- `busybase-windows-x64.exe`

Download from [Releases](../../releases).

---

## Architecture

- **Storage:** [LanceDB](https://lancedb.com) — Apache Arrow columnar store, fully file-based, no server process needed
- **Auth:** bcrypt hashing via `Bun.password`, UUID session tokens with 7-day expiry
- **Vector search:** Native ANN via LanceDB, non-vector rows use a transparent dummy vector
- **~130 lines** of server code, zero mandatory config
