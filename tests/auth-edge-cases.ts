/**
 * Auth Edge Cases — comprehensive tests for BusyBase auth endpoints
 * Run: BUSYBASE_DIR=/tmp/bb_auth_test BUSYBASE_PORT=54502 bun run tests/auth-edge-cases.ts
 */
import { Subprocess } from "bun";

const PORT = 54502;
const BASE = `http://localhost:${PORT}`;
const DIR = "/tmp/bb_auth_test";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(ok: boolean, name: string, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const msg = detail ? `${name} — ${detail}` : name;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

// ── helpers ──

async function post(path: string, body: any, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<any>;
}

async function patch(path: string, body: any, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return r.json() as Promise<any>;
}

async function get(path: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${path}`, { headers });
  return r.json() as Promise<any>;
}

// ── server lifecycle ──

async function cleanDir() {
  try { await Bun.$`rm -rf ${DIR}`.quiet(); } catch {}
  await Bun.$`mkdir -p ${DIR}`.quiet();
}

let serverProc: Subprocess | null = null;

async function startServer() {
  await cleanDir();
  serverProc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: {
      ...process.env,
      BUSYBASE_DIR: DIR,
      BUSYBASE_PORT: String(PORT),
      BUSYBASE_HOOKS: "./tests/_test-hooks.ts",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // wait for server to be ready
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/studio/config`);
      return;
    } catch { await Bun.sleep(150); }
  }
  throw new Error("Server did not start in time");
}

async function stopServer() {
  if (serverProc) {
    serverProc.kill();
    await serverProc.exited;
    serverProc = null;
  }
}

// ── unique email helper ──
let emailCounter = 0;
function uniqueEmail(prefix = "user") {
  return `${prefix}${++emailCounter}_${Date.now()}@test.local`;
}

// ══════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════

async function testDuplicateSignup() {
  console.log("\n[1] Duplicate email signup");
  const email = uniqueEmail("dup");
  const r1 = await post("/auth/v1/signup", { email, password: "pass1234" });
  assert(!r1.error, "first signup succeeds");
  const r2 = await post("/auth/v1/signup", { email, password: "pass1234" });
  assert(!!r2.error, "second signup returns error", JSON.stringify(r2.error));
  assert(r2.error?.message?.toLowerCase().includes("already"), "error mentions already registered", r2.error?.message);
}

async function testEmptyEmailPassword() {
  console.log("\n[2] Empty email/password");
  const r1 = await post("/auth/v1/signup", { email: "", password: "pass1234" });
  assert(!!r1.error, "empty email returns error");
  const r2 = await post("/auth/v1/signup", { email: "a@b.c", password: "" });
  assert(!!r2.error, "empty password returns error");
  const r3 = await post("/auth/v1/signup", {});
  assert(!!r3.error, "missing both returns error");
}

async function testWrongPassword() {
  console.log("\n[3] Signin with wrong password");
  const email = uniqueEmail("wrongpw");
  await post("/auth/v1/signup", { email, password: "correct123" });
  const r = await post("/auth/v1/token", { email, password: "wrong999" });
  assert(!!r.error, "wrong password returns error");
  assert(r.error?.message?.toLowerCase().includes("invalid"), "error says invalid credentials", r.error?.message);
}

async function testInvalidTokens() {
  console.log("\n[4] Invalid/expired session tokens");
  // Completely fake token
  const r1 = await get("/auth/v1/user", { Authorization: "Bearer totally-fake-token-12345" });
  assert(!!r1.error, "fake token returns error");
  assert(r1.error?.code === 401 || r1.error?.message?.includes("Not authenticated"), "401 for fake token", JSON.stringify(r1.error));

  // Empty bearer
  const r2 = await get("/auth/v1/user", { Authorization: "Bearer " });
  assert(!!r2.error, "empty bearer returns error");
}

async function testMalformedAuthHeaders() {
  console.log("\n[5] Malformed Authorization headers");
  // No Bearer prefix
  const r1 = await get("/auth/v1/user", { Authorization: "just-a-token" });
  assert(!!r1.error, "no Bearer prefix returns error");

  // Completely empty
  const r2 = await get("/auth/v1/user", { Authorization: "" });
  assert(!!r2.error, "empty auth header returns error");

  // No auth header at all
  const r3 = await get("/auth/v1/user");
  assert(!!r3.error, "no auth header returns error");
}

async function testEmailCaseNormalization() {
  console.log("\n[6] Email case normalization");
  const base = uniqueEmail("case");
  const upper = base.toUpperCase();
  const mixed = base.charAt(0).toUpperCase() + base.slice(1);

  // Signup with lowercase
  const r1 = await post("/auth/v1/signup", { email: base, password: "pass1234" });
  assert(!r1.error, "signup with lowercase succeeds");

  // Try signup with uppercase — should detect as duplicate
  const r2 = await post("/auth/v1/signup", { email: upper, password: "pass1234" });
  assert(!!r2.error, "uppercase duplicate blocked", JSON.stringify(r2.error));

  // Signin with mixed case should work
  const r3 = await post("/auth/v1/token", { email: mixed, password: "pass1234" });
  assert(!r3.error, "signin with mixed case works", JSON.stringify(r3.error));
  assert(!!r3.data?.session, "session returned for mixed case signin");

  // Verify the stored email is lowercase
  const token = r3.data?.session?.access_token;
  if (token) {
    const r4 = await get("/auth/v1/user", { Authorization: `Bearer ${token}` });
    assert(r4.data?.user?.email === base, "stored email is lowercase", r4.data?.user?.email);
  }
}

async function testUpdateUserEmailTaken() {
  console.log("\n[7] UpdateUser with email taken by another user");
  const email1 = uniqueEmail("taken1");
  const email2 = uniqueEmail("taken2");

  // Create two users
  await post("/auth/v1/signup", { email: email1, password: "pass1234" });
  await post("/auth/v1/signup", { email: email2, password: "pass1234" });

  // Sign in as user2
  const signin = await post("/auth/v1/token", { email: email2, password: "pass1234" });
  const token = signin.data?.session?.access_token;
  assert(!!token, "user2 signed in");

  // Try to change user2's email to user1's email
  const r = await patch("/auth/v1/update", { email: email1 }, { Authorization: `Bearer ${token}` });
  assert(!!r.error, "update to taken email returns error", JSON.stringify(r.error));
  assert(r.error?.message?.toLowerCase().includes("already"), "error mentions already in use", r.error?.message);
}

async function testPasswordChangeThenSignin() {
  console.log("\n[8] Password change via updateUser then signin with new password");
  const email = uniqueEmail("pwchange");
  const oldPw = "oldpass123";
  const newPw = "newpass456";

  await post("/auth/v1/signup", { email, password: oldPw });
  const signin = await post("/auth/v1/token", { email, password: oldPw });
  const token = signin.data?.session?.access_token;
  assert(!!token, "signed in with old password");

  // Change password
  const r1 = await patch("/auth/v1/update", { password: newPw }, { Authorization: `Bearer ${token}` });
  assert(!r1.error, "password update succeeds", JSON.stringify(r1.error));

  // Old password should fail
  const r2 = await post("/auth/v1/token", { email, password: oldPw });
  assert(!!r2.error, "old password no longer works");

  // New password should work
  const r3 = await post("/auth/v1/token", { email, password: newPw });
  assert(!r3.error, "new password works", JSON.stringify(r3.error));
  assert(!!r3.data?.session, "session returned with new password");
}

async function testRecoverVerifyFlow() {
  console.log("\n[9] Recover / verify password reset flow");
  const email = uniqueEmail("recover");
  const originalPw = "original123";
  const resetPw = "resetted456";

  await post("/auth/v1/signup", { email, password: originalPw });

  // Call recover
  const r1 = await post("/auth/v1/recover", { email });
  assert(!r1.error, "recover returns ok", JSON.stringify(r1.error));

  // The hooks file captures reset tokens. We need to get the token.
  // Since hooks run in the server process, we can't access globalThis directly.
  // Instead, query the _sessions or use the verify endpoint.
  // We'll try to extract the token by calling recover for a non-existent email (should still return ok)
  const r1b = await post("/auth/v1/recover", { email: "nonexistent@test.local" });
  assert(!r1b.error, "recover for non-existent email still returns ok (no info leak)");

  // For the verify test, we need the actual token. Since we can't access the server's
  // in-memory map, let's test the error paths of verify:
  const r2 = await post("/auth/v1/verify", { token: "fake-token", type: "recovery", password: "new123" });
  assert(!!r2.error, "verify with fake token fails");
  assert(r2.error?.message?.toLowerCase().includes("invalid") || r2.error?.message?.toLowerCase().includes("expired"),
    "verify error mentions invalid/expired", r2.error?.message);

  // Verify without password
  const r3 = await post("/auth/v1/verify", { token: "some-token", type: "recovery" });
  assert(!!r3.error, "verify without password fails");

  // Verify with invalid type
  const r4 = await post("/auth/v1/verify", { token: "some-token", type: "magic_link" });
  assert(!!r4.error, "verify with unsupported type fails");

  // Recover with empty email
  const r5 = await post("/auth/v1/recover", { email: "" });
  assert(!!r5.error, "recover with empty email returns error");
}

async function testSignOutThenAuthActions() {
  console.log("\n[10] SignOut then try authenticated actions");
  const email = uniqueEmail("signout");
  await post("/auth/v1/signup", { email, password: "pass1234" });
  const signin = await post("/auth/v1/token", { email, password: "pass1234" });
  const token = signin.data?.session?.access_token;
  assert(!!token, "signed in");

  // Verify token works before logout
  const r1 = await get("/auth/v1/user", { Authorization: `Bearer ${token}` });
  assert(!r1.error && r1.data?.user, "token works before logout");

  // Sign out
  const r2 = await post("/auth/v1/logout", {}, { Authorization: `Bearer ${token}` });
  assert(!r2.error, "logout succeeds");

  // Token should no longer work
  const r3 = await get("/auth/v1/user", { Authorization: `Bearer ${token}` });
  assert(!!r3.error, "token rejected after logout", JSON.stringify(r3.error));
  assert(r3.error?.code === 401 || r3.error?.message?.includes("Not authenticated"),
    "401 after logout", JSON.stringify(r3.error));

  // Update should also fail
  const r4 = await patch("/auth/v1/update", { data: { foo: "bar" } }, { Authorization: `Bearer ${token}` });
  assert(!!r4.error, "update rejected after logout");
}

async function testKeypairInvalidKeys() {
  console.log("\n[11] Keypair: restore with invalid keys");
  const BB = (await import("../src/sdk.ts")).default;
  const client = BB(BASE, "test-key");

  // Try to restore with garbage keys
  const r = await client.auth.keypair.restore("not-a-valid-privkey", "not-a-valid-pubkey");
  assert(!!r.error || (r.data === null), "invalid keypair restore fails", JSON.stringify(r));
}

async function testTokenFormat() {
  console.log("\n[12] Token format and session structure");
  const email = uniqueEmail("tokfmt");
  const pw = "tokentest123";

  const signup = await post("/auth/v1/signup", { email, password: pw });
  assert(!signup.error, "signup ok");

  const signin = await post("/auth/v1/token", { email, password: pw });
  assert(!signin.error, "signin ok");

  const session = signin.data?.session;
  assert(!!session, "session object exists");
  assert(typeof session?.access_token === "string" && session.access_token.length > 0, "access_token is non-empty string");
  assert(typeof session?.refresh_token === "string" && session.refresh_token.length > 0, "refresh_token is non-empty string");
  assert(session?.token_type === "bearer", "token_type is bearer", session?.token_type);
  assert(typeof session?.expires_in === "number", "expires_in is a number");
  assert(typeof session?.expires_at === "number", "expires_at is a number");

  // User object inside session
  const user = session?.user;
  assert(!!user, "user in session");
  assert(user?.email === email, "user email matches", user?.email);
  assert(user?.role === "authenticated", "user role is authenticated", user?.role);
  assert(typeof user?.id === "string" && user.id.length > 0, "user has id");

  // getUser with the token
  const r = await get("/auth/v1/user", { Authorization: `Bearer ${session.access_token}` });
  assert(!r.error, "getUser succeeds");
  assert(r.data?.user?.id === user?.id, "getUser returns same user id");
}

async function testSDKAuthFlow() {
  console.log("\n[13] SDK-level auth flow");
  const BB = (await import("../src/sdk.ts")).default;
  const client = BB(BASE, "test-key");
  const email = uniqueEmail("sdk");
  const pw = "sdktest123";

  // signUp via SDK
  const { data: signupData, error: signupErr } = await client.auth.signUp({ email, password: pw });
  assert(!signupErr, "SDK signUp succeeds", JSON.stringify(signupErr));
  assert(!!signupData?.user, "SDK signUp returns user");

  // signInWithPassword via SDK
  const { data: signinData, error: signinErr } = await client.auth.signInWithPassword({ email, password: pw });
  assert(!signinErr, "SDK signInWithPassword succeeds", JSON.stringify(signinErr));
  assert(!!signinData?.session, "SDK signin returns session");

  // getUser via SDK
  const { data: userData, error: userErr } = await client.auth.getUser();
  assert(!userErr, "SDK getUser succeeds", JSON.stringify(userErr));
  assert(userData?.user?.email === email, "SDK getUser returns correct email");

  // updateUser via SDK
  const { data: updateData, error: updateErr } = await client.auth.updateUser({ data: { nickname: "tester" } });
  assert(!updateErr, "SDK updateUser succeeds", JSON.stringify(updateErr));
  assert(updateData?.user?.user_metadata?.nickname === "tester", "SDK updateUser stores metadata");

  // signOut via SDK
  const { error: outErr } = await client.auth.signOut();
  assert(!outErr, "SDK signOut succeeds");

  // getUser after signOut should fail (SDK sends null token which falls back to apikey)
  const { data: afterData, error: afterErr } = await client.auth.getUser();
  assert(!!afterErr || !afterData?.user, "SDK getUser after signOut fails or returns no user");
}

// ══════════════════════════════════════════════════════════
// Main
// ══════════════════════════════════════════════════════════

async function main() {
  console.log("Starting BusyBase auth edge-case tests...");
  await startServer();
  console.log("Server started on port", PORT);

  try {
    await testDuplicateSignup();
    await testEmptyEmailPassword();
    await testWrongPassword();
    await testInvalidTokens();
    await testMalformedAuthHeaders();
    await testEmailCaseNormalization();
    await testUpdateUserEmailTaken();
    await testPasswordChangeThenSignin();
    await testRecoverVerifyFlow();
    await testSignOutThenAuthActions();
    await testKeypairInvalidKeys();
    await testTokenFormat();
    await testSDKAuthFlow();
  } catch (e) {
    console.error("\nFATAL ERROR:", e);
    failed++;
  } finally {
    await stopServer();
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
