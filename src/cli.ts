#!/usr/bin/env bun
/**
 * BusyBase CLI — atomic commands using the SDK, serves as both tooling and test runner.
 * All commands share the same SDK client, proving the SDK works end-to-end.
 *
 * Usage:
 *   busybase serve                          Start the server
 *   busybase test                           Run full SDK test suite against live server
 *   busybase signup <email> <password>      Create a user
 *   busybase signin <email> <password>      Sign in, print token
 *   busybase insert <table> <json>          Insert row(s)
 *   busybase query <table> [filter...]      Query rows (filter: col=val)
 *   busybase update <table> <json> [filter] Update rows
 *   busybase delete <table> <col>=<val>     Delete rows
 *   busybase vec <table> <json-vec> [limit] Vector search
 */

import BB from "./sdk.ts";

const URL = process.env.BUSYBASE_URL || `http://localhost:${process.env.BUSYBASE_PORT || 54321}`;
const KEY = process.env.BUSYBASE_KEY || "local";

const [cmd, ...args] = process.argv.slice(2);

const db = BB(URL, KEY);

const print = (x: any) => console.log(JSON.stringify(x, null, 2));
const die = (msg: string) => { console.error("Error:", msg); process.exit(1); };

const parseFilter = (q: any, filters: string[]) => {
  for (const f of filters) {
    const [col, val] = f.split("=");
    q.eq(col, val);
  }
  return q;
};

if (cmd === "serve") {
  // Start the server inline
  await import("./server.ts");
  // Keep alive
}

else if (cmd === "signup") {
  const [email, password] = args;
  if (!email || !password) die("Usage: busybase signup <email> <password>");
  const r = await db.auth.signUp({ email, password });
  print(r);
}

else if (cmd === "signin") {
  const [email, password] = args;
  if (!email || !password) die("Usage: busybase signin <email> <password>");
  const r = await db.auth.signInWithPassword({ email, password });
  print(r);
}

else if (cmd === "user") {
  const r = await db.auth.getUser();
  print(r);
}

else if (cmd === "insert") {
  const [table, jsonStr] = args;
  if (!table || !jsonStr) die("Usage: busybase insert <table> <json>");
  const data = JSON.parse(jsonStr);
  const r = await db.from(table).insert(data);
  print(r);
}

else if (cmd === "query") {
  const [table, ...filters] = args;
  if (!table) die("Usage: busybase query <table> [col=val ...]");
  let q = db.from(table).select("*");
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
}

else if (cmd === "update") {
  const [table, jsonStr, ...filters] = args;
  if (!table || !jsonStr) die("Usage: busybase update <table> <json> [col=val ...]");
  const data = JSON.parse(jsonStr);
  let q = db.from(table).update(data);
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
}

else if (cmd === "delete") {
  const [table, ...filters] = args;
  if (!table || !filters.length) die("Usage: busybase delete <table> <col=val> ...");
  let q = db.from(table).delete();
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
}

else if (cmd === "vec") {
  const [table, vecStr, limitStr] = args;
  if (!table || !vecStr) die("Usage: busybase vec <table> <json-vec> [limit]");
  const vec = JSON.parse(vecStr);
  const limit = limitStr ? parseInt(limitStr) : 10;
  const r = await db.from(table).select("*").vec(vec, limit);
  print(r);
}

else if (cmd === "test") {
  // Full SDK test suite — this IS the e2e test, using the real SDK
  let pass = 0, fail = 0;
  const check = (name: string, ok: boolean, got?: any) => {
    if (ok) { console.log(`  ✓ ${name}`); pass++; }
    else { console.error(`  ✗ ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 120) : ""); fail++; }
  };

  console.log(`\nTesting against ${URL}\n`);

  // --- Keypair auth (anonymous-first) ---
  console.log("[auth.keypair — anonymous sign-in]");
  const kp1 = await db.auth.keypair.signIn();
  check("keypair signIn returns {data,error}", kp1.data !== undefined && "error" in kp1, kp1);
  check("keypair user.id exists", !!kp1.data?.user?.id, kp1.data?.user);
  check("keypair session.access_token", !!kp1.data?.session?.access_token, kp1.data?.session);
  check("keypair session.refresh_token", !!kp1.data?.session?.refresh_token, kp1.data?.session);
  check("keypair session.expires_at is number", typeof kp1.data?.session?.expires_at === "number", kp1.data?.session);

  console.log("\n[auth.keypair — same key = same user]");
  const exported = db.auth.keypair.export();
  const db2 = BB(URL, "local");
  const kp2 = await db2.auth.keypair.restore(exported.privkey!, exported.pubkey!);
  check("restore returns same user.id", kp2.data?.user?.id === kp1.data?.user?.id, { kp1: kp1.data?.user?.id, kp2: kp2.data?.user?.id });

  console.log("\n[auth.keypair — new keypair = new user]");
  const db3 = BB(URL, "local");
  const kp3 = await db3.auth.keypair.signIn();
  check("different keypair = different user", kp3.data?.user?.id !== kp1.data?.user?.id, { id1: kp1.data?.user?.id, id3: kp3.data?.user?.id });

  console.log("\n[keypair user — progressively add email]");
  // Sign in as kp1 user (has token in db)
  const dbKp = BB(URL, "local");
  await dbKp.auth.keypair.restore(exported.privkey!, exported.pubkey!);
  const upgr = await dbKp.auth.updateUser({ email: `keypair_${Date.now()}@test.com`, data: { name: "Anon" } });
  check("updateUser on keypair account works", !!upgr.data?.user?.email, upgr.data);
  check("metadata stored", upgr.data?.user?.user_metadata?.name === "Anon", upgr.data?.user);

  // Auth
  console.log("\n[auth.signUp]");
  const rawEmail = `Test_${Date.now()}@BB.com`; // test case normalization
  const su = await db.auth.signUp({ email: rawEmail, password: "pass123" });
  check("returns {data,error}", su.data !== undefined && "error" in su, su);
  check("data.user has id", !!su.data?.user?.id, su.data);
  check("email lowercased", su.data?.user?.email === rawEmail.toLowerCase(), su.data?.user);
  check("user has role=authenticated", su.data?.user?.role === "authenticated", su.data?.user);
  check("user has user_metadata", typeof su.data?.user?.user_metadata === "object", su.data?.user);
  check("user has app_metadata", typeof su.data?.user?.app_metadata === "object", su.data?.user);
  check("user has created_at", !!su.data?.user?.created_at, su.data?.user);
  const email = su.data?.user?.email;

  console.log("\n[auth.signInWithPassword]");
  const si = await db.auth.signInWithPassword({ email, password: "pass123" });
  check("returns {data,error}", si.data !== undefined && "error" in si, si);
  check("data.session.access_token", !!si.data?.session?.access_token, si.data);
  check("data.session.refresh_token", !!si.data?.session?.refresh_token, si.data?.session);
  check("data.session.expires_at is number", typeof si.data?.session?.expires_at === "number", si.data?.session);
  check("data.session.expires_in = 604800", si.data?.session?.expires_in === 604800, si.data?.session);
  check("data.user.email matches", si.data?.user?.email === email, si.data?.user);
  check("data.user.last_sign_in_at", !!si.data?.user?.last_sign_in_at, si.data?.user);

  console.log("\n[auth.signInWithPassword - bad creds]");
  const bad = await db.auth.signInWithPassword({ email, password: "wrong" });
  check("error on bad creds", !!bad.error, bad);

  console.log("\n[auth.getUser]");
  const gu = await db.auth.getUser();
  check("returns {data,error}", gu.data !== undefined && "error" in gu, gu);
  check("data.user.email matches", gu.data?.user?.email === email, gu.data);

  console.log("\n[auth.getSession]");
  const gs = await db.auth.getSession();
  check("returns {data,error}", gs.data !== undefined && "error" in gs, gs);
  check("data.session.access_token", !!gs.data?.session?.access_token, gs.data);
  check("data.session.refresh_token", !!gs.data?.session?.refresh_token, gs.data?.session);

  console.log("\n[auth.updateUser]");
  const uu = await db.auth.updateUser({ data: { name: "Alice" } });
  check("returns {data,error}", uu.data !== undefined && "error" in uu, uu);
  check("user_metadata updated", uu.data?.user?.user_metadata?.name === "Alice", uu.data?.user);

  console.log("\n[auth.onAuthStateChange]");
  let fired = false;
  const { data: { subscription } } = db.auth.onAuthStateChange((event, sess) => { fired = true; });
  await Bun.sleep(10);
  check("INITIAL_SESSION fires", fired);
  subscription.unsubscribe();

  // CRUD
  const tbl = `test_${Date.now()}`;
  console.log(`\n[from.insert — table: ${tbl}]`);
  const ins1 = await db.from(tbl).insert({ name: "Alice", score: "10" });
  check("returns {data,error}", ins1.data !== undefined && "error" in ins1, ins1);
  check("data[0].name = Alice", ins1.data?.[0]?.name === "Alice", ins1.data);

  const ins2 = await db.from(tbl).insert([{ name: "Bob", score: "20" }, { name: "Carol", score: "30" }]);
  check("batch insert data.length=2", ins2.data?.length === 2, ins2.data);

  console.log("\n[from.select]");
  const all = await db.from(tbl).select("*");
  check("returns {data,error}", all.data !== undefined && "error" in all, all);
  check("data.length=3", all.data?.length === 3, all.data);

  console.log("\n[filters]");
  const feq = await db.from(tbl).select("*").eq("name", "Alice");
  check(".eq — 1 row", feq.data?.length === 1, feq.data);

  const fneq = await db.from(tbl).select("*").neq("name", "Alice");
  check(".neq — 2 rows", fneq.data?.length === 2, fneq.data);

  const fin = await db.from(tbl).select("*").in("name", ["Alice", "Bob"]);
  check(".in — 2 rows", fin.data?.length === 2, fin.data);

  const flike = await db.from(tbl).select("*").like("name", "Ali");
  check(".like — 1 row", flike.data?.length === 1, flike.data);

  const for_ = await db.from(tbl).select("*").or("name.eq.Alice,name.eq.Bob");
  check(".or — 2 rows", for_.data?.length === 2, for_.data);

  const fnot = await db.from(tbl).select("*").not("name", "eq", "Alice");
  check(".not — 2 rows", fnot.data?.length === 2, fnot.data);

  console.log("\n[modifiers]");
  const ord = await db.from(tbl).select("*").order("name", { ascending: true });
  check(".order asc — first=Alice", ord.data?.[0]?.name === "Alice", ord.data);

  const lim = await db.from(tbl).select("*").limit(2);
  check(".limit(2) — 2 rows", lim.data?.length === 2, lim.data);

  const off = await db.from(tbl).select("*").order("name", { ascending: true }).offset(1).limit(1);
  check(".offset(1) — Bob", off.data?.[0]?.name === "Bob", off.data);

  const rng = await db.from(tbl).select("*").order("name", { ascending: true }).range(0, 1);
  check(".range(0,1) — 2 rows", rng.data?.length === 2, rng.data);

  const cnt = await db.from(tbl).select("*").count("exact");
  check(".count — count=3", cnt.count === 3, cnt);

  const sng = await db.from(tbl).select("*").eq("name", "Alice").single();
  check(".single() — returns object", !Array.isArray(sng.data) && sng.data?.name === "Alice", sng.data);

  const ms = await db.from(tbl).select("*").eq("name", "Nobody").maybeSingle();
  check(".maybeSingle() — null if no rows", ms.data === null && !ms.error, ms);

  const sel = await db.from(tbl).select("name");
  check(".select(cols) — only name key", sel.data?.[0] && Object.keys(sel.data[0]).length === 1, sel.data?.[0]);

  console.log("\n[update + delete]");
  const upd = await db.from(tbl).update({ score: "99" }).eq("name", "Alice");
  check(".update.eq — score=99", upd.data?.[0]?.score === "99", upd.data);

  const del = await db.from(tbl).delete().eq("name", "Carol");
  check(".delete.eq — ok", !del.error, del);
  const afterDel = await db.from(tbl).select("*");
  check("2 rows remain after delete", afterDel.data?.length === 2, afterDel.data);

  console.log("\n[vector search]");
  const vtbl = `vec_${Date.now()}`;
  await db.from(vtbl).insert([
    { label: "cat", vector: [1, 0, 0, 0] },
    { label: "dog", vector: [0, 1, 0, 0] },
    { label: "fish", vector: [0, 0, 1, 0] },
  ]);
  const vs = await db.from(vtbl).select("*").vec([1, 0, 0, 0], 2);
  check("vec top result = cat", vs.data?.[0]?.label === "cat", vs.data);
  check("vec has _distance", typeof vs.data?.[0]?._distance === "number", vs.data?.[0]);
  check("vec limit=2", vs.data?.length === 2, vs.data);

  // Prefer: return=minimal
  console.log("\n[Prefer: return=minimal]");
  const minRes = await globalThis.fetch(`${URL}/rest/v1/${tbl}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ name: "Dave", score: "5" }),
  });
  check("POST return=minimal → 204", minRes.status === 204, minRes.status);

  // Content-Range header
  console.log("\n[Content-Range header]");
  const crRes = await globalThis.fetch(`${URL}/rest/v1/${tbl}?count=exact`);
  check("Content-Range header present", crRes.headers.has("content-range"), crRes.headers.get("content-range"));

  console.log("\n[auth.signOut]");
  await db.auth.signOut();
  const afterOut = await db.auth.getUser();
  check("getUser after signOut = error", !!afterOut.error, afterOut);

  // setSession stub
  console.log("\n[auth.setSession]");
  const ss = await db.auth.setSession({ access_token: "fake", refresh_token: "fake" });
  check("setSession returns {data,error}", ss.data !== undefined && "error" in ss, ss);

  // resetPasswordForEmail stub
  const rpf = await db.auth.resetPasswordForEmail("anyone@example.com");
  check("resetPasswordForEmail stub ok", !rpf.error, rpf);

  console.log(`\n${"=".repeat(40)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

else {
  console.log(`BusyBase CLI

Commands:
  serve                            Start the server
  test                             Run full SDK test suite
  signup <email> <pass>            Register user
  signin <email> <pass>            Sign in
  user                             Get current user
  insert <table> <json>            Insert row(s)
  query <table> [col=val ...]      Query with filters
  update <table> <json> [col=val]  Update rows
  delete <table> <col=val> ...     Delete rows
  vec <table> <[...vec]> [limit]   Vector search

Environment:
  BUSYBASE_URL   Server URL (default: http://localhost:54321)
  BUSYBASE_KEY   API key (default: local)
  BUSYBASE_DIR   Data dir for 'serve' (default: busybase_data)
  BUSYBASE_PORT  Port for 'serve' (default: 54321)
`);
}
