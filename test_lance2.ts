import { connect } from "vectordb";
import { rmSync } from "node:fs";
try { rmSync("./tl2", { recursive: true }); } catch {}
const db = await connect("./tl2");

// Simulate _sessions table
const SENTINEL = "_sentinel_";
const t = await db.createTable("_sessions", [
  { token: SENTINEL, uid: "", exp: 0, vector: [0] }
]);
console.log("sessions table created");

// This is the call on line 37 of server.ts in ensureAuth
try {
  const r = await t.filter(`token != '${SENTINEL}'`).execute();
  console.log("filter sessions OK:", r);
} catch(e: any) { console.log("filter sessions FAILED:", e.message.slice(0,120)); }

// Simulate _users table
const u = await db.createTable("_users", [
  { id: SENTINEL, email: SENTINEL, pw: "", created: "", vector: [0] }
]);
console.log("users table created");

try {
  const r = await u.filter(`id != '${SENTINEL}'`).execute();
  console.log("filter users OK:", r);
} catch(e: any) { console.log("filter users FAILED:", e.message.slice(0,120)); }

// Now add a user and query
await u.add([{ id: "uuid-1", email: "a@b.com", pw: "hash", created: "2024", vector: [0] }]);
try {
  const r = await u.filter(`email = 'a@b.com'`).execute();
  console.log("filter by email OK:", r);
} catch(e: any) { console.log("filter by email FAILED:", e.message.slice(0,120)); }

try { rmSync("./tl2", { recursive: true }); } catch {}
