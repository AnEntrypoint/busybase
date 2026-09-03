// Comprehensive hooks integration tests for BusyBase
// Uses createEmbedded with hooks passed in config

import { createEmbedded } from "../src/embedded.ts";

let pass = 0;
let fail = 0;
const errors: string[] = [];

function assert(condition: boolean, name: string) {
  if (condition) {
    pass++;
    console.log(`  PASS: ${name}`);
  } else {
    fail++;
    errors.push(name);
    console.log(`  FAIL: ${name}`);
  }
}

const uid = () => Math.random().toString(36).slice(2, 10);

// ============================================================
// 1. fireHook abort: beforeInsert returning {error: "blocked"}
// ============================================================
async function testFireHookAbort() {
  console.log("\n--- fireHook abort (beforeInsert returns {error}) ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeInsert: (_table: string, _rows: any[]) => {
        return { error: "blocked" };
      },
    },
  });

  const res = await client.from("items").insert({ name: "test" });
  assert(res.error !== null, "insert should fail");
  assert(res.error?.message === "blocked", "error message should be 'blocked'");

  // Verify nothing was written
  const sel = await client.from("items").select();
  assert(sel.data?.length === 0 || sel.data === null, "no rows should exist");
}

// ============================================================
// 2. fireHook false: canAccess returning false
// ============================================================
async function testFireHookFalse() {
  console.log("\n--- fireHook false (canAccess returns false) ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      canAccess: (_opts: any) => {
        return false;
      },
    },
  });

  const res = await client.from("items").select();
  assert(res.error !== null, "select should fail");
  assert(res.error?.message === "Access denied", "error should be 'Access denied'");
}

// ============================================================
// 3. fireHook exception: hook that throws
// ============================================================
async function testFireHookException() {
  console.log("\n--- fireHook exception (hook throws) ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeInsert: (_table: string, _rows: any[]) => {
        throw new Error("hook exploded");
      },
    },
  });

  const res = await client.from("items").insert({ name: "test" });
  assert(res.error !== null, "insert should fail");
  assert(res.error?.message === "hook exploded", "error message should be 'hook exploded'");
}

// ============================================================
// 4. fireHook void: hook returning undefined -> proceeds
// ============================================================
async function testFireHookVoid() {
  console.log("\n--- fireHook void (hook returns undefined) ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeInsert: (_table: string, _rows: any[]) => {
        // returns undefined
      },
    },
  });

  const res = await client.from("items").insert({ name: "hello" });
  assert(res.error === null, "insert should succeed");
  assert(res.data?.length === 1, "one row returned");
  assert(res.data?.[0]?.name === "hello", "row has correct name");
}

// ============================================================
// 5. pipeHook transform: afterSelect adds computed field
// ============================================================
async function testPipeHookTransform() {
  console.log("\n--- pipeHook transform (afterSelect adds field) ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      afterSelect: (rows: any[], _table: string) => {
        return rows.map((r: any) => ({ ...r, computed: "yes" }));
      },
    },
  });

  await client.from("items").insert({ name: "a" });
  const res = await client.from("items").select();
  assert(res.error === null, "select should succeed");
  assert(res.data?.[0]?.computed === "yes", "computed field should be added");
}

// ============================================================
// 6. pipeHook passthrough: afterSelect returning undefined
// ============================================================
async function testPipeHookPassthrough() {
  console.log("\n--- pipeHook passthrough (afterSelect returns undefined) ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      afterSelect: (_rows: any[], _table: string) => {
        // returns undefined
      },
    },
  });

  await client.from("items").insert({ name: "b" });
  const res = await client.from("items").select();
  assert(res.error === null, "select should succeed");
  assert(res.data?.[0]?.name === "b", "original data passed through");
}

// ============================================================
// 7. beforeInsert: fires before insert, can block
// ============================================================
async function testBeforeInsert() {
  console.log("\n--- beforeInsert fires and can block ---");
  let hookCalled = false;
  let hookTable = "";
  let hookRows: any[] = [];

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeInsert: (table: string, rows: any[]) => {
        hookCalled = true;
        hookTable = table;
        hookRows = rows;
        if (table === "blocked_table") return { error: "this table is blocked" };
      },
    },
  });

  // Allowed insert
  const res1 = await client.from("allowed").insert({ val: "ok" });
  assert(hookCalled, "beforeInsert was called");
  assert(hookTable === "allowed", "hook received correct table name");
  assert(hookRows.length === 1, "hook received rows");
  assert(res1.error === null, "allowed insert succeeds");

  // Blocked insert
  const res2 = await client.from("blocked_table").insert({ val: "nope" });
  assert(res2.error !== null, "blocked insert fails");
  assert(res2.error?.message === "this table is blocked", "correct block message");
}

// ============================================================
// 8. afterInsert: fires after insert, can transform
// ============================================================
async function testAfterInsert() {
  console.log("\n--- afterInsert fires and can transform ---");
  let hookCalled = false;

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      afterInsert: (rows: any[], table: string) => {
        hookCalled = true;
        return rows.map((r: any) => ({ ...r, tag: `from_${table}` }));
      },
    },
  });

  const res = await client.from("things").insert({ name: "widget" });
  assert(hookCalled, "afterInsert was called");
  assert(res.error === null, "insert succeeds");
  assert(res.data?.[0]?.tag === "from_things", "afterInsert transform applied");
}

// ============================================================
// 9. beforeUpdate: fires before update, can block
// ============================================================
async function testBeforeUpdate() {
  console.log("\n--- beforeUpdate fires and can block ---");
  let hookCalled = false;

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeUpdate: (table: string, _rows: any[], changes: any) => {
        hookCalled = true;
        if (changes.status === "forbidden") return { error: "cannot set forbidden status" };
      },
    },
  });

  const ins = await client.from("tasks").insert({ id: "t1", name: "task1", status: "open" });
  assert(ins.error === null, "setup insert succeeds");

  // Allowed update
  const res1 = await client.from("tasks").update({ status: "closed" }).eq("id", "t1");
  assert(hookCalled, "beforeUpdate was called");
  assert(res1.error === null, "allowed update succeeds");

  // Blocked update
  const res2 = await client.from("tasks").update({ status: "forbidden" }).eq("id", "t1");
  assert(res2.error !== null, "blocked update fails");
  assert(res2.error?.message === "cannot set forbidden status", "correct block message");
}

// ============================================================
// 10. afterUpdate: fires after update, can transform
// ============================================================
async function testAfterUpdate() {
  console.log("\n--- afterUpdate fires and can transform ---");
  let hookCalled = false;

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      afterUpdate: (rows: any[], _table: string) => {
        hookCalled = true;
        return rows.map((r: any) => ({ ...r, updated_flag: "true" }));
      },
    },
  });

  await client.from("records").insert({ id: "r1", val: "old" });
  const res = await client.from("records").update({ val: "new" }).eq("id", "r1");
  assert(hookCalled, "afterUpdate was called");
  assert(res.error === null, "update succeeds");
  assert(res.data?.[0]?.updated_flag === "true", "afterUpdate transform applied");
}

// ============================================================
// 11. beforeDelete: fires before delete, can block
// ============================================================
async function testBeforeDelete() {
  console.log("\n--- beforeDelete fires and can block ---");
  let hookCalled = false;

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeDelete: (table: string, rows: any[]) => {
        hookCalled = true;
        if (rows.some((r: any) => r.protected === "true")) return { error: "cannot delete protected rows" };
      },
    },
  });

  await client.from("docs").insert({ id: "d1", name: "normal", protected: "false" });
  await client.from("docs").insert({ id: "d2", name: "safe", protected: "true" });

  // Allowed delete
  const res1 = await client.from("docs").delete().eq("id", "d1");
  assert(hookCalled, "beforeDelete was called");
  assert(res1.error === null, "allowed delete succeeds");

  // Blocked delete
  const res2 = await client.from("docs").delete().eq("id", "d2");
  assert(res2.error !== null, "blocked delete fails");
  assert(res2.error?.message === "cannot delete protected rows", "correct block message");
}

// ============================================================
// 12. afterDelete: fires after delete
// ============================================================
async function testAfterDelete() {
  console.log("\n--- afterDelete fires after delete ---");
  let hookCalled = false;
  let deletedTable = "";
  let deletedRows: any[] = [];

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      afterDelete: (table: string, rows: any[]) => {
        hookCalled = true;
        deletedTable = table;
        deletedRows = rows;
      },
    },
  });

  await client.from("logs").insert({ id: "l1", msg: "hello" });
  const res = await client.from("logs").delete().eq("id", "l1");
  assert(res.error === null, "delete succeeds");
  assert(hookCalled, "afterDelete was called");
  assert(deletedTable === "logs", "afterDelete received correct table");
  assert(deletedRows.length === 1, "afterDelete received deleted rows");
  assert(deletedRows[0]?.id === "l1", "afterDelete received correct row data");
}

// ============================================================
// 13. beforeSelect: fires before select, can modify params
// ============================================================
async function testBeforeSelect() {
  console.log("\n--- beforeSelect fires before select ---");
  let hookCalled = false;

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeSelect: (filters: any, _table: string) => {
        hookCalled = true;
        return filters;
      },
    },
  });

  await client.from("items").insert({ name: "x" });
  const res = await client.from("items").select();
  assert(res.error === null, "select succeeds");
  assert(hookCalled, "beforeSelect was called");
  assert(res.data?.length === 1, "rows returned correctly");
}

// ============================================================
// 14. afterSelect: fires after select, can modify rows
// ============================================================
async function testAfterSelect() {
  console.log("\n--- afterSelect fires and modifies rows ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      afterSelect: (rows: any[], table: string) => {
        return rows.map((r: any) => ({ ...r, source: table }));
      },
    },
  });

  await client.from("products").insert({ name: "widget" });
  const res = await client.from("products").select();
  assert(res.error === null, "select succeeds");
  assert(res.data?.[0]?.source === "products", "afterSelect added source field");
}

// ============================================================
// 15. canAccess: checked on every operation, can deny
// ============================================================
async function testCanAccess() {
  console.log("\n--- canAccess checked on operations ---");
  const accessLog: string[] = [];

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      canAccess: (opts: any) => {
        accessLog.push(`${opts.method}:${opts.table}`);
        if (opts.table === "secret") return false;
        if (opts.table === "restricted") return { error: "restricted table" };
      },
    },
  });

  await client.from("public").insert({ id: "p1", val: "ok" });
  const res1 = await client.from("public").select();
  assert(res1.error === null, "public table select succeeds");
  assert(accessLog.includes("GET:public"), "canAccess logged GET:public");

  // Denied with false
  const res2 = await client.from("secret").select();
  assert(res2.error !== null, "secret table denied");
  assert(res2.error?.message === "Access denied", "false returns 'Access denied'");

  // Denied with {error}
  const res3 = await client.from("restricted").select();
  assert(res3.error !== null, "restricted table denied");
  assert(res3.error?.message === "restricted table", "custom error message from canAccess");
}

// ============================================================
// 16. onSignup: fires on user creation
// ============================================================
async function testOnSignup() {
  console.log("\n--- onSignup fires on user creation ---");
  let signupUser: any = null;

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      onSignup: (user: any) => {
        signupUser = user;
      },
    },
  });

  const res = await client.auth.signUp({
    email: "test@example.com",
    password: "password123",
  });
  assert(res.error === null, "signup succeeds");
  assert(signupUser !== null, "onSignup was called");
  assert(signupUser?.email === "test@example.com", "onSignup received correct user");
}

// ============================================================
// 17. onSignin: fires on sign in
// ============================================================
async function testOnSignin() {
  console.log("\n--- onSignin fires on sign in ---");
  let signinUser: any = null;

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      onSignin: (user: any) => {
        signinUser = user;
      },
    },
  });

  await client.auth.signUp({
    email: "signin@example.com",
    password: "password123",
  });

  const res = await client.auth.signInWithPassword({
    email: "signin@example.com",
    password: "password123",
  });
  assert(res.error === null, "signin succeeds");
  assert(signinUser !== null, "onSignin was called");
  assert(signinUser?.email === "signin@example.com", "onSignin received correct user");
}

// ============================================================
// 18. Hook ordering: beforeInsert fires before data is written
// ============================================================
async function testHookOrdering() {
  console.log("\n--- Hook ordering: beforeInsert before write ---");
  const events: string[] = [];

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeInsert: (_table: string, _rows: any[]) => {
        events.push("beforeInsert");
      },
      afterInsert: (rows: any[], _table: string) => {
        events.push("afterInsert");
        return rows;
      },
    },
  });

  await client.from("ordered").insert({ name: "test" });
  assert(events.length === 2, "both hooks fired");
  assert(events[0] === "beforeInsert", "beforeInsert fired first");
  assert(events[1] === "afterInsert", "afterInsert fired second");
}

// ============================================================
// 19. canAccess on update and delete operations
// ============================================================
async function testCanAccessOnMutations() {
  console.log("\n--- canAccess on update/delete operations ---");
  const methods: string[] = [];

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      canAccess: (opts: any) => {
        methods.push(opts.method);
      },
    },
  });

  await client.from("data").insert({ id: "x1", val: "1" });
  await client.from("data").select();
  assert(methods.includes("GET"), "canAccess called with GET for select");

  await client.from("data").update({ val: "2" }).eq("id", "x1");
  assert(methods.includes("PATCH"), "canAccess called with PATCH for update");

  await client.from("data").delete().eq("id", "x1");
  assert(methods.includes("DELETE"), "canAccess called with DELETE for delete");
}

// ============================================================
// 20. onSignup returning error blocks signup
// ============================================================
async function testOnSignupBlock() {
  console.log("\n--- onSignup returning error blocks signup ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      onSignup: (_user: any) => {
        return { error: "signups disabled" };
      },
    },
  });

  const res = await client.auth.signUp({
    email: "blocked@example.com",
    password: "password123",
  });
  assert(res.error !== null, "signup should fail");
  assert(res.error?.message === "signups disabled", "correct error message");
}

// ============================================================
// 21. Multiple hooks working together
// ============================================================
async function testMultipleHooks() {
  console.log("\n--- Multiple hooks working together ---");
  const log: string[] = [];

  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
    hooks: {
      beforeInsert: (table: string, _rows: any[]) => {
        log.push(`beforeInsert:${table}`);
      },
      afterSelect: (rows: any[], table: string) => {
        log.push(`afterSelect:${table}`);
        return rows.map((r: any) => ({ ...r, enriched: "true" }));
      },
      canAccess: (opts: any) => {
        log.push(`canAccess:${opts.method}:${opts.table}`);
      },
    },
  });

  await client.from("multi").insert({ id: "m1", name: "test" });
  assert(log.includes("beforeInsert:multi"), "beforeInsert fired");

  const res = await client.from("multi").select();
  assert(log.includes("canAccess:GET:multi"), "canAccess fired for select");
  assert(log.includes("afterSelect:multi"), "afterSelect fired");
  assert(res.data?.[0]?.enriched === "true", "afterSelect transform applied");
}

// ============================================================
// 22. No hooks (baseline) — operations work normally
// ============================================================
async function testNoHooks() {
  console.log("\n--- No hooks baseline ---");
  const client = await createEmbedded({
    dir: `/tmp/bb_hooks_test_${uid()}`,
  });

  const ins = await client.from("plain").insert({ id: "p1", name: "test" });
  assert(ins.error === null, "insert works without hooks");

  const sel = await client.from("plain").select();
  assert(sel.error === null, "select works without hooks");
  assert(sel.data?.length === 1, "one row returned");

  const upd = await client.from("plain").update({ name: "updated" }).eq("id", "p1");
  assert(upd.error === null, "update works without hooks");

  const del = await client.from("plain").delete().eq("id", "p1");
  assert(del.error === null, "delete works without hooks");
}

// ============================================================
// Run all tests
// ============================================================
async function main() {
  console.log("BusyBase Hooks Integration Tests");
  console.log("=================================");

  await testFireHookAbort();
  await testFireHookFalse();
  await testFireHookException();
  await testFireHookVoid();
  await testPipeHookTransform();
  await testPipeHookPassthrough();
  await testBeforeInsert();
  await testAfterInsert();
  await testBeforeUpdate();
  await testAfterUpdate();
  await testBeforeDelete();
  await testAfterDelete();
  await testBeforeSelect();
  await testAfterSelect();
  await testCanAccess();
  await testOnSignup();
  await testOnSignin();
  await testHookOrdering();
  await testCanAccessOnMutations();
  await testOnSignupBlock();
  await testMultipleHooks();
  await testNoHooks();

  console.log("\n=================================");
  console.log(`Results: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log("Failures:");
    for (const e of errors) console.log(`  - ${e}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main();
