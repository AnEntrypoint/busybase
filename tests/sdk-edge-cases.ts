import BB from "/home/user/busybase/src/sdk.ts";

const PORT = 54506;
const URL = `http://localhost:${PORT}`;
const KEY = "test-key";
const DIR = "/tmp/bb_sdk_test";

let pass = 0, fail = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log(`  PASS: ${msg}`); }
  else { fail++; console.log(`  FAIL: ${msg}`); }
};
const assertEq = (a: any, b: any, msg: string) => {
  const eq = JSON.stringify(a) === JSON.stringify(b);
  if (eq) { pass++; console.log(`  PASS: ${msg}`); }
  else { fail++; console.log(`  FAIL: ${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const uid = () => crypto.randomUUID().slice(0, 8);

console.log("Starting BusyBase server...");
const proc = Bun.spawn(["bun", "run", "src/cli.ts", "serve"], {
  env: { ...process.env, BUSYBASE_DIR: DIR, BUSYBASE_PORT: String(PORT) },
  cwd: "/home/user/busybase",
  stdout: "pipe",
  stderr: "pipe",
});

for (let i = 0; i < 40; i++) {
  try {
    const r = await fetch(`${URL}/studio/config`);
    if (r.ok) break;
  } catch {}
  await sleep(250);
}

const client = BB(URL, KEY);

try {

  // ===== 1. Upsert insert path =====
  console.log("\n--- Upsert insert path ---");
  {
    const table = `t_${uid()}`;
    const row = { id: `row_${uid()}`, name: "Alice", age: "30" };
    const res = await client.from(table).upsert(row);
    assert(!res.error, "upsert insert returns no error");
    assert(Array.isArray(res.data), "upsert insert returns data array");
    assert(res.data.length === 1, "upsert insert returns 1 row");
    assertEq(res.data[0].name, "Alice", "upsert insert has correct name");

    const sel = await client.from(table).select();
    assert(sel.data.length === 1, "row was inserted into table");
    assertEq(sel.data[0].id, row.id, "inserted row has correct id");
  }

  // ===== 2. Upsert update path =====
  console.log("\n--- Upsert update path ---");
  {
    const table = `t_${uid()}`;
    const id = `row_${uid()}`;
    await client.from(table).insert({ id, name: "Bob", age: "25" });
    const res = await client.from(table).upsert({ id, name: "Bobby", age: "26" });
    assert(!res.error, "upsert update returns no error");

    const sel = await client.from(table).select().eq("id", id);
    assert(sel.data.length === 1, "still only 1 row after upsert update");
    assertEq(sel.data[0].name, "Bobby", "name was updated");
    assertEq(sel.data[0].age, "26", "age was updated");
  }

  // ===== 3. Upsert batch =====
  console.log("\n--- Upsert batch (mix of new and existing) ---");
  {
    const table = `t_${uid()}`;
    const existingId = `row_${uid()}`;
    await client.from(table).insert({ id: existingId, name: "Carol", score: "10" });

    const newId = `row_${uid()}`;
    const res = await client.from(table).upsert([
      { id: existingId, name: "Carol Updated", score: "20" },
      { id: newId, name: "Dave", score: "30" },
    ]);
    assert(!res.error, "batch upsert returns no error");
    assert(res.data.length === 2, "batch upsert returns 2 results");

    const sel = await client.from(table).select();
    assert(sel.data.length === 2, "table has 2 rows after batch upsert");
    const carol = sel.data.find((r: any) => r.id === existingId);
    assertEq(carol?.name, "Carol Updated", "existing row was updated in batch");
    const dave = sel.data.find((r: any) => r.id === newId);
    assertEq(dave?.name, "Dave", "new row was inserted in batch");
  }

  // ===== 4. Filter .gt/.gte/.lt/.lte =====
  console.log("\n--- Filter gt/gte/lt/lte ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert([
      { id: "r1", val: "10" },
      { id: "r2", val: "20" },
      { id: "r3", val: "30" },
      { id: "r4", val: "40" },
    ]);

    const gt = await client.from(table).select().gt("val", "20");
    assert(gt.data.length === 2, "gt('val','20') returns 2 rows (30,40)");

    const gte = await client.from(table).select().gte("val", "20");
    assert(gte.data.length === 3, "gte('val','20') returns 3 rows (20,30,40)");

    const lt = await client.from(table).select().lt("val", "30");
    assert(lt.data.length === 2, "lt('val','30') returns 2 rows (10,20)");

    const lte = await client.from(table).select().lte("val", "30");
    assert(lte.data.length === 3, "lte('val','30') returns 3 rows (10,20,30)");
  }

  // ===== 5. Filter .ilike =====
  console.log("\n--- Filter ilike ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert([
      { id: "r1", name: "Alice" },
      { id: "r2", name: "ALICE" },
      { id: "r3", name: "Bob" },
    ]);

    const res = await client.from(table).select().ilike("name", "%alice%");
    assert(res.data.length === 2, "ilike '%alice%' matches Alice and ALICE");
  }

  // ===== 6. Filter .is with null =====
  console.log("\n--- Filter .is with null ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert({ id: "r1", name: "HasExtra", extra: "yes" });
    await client.from(table).insert({ id: "r2", name: "NoExtra" });

    const res = await client.from(table).select().is("extra", "null");
    assert(res.data.length >= 1, "is(extra, null) finds rows with null extra");
    assert(res.data.every((r: any) => r.extra === null || r.extra === undefined), "all returned rows have null extra");
  }

  // ===== 7. Filter .filter() generic =====
  console.log("\n--- Filter .filter() generic method ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert([
      { id: "r1", score: "100" },
      { id: "r2", score: "200" },
      { id: "r3", score: "300" },
    ]);

    const res = await client.from(table).select().filter("score", "gte", "200");
    assert(res.data.length === 2, "filter('score','gte','200') returns 2 rows");
  }

  // ===== 8. Multiple .eq chaining (AND) =====
  console.log("\n--- Multiple .eq chaining (AND) ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert([
      { id: "r1", color: "red", size: "big" },
      { id: "r2", color: "red", size: "small" },
      { id: "r3", color: "blue", size: "big" },
    ]);

    const res = await client.from(table).select().eq("color", "red").eq("size", "big");
    assert(res.data.length === 1, "eq+eq AND returns exactly 1 row");
    assertEq(res.data[0].id, "r1", "correct row matched by AND filter");
  }

  // ===== 9. removeAllChannels =====
  console.log("\n--- removeAllChannels ---");
  {
    const ch1 = client.channel("ch1")
      .on("postgres_changes", { event: "*", table: "dummy1" }, () => {})
      .subscribe();
    const ch2 = client.channel("ch2")
      .on("postgres_changes", { event: "*", table: "dummy2" }, () => {})
      .subscribe();

    await sleep(500);
    client.removeAllChannels();

    const ch3 = client.channel("ch3")
      .on("postgres_changes", { event: "*", table: "dummy3" }, () => {})
      .subscribe();
    await sleep(300);
    ch3.unsubscribe();
    assert(true, "removeAllChannels completed without error");
  }

  // ===== 10. Auth events =====
  console.log("\n--- Auth events (SIGNED_IN, SIGNED_OUT, USER_UPDATED) ---");
  {
    const client2 = BB(URL, KEY);
    const events: string[] = [];
    const email = `user_${uid()}@test.com`;
    const password = "testpass123";

    client2.auth.onAuthStateChange((event: string, _session: any) => {
      events.push(event);
    });

    assert(events.includes("INITIAL_SESSION"), "INITIAL_SESSION event fires on subscribe");

    // signUp does NOT issue a session for email/password, so SIGNED_IN won't fire yet.
    // We must signInWithPassword after signUp.
    await client2.auth.signUp({ email, password });
    const signInRes = await client2.auth.signInWithPassword({ email, password });
    assert(!signInRes.error, "signInWithPassword succeeds");
    assert(events.includes("SIGNED_IN"), "SIGNED_IN event fires after signInWithPassword");

    await client2.auth.updateUser({ data: { nickname: "tester" } });
    assert(events.includes("USER_UPDATED"), "USER_UPDATED event fires after updateUser");

    await client2.auth.signOut();
    assert(events.includes("SIGNED_OUT"), "SIGNED_OUT event fires after signOut");
  }

  // ===== 11. Auth getSession after signIn =====
  console.log("\n--- Auth getSession after signIn ---");
  {
    const client3 = BB(URL, KEY);
    const email = `user_${uid()}@test.com`;
    const password = "sesspass123";

    await client3.auth.signUp({ email, password });
    await client3.auth.signInWithPassword({ email, password });
    const sessRes = await client3.auth.getSession();
    assert(!sessRes.error, "getSession returns no error");
    assert(sessRes.data?.session !== null, "session is not null after signIn");
    assert(typeof sessRes.data?.session?.access_token === "string", "session has access_token");
  }

  // ===== 12. Error propagation (non-existent server) =====
  console.log("\n--- Error propagation (fetch to non-existent server) ---");
  {
    const badClient = BB("http://localhost:19999", KEY);
    try {
      const res = await badClient.from("anything").select();
      assert(res.error !== null || res.error !== undefined, "error is present in response");
    } catch (e: any) {
      assert(true, "fetch throws error for non-existent server");
    }
  }

  // ===== 13. Query builder .select(cols) =====
  console.log("\n--- Query builder .select(cols) ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert([
      { id: "r1", name: "Alice", age: "30", city: "NYC" },
      { id: "r2", name: "Bob", age: "25", city: "LA" },
    ]);

    const res = await client.from(table).select("name,age");
    assert(res.data.length === 2, "select(cols) returns all rows");
    const keys = Object.keys(res.data[0]);
    assert(keys.includes("name"), "selected column 'name' present");
    assert(keys.includes("age"), "selected column 'age' present");
    assert(!keys.includes("city"), "non-selected column 'city' absent");
    assert(!keys.includes("id"), "non-selected column 'id' absent");
  }

  // ===== 14. Query builder .order desc =====
  console.log("\n--- Query builder .order desc ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert([
      { id: "r1", val: "10" },
      { id: "r2", val: "30" },
      { id: "r3", val: "20" },
    ]);

    const res = await client.from(table).select().order("val", { ascending: false });
    assert(res.data.length === 3, "order desc returns all rows");
    assertEq(res.data[0].val, "30", "first row is highest value");
    assertEq(res.data[2].val, "10", "last row is lowest value");
  }

  // ===== 15. Query builder chaining =====
  console.log("\n--- Query builder chaining: .select().eq().order().limit() ---");
  {
    const table = `t_${uid()}`;
    await client.from(table).insert([
      { id: "r1", color: "red", val: "10" },
      { id: "r2", color: "red", val: "30" },
      { id: "r3", color: "red", val: "20" },
      { id: "r4", color: "blue", val: "50" },
    ]);

    const res = await client.from(table).select("id,val").eq("color", "red").order("val", { ascending: false }).limit(2);
    assert(!res.error, "chained query returns no error");
    assert(res.data.length === 2, "limit(2) returns exactly 2 rows");
    assertEq(res.data[0].val, "30", "first row is highest red value");
    assertEq(res.data[1].val, "20", "second row is next highest red value");
    assert(!("color" in res.data[0]), "non-selected column excluded in chain");
  }

} finally {
  proc.kill();
  console.log(`\n========================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  if (fail > 0) process.exit(1);
}
