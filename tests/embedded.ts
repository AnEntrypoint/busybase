import { createEmbedded } from "../src/embedded.ts";
import type { Hooks } from "../src/hooks.ts";

const DIR = `/tmp/bb_embedded_test_${Date.now()}`;
let passed = 0, failed = 0;

const assert = (cond: boolean, msg: string) => {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

const section = (name: string) => console.log(`\n=== ${name} ===`);

// Main test suite (no hooks)
const bb = await createEmbedded({ dir: DIR });

// ──────────────────────────────────────────
section("Table auto-creation & single insert");
{
  const { data, error } = await bb.from("items").insert({ name: "apple", qty: "5" });
  assert(!error, "insert single row no error");
  assert(data?.length === 1, "insert returns 1 row");
  assert(data[0].name === "apple", "inserted row has correct name");
  assert(!!data[0].id, "auto-generated id present");
}

// ──────────────────────────────────────────
section("Batch insert");
{
  const { data, error } = await bb.from("items").insert([
    { name: "banana", qty: "3" },
    { name: "cherry", qty: "10" },
    { name: "date", qty: "7" },
  ]);
  assert(!error, "batch insert no error");
  assert(data?.length === 3, "batch insert returns 3 rows");
}

// ──────────────────────────────────────────
section("Select all");
{
  const { data, error } = await bb.from("items").select();
  assert(!error, "select all no error");
  assert(data?.length === 4, "select all returns 4 rows");
}

// ──────────────────────────────────────────
section("Column auto-creation");
{
  const { data, error } = await bb.from("items").insert({ name: "elderberry", qty: "2", color: "purple" });
  assert(!error, "insert with new column no error");
  const { data: rows } = await bb.from("items").select().eq("name", "elderberry");
  assert(rows?.[0]?.color === "purple", "new column value readable");
}

// ──────────────────────────────────────────
section("Filters: eq, neq, like, gt, lt");
{
  const { data: eqD } = await bb.from("items").select().eq("name", "apple");
  assert(eqD?.length === 1 && eqD[0].name === "apple", ".eq filter works");

  const { data: neqD } = await bb.from("items").select().neq("name", "apple");
  assert(neqD!.length >= 3, ".neq filter works");

  const { data: likeD } = await bb.from("items").select().like("name", "%an%");
  assert(likeD!.some((r: any) => r.name === "banana"), ".like filter works");

  // SQLite compares TEXT lexicographically, so use numeric-friendly values
  const { data: gtD } = await bb.from("items").select().gt("qty", "5");
  assert(gtD!.length > 0, ".gt filter returns rows");

  const { data: ltD } = await bb.from("items").select().lt("qty", "5");
  assert(ltD!.length > 0, ".lt filter returns rows");
}

// ──────────────────────────────────────────
section("Filters: in, or, not, ilike");
{
  const { data: inD } = await bb.from("items").select().in("name", ["apple", "banana"]);
  assert(inD?.length === 2, ".in filter works");

  const { data: orD } = await bb.from("items").select().or("name.eq.apple,name.eq.cherry");
  assert(orD?.length === 2, ".or filter works");

  const { data: notD } = await bb.from("items").select().not("name", "eq", "apple");
  assert(notD!.every((r: any) => r.name !== "apple"), ".not filter works");

  const { data: ilikeD } = await bb.from("items").select().ilike("name", "%APPLE%");
  assert(ilikeD?.length === 1 && ilikeD[0].name === "apple", ".ilike filter works");
}

// ──────────────────────────────────────────
section("Modifiers: order, limit, offset, range, count, single, maybeSingle, select(cols)");
{
  const { data: ordD } = await bb.from("items").select().order("name", { ascending: true }).limit(2);
  assert(ordD?.length === 2, ".order + .limit works");
  assert(ordD[0].name <= ordD[1].name, ".order ascending correct");

  const { data: descD } = await bb.from("items").select().order("name", { ascending: false }).limit(2);
  assert(descD[0].name >= descD[1].name, ".order descending correct");

  const { data: offD } = await bb.from("items").select().order("name").offset(2).limit(2);
  assert(offD?.length === 2, ".offset works");

  const { data: rangeD } = await bb.from("items").select().order("name").range(0, 1);
  assert(rangeD?.length === 2, ".range(0,1) returns 2 rows");

  const { data: countD, count } = await bb.from("items").select().count("exact");
  assert(typeof count === "number" && count >= 5, ".count returns numeric count");

  const { data: singleD, error: singleE } = await bb.from("items").select().eq("name", "apple").single();
  assert(!singleE && singleD?.name === "apple", ".single returns object");

  const { data: singleFail, error: singleFailE } = await bb.from("items").select().eq("name", "nonexistent").single();
  assert(!!singleFailE, ".single with no rows returns error");

  const { data: maybeD } = await bb.from("items").select().eq("name", "nonexistent").maybeSingle();
  assert(maybeD === null, ".maybeSingle with no rows returns null");

  const { data: maybeD2 } = await bb.from("items").select().eq("name", "apple").maybeSingle();
  assert(maybeD2?.name === "apple", ".maybeSingle with row returns object");

  const { data: selD } = await bb.from("items").select("name,qty").eq("name", "apple");
  assert(selD?.[0]?.name === "apple" && !("id" in selD[0]), ".select(cols) limits columns");
}

// ──────────────────────────────────────────
section("Update with filter");
{
  const { data, error } = await bb.from("items").update({ qty: "99" }).eq("name", "apple");
  assert(!error, "update no error");
  assert(data?.[0]?.qty === "99", "update returns updated row");

  const { data: verify } = await bb.from("items").select().eq("name", "apple");
  assert(verify?.[0]?.qty === "99", "update persisted");
}

// ──────────────────────────────────────────
section("Delete with filter");
{
  const { data: before } = await bb.from("items").select();
  const beforeCount = before!.length;
  const { error } = await bb.from("items").delete().eq("name", "elderberry");
  assert(!error, "delete no error");
  const { data: after } = await bb.from("items").select();
  assert(after!.length === beforeCount - 1, "delete removed row");
}

// ──────────────────────────────────────────
section("Null value handling");
{
  const { data, error } = await bb.from("nulltest").insert({ name: "withNull", value: null });
  assert(!error, "insert null value no error");
  const { data: rows } = await bb.from("nulltest").select().eq("name", "withNull");
  assert(rows?.[0]?.value === null, "null value preserved on read");
}

// ──────────────────────────────────────────
section("Upsert: insert path (new row)");
{
  const newId = crypto.randomUUID();
  const { data, error } = await bb.from("upserttest").upsert({ id: newId, name: "new", val: "1" });
  assert(!error, "upsert insert path no error");
  assert(data?.some((r: any) => r.id === newId), "upsert created new row");
}

section("Upsert: update path (existing row)");
{
  const { data: existing } = await bb.from("upserttest").select();
  const row = existing![0];
  const { data, error } = await bb.from("upserttest").upsert({ id: row.id, name: "updated", val: "2" });
  assert(!error, "upsert update path no error");
  assert(data?.some((r: any) => r.name === "updated"), "upsert updated existing row");
}

// ──────────────────────────────────────────
section("Auth: signUp");
{
  const { data, error } = await bb.auth.signUp({ email: "test@example.com", password: "pass1234", options: { data: { role: "admin" } } });
  assert(!error, "signUp no error");
  assert(data?.user?.email === "test@example.com", "signUp returns user with email");
  assert(data?.user?.user_metadata?.role === "admin", "signUp stores user_metadata");
}

section("Auth: duplicate email signup -> error");
{
  const { error } = await bb.auth.signUp({ email: "test@example.com", password: "otherpass" });
  assert(!!error, "duplicate signup returns error");
}

section("Auth: signInWithPassword");
{
  const { data, error } = await bb.auth.signInWithPassword({ email: "test@example.com", password: "pass1234" });
  assert(!error, "signIn no error");
  assert(!!data?.session?.access_token, "signIn returns session with access_token");
  assert(data?.user?.email === "test@example.com", "signIn returns correct user");
}

section("Auth: bad password signin -> error");
{
  const { error } = await bb.auth.signInWithPassword({ email: "test@example.com", password: "wrongpassword" });
  assert(!!error, "bad password returns error");
}

section("Auth: getUser");
{
  const { data, error } = await bb.auth.getUser();
  assert(!error, "getUser no error");
  assert(data?.user?.email === "test@example.com", "getUser returns correct user");
}

section("Auth: getSession");
{
  const { data, error } = await bb.auth.getSession();
  assert(!error, "getSession no error");
  assert(!!data?.session?.access_token, "getSession returns session");
}

section("Auth: updateUser (metadata)");
{
  const { data, error } = await bb.auth.updateUser({ data: { theme: "dark" } });
  assert(!error, "updateUser no error");
  assert(data?.user?.user_metadata?.theme === "dark", "updateUser merges metadata");
  assert(data?.user?.user_metadata?.role === "admin", "updateUser preserves existing metadata");
}

section("Auth: onAuthStateChange");
{
  const events: string[] = [];
  const { data: { subscription } } = bb.auth.onAuthStateChange((event: string, _session: any) => {
    events.push(event);
  });
  assert(events.includes("INITIAL_SESSION"), "onAuthStateChange fires INITIAL_SESSION");
  subscription.unsubscribe();
}

section("Auth: signOut");
{
  const { error } = await bb.auth.signOut();
  assert(!error, "signOut no error");
  const { error: getErr } = await bb.auth.getUser();
  assert(!!getErr, "getUser after signOut returns error");
  const { data: sessData } = await bb.auth.getSession();
  assert(sessData?.session === null, "getSession after signOut returns null");
}

section("Auth: onAuthStateChange tracks signOut");
{
  await bb.auth.signInWithPassword({ email: "test@example.com", password: "pass1234" });
  const events: string[] = [];
  const { data: { subscription } } = bb.auth.onAuthStateChange((event: string) => {
    events.push(event);
  });
  await bb.auth.signOut();
  assert(events.includes("SIGNED_OUT"), "onAuthStateChange captures SIGNED_OUT");
  subscription.unsubscribe();
}

// ──────────────────────────────────────────
section("Channels / Realtime");
{
  const received: any[] = [];
  const ch = bb.channel("test-chan")
    .on("postgres_changes", { event: "*", table: "rtitems" }, (payload: any) => {
      received.push(payload);
    })
    .subscribe();

  await new Promise(r => setTimeout(r, 50));

  await bb.from("rtitems").insert({ name: "rt1" });
  await new Promise(r => setTimeout(r, 50));
  assert(received.some(p => p.eventType === "INSERT" && p.new?.name === "rt1"), "realtime receives INSERT event");

  await bb.from("rtitems").update({ name: "rt1_updated" }).eq("name", "rt1");
  await new Promise(r => setTimeout(r, 50));
  assert(received.some(p => p.eventType === "UPDATE" && p.new?.name === "rt1_updated"), "realtime receives UPDATE event");

  await bb.from("rtitems").delete().eq("name", "rt1_updated");
  await new Promise(r => setTimeout(r, 50));
  assert(received.some(p => p.eventType === "DELETE"), "realtime receives DELETE event");

  ch.unsubscribe();
}

// ──────────────────────────────────────────
section("Hooks: beforeInsert that aborts");
{
  const hooksBB = await createEmbedded({
    dir: `${DIR}_hooks`,
    hooks: {
      beforeInsert: (table: string, rows: any[]) => {
        if (table === "blocked") return { error: "insert blocked by hook" };
      },
    } as Hooks,
  });

  const { error } = await hooksBB.from("blocked").insert({ name: "should_fail" });
  assert(!!error && error.message.includes("blocked"), "beforeInsert hook aborts insert");

  const { error: okErr } = await hooksBB.from("allowed").insert({ name: "should_pass" });
  assert(!okErr, "beforeInsert hook allows other tables");
}

section("Hooks: canAccess that denies");
{
  const hooksBB = await createEmbedded({
    dir: `${DIR}_hooks_access`,
    hooks: {
      canAccess: ({ table, method }: any) => {
        if (table === "secret") return { error: "Access denied to secret table" };
      },
    } as Hooks,
  });

  await hooksBB.from("public").insert({ name: "ok" });
  const { data } = await hooksBB.from("public").select();
  assert(data?.length === 1, "canAccess allows public table");

  const { error: selErr } = await hooksBB.from("secret").select();
  assert(!!selErr, "canAccess denies select on secret table");
}

section("Hooks: afterSelect that transforms");
{
  const hooksBB = await createEmbedded({
    dir: `${DIR}_hooks_transform`,
    hooks: {
      afterSelect: (rows: any[], table: string) => {
        if (table === "transformed") return rows.map((r: any) => ({ ...r, extra: "injected" }));
        return rows;
      },
    } as Hooks,
  });

  await hooksBB.from("transformed").insert({ name: "x" });
  const { data } = await hooksBB.from("transformed").select();
  assert(data?.[0]?.extra === "injected", "afterSelect hook transforms rows");
}

// ──────────────────────────────────────────
// Summary
console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}`);

if (failed > 0) process.exit(1);
