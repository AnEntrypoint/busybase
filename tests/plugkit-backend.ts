// Validates that busybase's embedded mode works with the plugkit backend.
// Mirrors the Supabase-shaped CRUD flow without needing an HTTP server.
import { createEmbedded, registerBackend } from "../src/embedded.ts";
import { createClient as plugkitCreateClient } from "libsql-plugkit-client";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;
function assert(cond: any, label: string) {
    if (cond) { passed++; console.log(`✓ ${label}`); }
    else { failed++; console.error(`✗ ${label}`); }
}

// busybase has a lazy plugkit backend that loads libsql-plugkit-client
// on first use. The npm-install link failed locally (Windows EPERM), so we register
// the dev path manually here to validate end-to-end:
registerBackend("plugkit", (cfg) => plugkitCreateClient({ url: cfg.url }) as any);

const dir = mkdtempSync(join(tmpdir(), "busybase-plugkit-test-"));
console.log(`temp dir: ${dir}`);

const db = await createEmbedded({ dir, backend: "plugkit", url: `file:${join(dir, "db.sqlite")}` });

// --- Auth flow ---
const signup = await db.auth.signUp({ email: "test@example.com", password: "Password123!" });
assert(signup.error === null, "signup returns no error");
assert(signup.data?.user?.email === "test@example.com", "signup returns user with email");

const signin = await db.auth.signInWithPassword({ email: "test@example.com", password: "Password123!" });
assert(signin.error === null, "signInWithPassword returns no error");
assert(signin.data?.session?.access_token, "signin returns access_token");

const u = await db.auth.getUser();
assert(u.data?.user?.email === "test@example.com", "getUser returns signed-in user");

// --- CRUD via from() ---
const ins = await db.from("notes").insert({ title: "first", body: "hello world" });
assert(ins.error === null, "insert returns no error");
assert(Array.isArray(ins.data) && ins.data[0]?.id, "insert returns row with generated id");

const ins2 = await db.from("notes").insert({ title: "second", body: "another note" });
assert(ins2.error === null, "second insert ok");

const all = await db.from("notes").select();
assert(all.error === null && all.data?.length === 2, "select returns 2 rows");

const filtered = await db.from("notes").select().eq("title", "first");
assert(filtered.error === null && filtered.data?.length === 1, "eq filter returns 1 row");
assert(filtered.data?.[0]?.body === "hello world", "filter row has correct body");

const like = await db.from("notes").select().like("body", "%note%");
assert(like.error === null && like.data?.length === 1, "like filter returns 1 row");

// --- UPDATE ---
const upd = await db.from("notes").update({ body: "updated body" }).eq("title", "first");
assert(upd.error === null, "update ok");
const after = await db.from("notes").select().eq("title", "first");
assert(after.data?.[0]?.body === "updated body", "update persisted");

// --- DELETE ---
const del = await db.from("notes").delete().eq("title", "second");
assert(del.error === null, "delete ok");
const remaining = await db.from("notes").select();
assert(remaining.data?.length === 1, "after delete: 1 row remains");

// --- Realtime / hooks plumbing (just verify subscribe doesn't throw) ---
let event: any = null;
const ch = db.channel("notes-changes").on("postgres_changes", { event: "*", table: "notes" }, p => { event = p; }).subscribe();
await db.from("notes").insert({ title: "third", body: "trigger realtime" });
await new Promise(r => setTimeout(r, 100));
assert(event !== null, "realtime fired on insert");
assert(event?.eventType === "INSERT", "realtime event type is INSERT");
ch.unsubscribe();

// --- Sign out ---
const signout = await db.auth.signOut();
assert(signout.error === null, "signOut ok");
const afterSignout = await db.auth.getUser();
assert(afterSignout.error?.message === "Not authenticated", "getUser after signOut returns 'Not authenticated'");

// --- Verify the snapshot file actually got written ---
const dbFile = join(dir, "db.sqlite");
await new Promise(r => setTimeout(r, 2000)); // wait for debounced snapshot
assert(existsSync(dbFile), `snapshot file written to ${dbFile}`);

console.log(`\n${passed} passed, ${failed} failed`);

try { rmSync(dir, { recursive: true, force: true }); } catch {}
process.exit(failed === 0 ? 0 : 1);
