import BB from "/home/user/busybase/src/sdk.ts";

const PORT = 54522;
const URL = `http://localhost:${PORT}`;
const KEY = "test-key";
const DIR = "/tmp/bb_sdk_adv";

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

console.log("Starting BusyBase server on port 54522...");
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

try {

  // ===== 1. SDK auth.signIn() default keypair flow =====
  console.log("\n--- 1. SDK auth.signIn() default keypair flow ---");
  {
    const client = BB(URL, KEY);
    const res1 = await client.auth.signIn();
    assert(!res1.error, "keypair signIn returns no error");
    assert(res1.data !== null && res1.data !== undefined, "keypair signIn returns data");
    assert(res1.data?.user !== null && res1.data?.user !== undefined, "keypair signIn returns user");
    assert(res1.data?.session !== null && res1.data?.session !== undefined, "keypair signIn returns session");
    const userId1 = res1.data?.user?.id;

    // Call again — same keypair should give same user
    const res2 = await client.auth.signIn();
    assert(!res2.error, "second keypair signIn returns no error");
    assertEq(res2.data?.user?.id, userId1, "second signIn returns same user (same keypair)");
  }

  // ===== 2. SDK onAuthStateChange event tracking =====
  console.log("\n--- 2. SDK onAuthStateChange event tracking ---");
  {
    const client2 = BB(URL, KEY);
    const events: string[] = [];
    const email = `evt_${uid()}@test.com`;
    const password = "eventpass123";

    client2.auth.onAuthStateChange((event: string, _session: any) => {
      events.push(event);
    });

    assert(events.includes("INITIAL_SESSION"), "INITIAL_SESSION fires on subscribe");

    // signUp — session is null for email signup, so SIGNED_IN should NOT fire
    const signupRes = await client2.auth.signUp({ email, password });
    const signedInCountAfterSignup = events.filter(e => e === "SIGNED_IN").length;
    assert(signedInCountAfterSignup === 0, "signUp does NOT emit SIGNED_IN (session is null)");

    // signInWithPassword — should emit SIGNED_IN
    const signInRes = await client2.auth.signInWithPassword({ email, password });
    assert(!signInRes.error, "signInWithPassword succeeds");
    assert(events.includes("SIGNED_IN"), "SIGNED_IN fires after signInWithPassword");

    // updateUser — should emit USER_UPDATED
    await client2.auth.updateUser({ data: { nickname: "tester" } });
    assert(events.includes("USER_UPDATED"), "USER_UPDATED fires after updateUser");

    // signOut — should emit SIGNED_OUT
    await client2.auth.signOut();
    assert(events.includes("SIGNED_OUT"), "SIGNED_OUT fires after signOut");

    // Verify exact event sequence
    const expected = ["INITIAL_SESSION", "SIGNED_IN", "USER_UPDATED", "SIGNED_OUT"];
    assertEq(events, expected, "exact event sequence matches");
  }

  // ===== 3. SDK channel status callback =====
  console.log("\n--- 3. SDK channel status callback ---");
  {
    const client3 = BB(URL, KEY);
    let status: string | null = null;

    const ch = client3.channel("test-status")
      .on("postgres_changes", { event: "*", table: "dummy" }, () => {})
      .subscribe((s: string) => { status = s; });

    await sleep(1000);
    assertEq(status, "SUBSCRIBED", "channel subscribe callback receives SUBSCRIBED");
    ch.unsubscribe();
    await sleep(300);
  }

  // ===== 4. SDK from().delete() with no filter =====
  console.log("\n--- 4. SDK from().delete() with no filter ---");
  {
    const client4 = BB(URL, KEY);
    const table = `t_${uid()}`;
    await client4.from(table).insert({ id: "r1", name: "Alice" });

    // delete with no .eq() filter
    const res = await client4.from(table).delete();
    assert(res.error !== null && res.error !== undefined, "delete with no filter returns error");
    assert(
      typeof res.error === "string" ? res.error.includes("No filter") : res.error?.message?.includes("No filter"),
      "delete error message says 'No filter provided'"
    );
  }

  // ===== 5. SDK from().update() with no filter =====
  console.log("\n--- 5. SDK from().update() with no filter ---");
  {
    const client5 = BB(URL, KEY);
    const table = `t_${uid()}`;
    await client5.from(table).insert({ id: "r1", name: "Alice" });

    // update with no .eq() filter
    const res = await client5.from(table).update({ name: "x" });
    assert(res.error !== null && res.error !== undefined, "update with no filter returns error");
    assert(
      typeof res.error === "string" ? res.error.includes("No filter") : res.error?.message?.includes("No filter"),
      "update error message says 'No filter provided'"
    );
  }

  // ===== 6. SDK error wrapping (wrap function) =====
  console.log("\n--- 6. SDK error wrapping (wrap function) ---");
  {
    const client6 = BB(URL, KEY);
    const table = `t_${uid()}`;
    // Insert with an invalid column name containing special chars
    const res = await client6.from(table).insert({ "valid_col": "ok", "bad col!": "nope" });
    assert(res.error !== null && res.error !== undefined, "insert with invalid column returns error via wrap");
    // The wrap function normalizes: response should be {data, error} shape
    assert("data" in res && "error" in res, "error response has {data, error} shape from wrap");
  }

  // ===== 7. Filter edge cases via SDK =====
  console.log("\n--- 7. Filter edge cases via SDK ---");
  {
    const client7 = BB(URL, KEY);
    const table = `t_${uid()}`;
    await client7.from(table).insert([
      { id: "r1", name: "Alice", score: "100" },
      { id: "r2", name: "Bob", score: "200" },
      { id: "r3", name: "carol", score: "300" },
    ]);

    // .filter("name", "eq", "Alice") — same as .eq
    const filterEq = await client7.from(table).select().filter("name", "eq", "Alice");
    assert(filterEq.data.length === 1, ".filter('name','eq','Alice') returns 1 row");
    assertEq(filterEq.data[0].name, "Alice", ".filter eq returns correct row");

    // .is("score", "null") — IS NULL filter (no rows should match since all have scores)
    const isNull = await client7.from(table).select().is("score", "null");
    assert(isNull.data.length === 0, ".is('score','null') returns 0 rows (all have score)");

    // Insert a row with null score to test IS NULL
    await client7.from(table).insert({ id: "r4", name: "Dave" });
    const isNull2 = await client7.from(table).select().is("score", "null");
    assert(isNull2.data.length >= 1, ".is('score','null') finds rows with null score");

    // .is("score", "true") — test behavior (SQLite stores as text, may not match)
    const isTrue = await client7.from(table).select().is("score", "true");
    assert(Array.isArray(isTrue.data), ".is('score','true') returns array (no crash)");

    // .ilike("name", "%ali%") — case-insensitive match
    const ilikeRes = await client7.from(table).select().ilike("name", "%ali%");
    assert(ilikeRes.data.length >= 1, ".ilike('name','%ali%') finds Alice");
    assert(ilikeRes.data.some((r: any) => r.name === "Alice"), ".ilike match includes Alice");
  }

  // ===== 8. SDK query builder: select specific columns + chaining =====
  console.log("\n--- 8. SDK query builder: select specific columns + chaining ---");
  {
    const client8 = BB(URL, KEY);
    const table = `t_${uid()}`;
    await client8.from(table).insert([
      { id: "r1", name: "Alice", score: "300" },
      { id: "r2", name: "Bob", score: "100" },
      { id: "r3", name: "Alice", score: "200" },
      { id: "r4", name: "Carol", score: "400" },
    ]);

    const res = await client8.from(table).select("name,score")
      .eq("name", "Alice")
      .order("score", { ascending: false })
      .limit(1);

    assert(!res.error, "chained select+eq+order+limit returns no error");
    assert(res.data.length === 1, "limit(1) returns exactly 1 row");
    assertEq(res.data[0].name, "Alice", "correct row name");
    assertEq(res.data[0].score, "300", "correct row (highest score for Alice)");
    assert(!("id" in res.data[0]), "id column excluded when selecting name,score");
    const keys = Object.keys(res.data[0]);
    assert(keys.length === 2, "only 2 columns returned (name, score)");
  }

  // ===== 9. SDK from().select() returns count with Content-Range =====
  console.log("\n--- 9. SDK from().select() with count ---");
  {
    const client9 = BB(URL, KEY);
    const table = `t_${uid()}`;
    await client9.from(table).insert([
      { id: "r1", name: "Alice" },
      { id: "r2", name: "Bob" },
      { id: "r3", name: "Carol" },
    ]);

    const res = await client9.from(table).select("*").count("exact");
    assert(!res.error, "select with count returns no error");
    assert(res.count !== undefined, "response has .count field");
    assertEq(res.count, 3, "count is 3 for 3 rows");
  }

  // ===== 10. Multiple SDK instances sharing same server =====
  console.log("\n--- 10. Multiple SDK instances sharing same server ---");
  {
    const clientA = BB(URL, KEY);
    const clientB = BB(URL, KEY);

    const emailA = `multi_a_${uid()}@test.com`;
    const emailB = `multi_b_${uid()}@test.com`;
    const password = "multipass123";

    // Each signs up and signs in
    await clientA.auth.signUp({ email: emailA, password });
    await clientA.auth.signInWithPassword({ email: emailA, password });

    await clientB.auth.signUp({ email: emailB, password });
    await clientB.auth.signInWithPassword({ email: emailB, password });

    // Verify they have different sessions
    const sessA = await clientA.auth.getSession();
    const sessB = await clientB.auth.getSession();
    assert(sessA.data?.session !== null, "client A has a session");
    assert(sessB.data?.session !== null, "client B has a session");
    assert(
      sessA.data?.session?.access_token !== sessB.data?.session?.access_token,
      "client A and B have different access tokens"
    );

    // Each can CRUD independently
    const tableA = `multi_a_${uid()}`;
    const tableB = `multi_b_${uid()}`;

    await clientA.from(tableA).insert({ id: "a1", owner: "A", value: "100" });
    await clientB.from(tableB).insert({ id: "b1", owner: "B", value: "200" });

    const dataA = await clientA.from(tableA).select();
    assert(dataA.data.length === 1, "client A sees its own data");
    assertEq(dataA.data[0].owner, "A", "client A data is correct");

    const dataB = await clientB.from(tableB).select();
    assert(dataB.data.length === 1, "client B sees its own data");
    assertEq(dataB.data[0].owner, "B", "client B data is correct");

    // BusyBase has no RLS — both can read each other's tables
    const crossA = await clientB.from(tableA).select();
    assert(crossA.data.length === 1, "client B can read client A table (no RLS)");
    assertEq(crossA.data[0].owner, "A", "cross-read data is correct");

    // Inserting from B into A's table doesn't corrupt A's data
    await clientB.from(tableA).insert({ id: "b_in_a", owner: "B", value: "999" });
    const allInA = await clientA.from(tableA).select();
    assert(allInA.data.length === 2, "table A has 2 rows after B inserted");
    assert(allInA.data.some((r: any) => r.owner === "A"), "A original row still present");
    assert(allInA.data.some((r: any) => r.owner === "B"), "B inserted row present in A table");
  }

} finally {
  proc.kill();
  console.log(`\n========================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  if (fail > 0) process.exit(1);
}
