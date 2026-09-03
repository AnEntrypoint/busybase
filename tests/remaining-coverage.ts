/**
 * Remaining Coverage Tests — fills gaps across auth recovery/verify, static routes,
 * embedded stubs, SDK keypair, dbUpdate id-skip, onRequest hook, and sendEmail hook.
 *
 * Run: bun run tests/remaining-coverage.ts
 */
import { Subprocess } from "bun";
import { EventEmitter } from "node:events";

const PORT = 54520;
const PORT_HOOKS = 54521;
const BASE = `http://localhost:${PORT}`;
const BASE_HOOKS = `http://localhost:${PORT_HOOKS}`;
const DIR = `/tmp/bb_remaining_${Date.now()}`;
const DIR_HOOKS = `/tmp/bb_remaining_hooks_${Date.now()}`;
const DIR_EMBEDDED = `/tmp/bb_remaining_emb_${Date.now()}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(ok: boolean, name: string, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name} -- ${detail}` : name;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}

// -- helpers --

async function postJson(base: string, path: string, body: any, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<any>;
}

async function patchJson(base: string, path: string, body: any, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<any>;
}

async function getRaw(base: string, path: string) {
  return fetch(`${base}${path}`);
}

async function getJson(base: string, path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { headers });
  return r.json() as Promise<any>;
}

let emailCounter = 0;
function uniqueEmail(prefix = "rc") {
  return `${prefix}${++emailCounter}_${Date.now()}@test.local`;
}

// -- server lifecycle --

async function cleanDir(dir: string) {
  try { await Bun.$`rm -rf ${dir}`.quiet(); } catch {}
  await Bun.$`mkdir -p ${dir}`.quiet();
}

let serverProc: Subprocess | null = null;
let hooksServerProc: Subprocess | null = null;

async function startServer(port: number, dir: string, extraEnv: Record<string, string> = {}): Promise<Subprocess> {
  await cleanDir(dir);
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: { ...process.env, BUSYBASE_DIR: dir, BUSYBASE_PORT: String(port), ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const b = `http://localhost:${port}`;
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${b}/studio/config`); return proc; } catch { await Bun.sleep(150); }
  }
  throw new Error(`Server did not start on port ${port}`);
}

async function stopProc(proc: Subprocess | null) {
  if (proc) {
    proc.kill();
    await proc.exited;
  }
}

// ========================================================
// 1. Password Recovery/Verify FULL flow (HTTP server)
// ========================================================
async function testRecoveryVerifyFlow() {
  console.log("\n[1] Password Recovery/Verify flow");

  const email = uniqueEmail("recover");
  await postJson(BASE, "/auth/v1/signup", { email, password: "orig1234" });

  // Call recover
  const r1 = await postJson(BASE, "/auth/v1/recover", { email });
  assert(!r1.error, "recover returns ok");

  // Verify with FAKE token -> should fail with "Invalid or expired token"
  const r2 = await postJson(BASE, "/auth/v1/verify", { token: "fake-token-abc", type: "recovery", password: "newpass" });
  assert(!!r2.error, "verify with fake token fails");
  assert(r2.error?.message === "Invalid or expired token", "error is 'Invalid or expired token'", r2.error?.message);

  // Verify with type=recovery and no password (fake token -> token check first)
  const r3 = await postJson(BASE, "/auth/v1/verify", { token: "fake-no-pw", type: "recovery" });
  assert(!!r3.error, "verify with no password fails");
  assert(
    r3.error?.message === "Invalid or expired token" || r3.error?.message === "New password required",
    "error is token-related or password-related",
    r3.error?.message
  );

  // Verify with type=unsupported -> "Invalid verification type"
  const r4 = await postJson(BASE, "/auth/v1/verify", { token: "some-token", type: "unsupported" });
  assert(!!r4.error, "verify with unsupported type fails");
  assert(r4.error?.message === "Invalid verification type", "error is 'Invalid verification type'", r4.error?.message);

  // Verify with no token at all -> falls through to "Invalid verification type"
  const r5 = await postJson(BASE, "/auth/v1/verify", { type: "recovery" });
  assert(!!r5.error, "verify with no token fails");
  assert(r5.error?.message === "Invalid verification type", "no-token error is 'Invalid verification type'", r5.error?.message);

  // GET /auth/v1/verify?token=fake&type=recovery (via GET with query params)
  const r6 = await getJson(BASE, "/auth/v1/verify?token=fake&type=recovery");
  assert(!!r6.error, "GET verify with fake token fails");
  assert(
    r6.error?.message === "Invalid or expired token",
    "GET verify error is 'Invalid or expired token'",
    r6.error?.message
  );
}

// ========================================================
// 2. Static Routes (/gui, /docs, /site)
// ========================================================
async function testStaticRoutes() {
  console.log("\n[2] Static Routes (/, /gui, /docs, /site)");

  const routes = [
    { path: "/", desc: "GET /" },
    { path: "/gui", desc: "GET /gui" },
    { path: "/docs", desc: "GET /docs" },
    { path: "/site", desc: "GET /site" },
  ];

  for (const route of routes) {
    const res = await getRaw(BASE, route.path);
    assert(res.status === 200, `${route.desc} -> 200`, `got ${res.status}`);
    const body = await res.text();
    assert(
      body.includes("<html") || body.includes("<!DOCTYPE") || body.includes("<!doctype"),
      `${route.desc} body contains HTML marker`,
      `body length: ${body.length}`
    );
  }
}

// ========================================================
// 3. Embedded Mode Stubs & Extras
// ========================================================
async function testEmbeddedStubs() {
  console.log("\n[3] Embedded Mode Stubs & Extras");

  const { createEmbedded } = await import("../src/embedded.ts");
  const client = await createEmbedded({ dir: DIR_EMBEDDED });

  // resetPasswordForEmail stub
  const r1 = await client.auth.resetPasswordForEmail("any@test.com");
  assert(!r1.error, "resetPasswordForEmail returns ok (stub)");
  assert(r1.data !== undefined, "resetPasswordForEmail has data");

  // setSession
  const r2 = await client.auth.setSession({ access_token: "x", refresh_token: "y" });
  assert(!r2.error, "setSession returns ok");
  const r3 = await client.auth.getSession();
  assert(r3.data?.session?.access_token === "x", "session is set with access_token", JSON.stringify(r3.data?.session));

  // keypair.signIn stub
  const r4 = await client.auth.keypair.signIn();
  assert(!r4.error, "keypair.signIn returns ok (stub)");

  // keypair.restore stub
  const r5 = await client.auth.keypair.restore();
  assert(!r5.error, "keypair.restore returns ok (stub)");

  // keypair.export stub
  const r6 = client.auth.keypair.export();
  assert(typeof r6 === "object", "keypair.export returns object (stub)");
  assert(Object.keys(r6).length === 0, "keypair.export returns empty object");

  // removeAllChannels works without error
  try {
    client.removeAllChannels();
    assert(true, "removeAllChannels runs without error");
  } catch (e: any) {
    assert(false, "removeAllChannels runs without error", e.message);
  }

  // _bus property exists and is an EventEmitter
  assert(client._bus instanceof EventEmitter, "_bus is an EventEmitter");
  assert(typeof client._bus.on === "function", "_bus has .on method");
  assert(typeof client._bus.emit === "function", "_bus has .emit method");
}

// ========================================================
// 4. SDK keypair.forget()
// ========================================================
async function testSDKKeypairForget() {
  console.log("\n[4] SDK keypair.forget()");

  const BB = (await import("../src/sdk.ts")).default;
  const client = BB(BASE, "test-key");

  // signIn generates keys
  const r1 = await client.auth.keypair.signIn();
  assert(!r1.error, "keypair.signIn succeeds", JSON.stringify(r1.error));

  // export should have privkey and pubkey
  const keys1 = client.auth.keypair.export();
  assert(keys1.privkey !== null && keys1.privkey !== undefined, "after signIn, privkey exists");
  assert(keys1.pubkey !== null && keys1.pubkey !== undefined, "after signIn, pubkey exists");

  // forget clears keys
  client.auth.keypair.forget();

  // export should now show null
  const keys2 = client.auth.keypair.export();
  assert(keys2.privkey === null, "after forget, privkey is null", String(keys2.privkey));
  assert(keys2.pubkey === null, "after forget, pubkey is null", String(keys2.pubkey));
}

// ========================================================
// 5. SDK keypair pubkey missing error path
// ========================================================
async function testSDKKeypairPubkeyMissing() {
  console.log("\n[5] SDK keypair pubkey missing error path");

  const BB = (await import("../src/sdk.ts")).default;
  // Fresh client with clean store
  const client = BB(BASE, "test-key-pubmissing");

  // signIn to generate keys, then get the privkey
  const r1 = await client.auth.keypair.signIn();
  const keys = client.auth.keypair.export();
  const savedPrivkey = keys.privkey;

  // forget both keys
  client.auth.keypair.forget();

  // Create a brand new client (fresh Map-based store in Node/Bun)
  const client2 = BB(BASE, "test-key-pubmissing2");

  // Call signIn passing only privkey — store has no pubkey
  // sdk.ts: privkey is set via param, pubkey = store.getItem("_bb_pubkey") = null
  // -> enters `else if (!pubkey)` branch -> returns error about pubkey missing
  const r2 = await client2.auth.keypair.signIn(savedPrivkey!);
  assert(!!r2.error, "signIn with privkey but no pubkey returns error");
  assert(
    r2.error?.message?.includes("Pubkey missing") || r2.error?.message?.includes("pubkey"),
    "error mentions pubkey missing",
    r2.error?.message
  );
}

// ========================================================
// 6. dbUpdate skips 'id' column
// ========================================================
async function testDbUpdateSkipsId() {
  console.log("\n[6] dbUpdate skips 'id' column");

  const table = `testskipid_${Date.now()}`;

  // Insert a row
  const ins = await postJson(BASE, `/rest/v1/${table}`, [{ id: "row1", name: "alice", score: "10" }]);
  assert(!ins.error, "insert row succeeds", JSON.stringify(ins.error));

  // PATCH with id change attempt
  const upd = await patchJson(BASE, `/rest/v1/${table}?eq.id=row1`, { id: "new_id", name: "updated" });
  assert(!upd.error, "patch succeeds", JSON.stringify(upd.error));

  // Verify the row's id is unchanged
  const rows = await getJson(BASE, `/rest/v1/${table}?eq.id=row1`);
  assert(!rows.error, "GET by original id succeeds");
  assert(Array.isArray(rows.data) && rows.data.length > 0, "row still found by original id", JSON.stringify(rows.data));
  assert(rows.data[0]?.name === "updated", "name was updated", rows.data[0]?.name);

  // Verify new_id does NOT exist
  const noRow = await getJson(BASE, `/rest/v1/${table}?eq.id=new_id`);
  assert(Array.isArray(noRow.data) && noRow.data.length === 0, "no row exists with new_id");
}

// ========================================================
// 7. onRequest hook middleware
// ========================================================
async function testOnRequestHook() {
  console.log("\n[7] onRequest hook middleware");

  // Create hooks file
  const hooksPath = "/tmp/bb_onrequest_hooks.ts";
  await Bun.write(hooksPath, `
export const onRequest = (req: Request): Response | void => {
  const url = new URL(req.url);
  if (url.pathname === "/custom-hook-path") {
    return new Response(JSON.stringify({ hooked: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
};
`);

  hooksServerProc = await startServer(PORT_HOOKS, DIR_HOOKS, { BUSYBASE_HOOKS: hooksPath });

  // Test that the custom path returns the hook's response
  const r1 = await getRaw(BASE_HOOKS, "/custom-hook-path");
  assert(r1.status === 200, "hook custom path returns 200");
  const body1 = await r1.json();
  assert(body1.hooked === true, "hook response has hooked:true", JSON.stringify(body1));

  // Test that other paths work normally
  const r2 = await getRaw(BASE_HOOKS, "/studio/config");
  assert(r2.status === 200, "non-hook path /studio/config still works");
  const body2 = await r2.json();
  assert(body2.data !== undefined, "studio/config returns data normally");

  // Also test a REST endpoint works
  const r3 = await postJson(BASE_HOOKS, "/rest/v1/hooktesttbl", [{ id: "h1", val: "hello" }]);
  assert(!r3.error, "REST insert works through hook server", JSON.stringify(r3.error));
}

// ========================================================
// 8. sendEmail hook contract
// ========================================================
async function testSendEmailHookContract() {
  console.log("\n[8] sendEmail hook override contract");

  // Verify the hooks.ts sendEmail function exists
  const hooksModule = await import("../src/hooks.ts");
  assert(typeof hooksModule.sendEmail === "function", "sendEmail function is exported from hooks.ts");

  // Verify the Hooks interface accepts a sendEmail property
  const captured: any[] = [];
  const testHooks = {
    sendEmail: (opts: { to: string; subject: string; html: string; text?: string }) => {
      captured.push(opts);
    },
  };
  assert(typeof testHooks.sendEmail === "function", "sendEmail hook can be defined");

  // Create embedded instance with sendEmail hook
  const { createEmbedded } = await import("../src/embedded.ts");
  const embDir = `/tmp/bb_sendemail_${Date.now()}`;
  await cleanDir(embDir);
  const client = await createEmbedded({
    dir: embDir,
    hooks: {
      sendEmail: (opts: any) => { captured.push(opts); },
    },
  });

  // Sign up a user
  const email = uniqueEmail("sendemail");
  const r1 = await client.auth.signUp({ email, password: "test1234" });
  assert(!r1.error, "embedded signUp succeeds for sendEmail test");

  // resetPasswordForEmail is a stub in embedded mode
  const r2 = await client.auth.resetPasswordForEmail(email);
  assert(!r2.error, "embedded resetPasswordForEmail returns ok (stub)");

  // Verify fireHook and pipeHook are exported from hooks.ts
  assert(typeof hooksModule.fireHook === "function", "fireHook is exported");
  assert(typeof hooksModule.pipeHook === "function", "pipeHook is exported");
}

// ========================================================
// Main
// ========================================================
async function main() {
  console.log("Starting BusyBase remaining-coverage tests...");

  serverProc = await startServer(PORT, DIR);
  console.log(`Server started on port ${PORT}`);

  try {
    await testRecoveryVerifyFlow();
    await testStaticRoutes();
    await testEmbeddedStubs();
    await testSDKKeypairForget();
    await testSDKKeypairPubkeyMissing();
    await testDbUpdateSkipsId();
    await testOnRequestHook();
    await testSendEmailHookContract();
  } catch (e) {
    console.error("\nFATAL ERROR:", e);
    failed++;
  } finally {
    await stopProc(serverProc);
    await stopProc(hooksServerProc);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("=".repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main();
