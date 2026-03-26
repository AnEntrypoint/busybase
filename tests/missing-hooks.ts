import { createEmbedded } from "../src/embedded.ts";
import { rmSync } from "node:fs";

let passed = 0;
let failed = 0;

const assert = (cond: boolean, msg: string) => {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
};

const cleanDir = (dir: string) => { try { rmSync(dir, { recursive: true }); } catch {} };

// Test 1: onSignout hook fires on logout
async function testOnSignout() {
  console.log("\nTest 1: onSignout hook fires on logout");
  const dir = "/tmp/busybase_test_signout_" + Date.now();
  let hookCalled = false;
  let hookUser: any = null;

  const client = await createEmbedded({
    dir,
    hooks: {
      onSignout: (user: any) => { hookCalled = true; hookUser = user; },
    },
  });

  const { data: signupData } = await client.auth.signUp({ email: "test@example.com", password: "password123" });
  assert(signupData?.user != null, "signup succeeded");

  const { data: signinData } = await client.auth.signInWithPassword({ email: "test@example.com", password: "password123" });
  assert(signinData?.session != null, "signin succeeded");

  await client.auth.signOut();
  assert(hookCalled, "onSignout hook was called");
  assert(hookUser?.email === "test@example.com", "onSignout received correct user email");

  cleanDir(dir);
}

// Test 2: onUserUpdate hook fires on update
async function testOnUserUpdate() {
  console.log("\nTest 2: onUserUpdate hook fires on update");
  const dir = "/tmp/busybase_test_userupdate_" + Date.now();
  let hookCalled = false;
  let hookUser: any = null;
  let hookChanges: any = null;

  const client = await createEmbedded({
    dir,
    hooks: {
      onUserUpdate: (user: any, changes: any) => { hookCalled = true; hookUser = user; hookChanges = changes; },
    },
  });

  await client.auth.signUp({ email: "test@example.com", password: "password123" });
  await client.auth.signInWithPassword({ email: "test@example.com", password: "password123" });

  await client.auth.updateUser({ data: { name: "Test User" } });
  assert(hookCalled, "onUserUpdate hook was called");
  assert(hookUser?.email === "test@example.com", "onUserUpdate received correct user");
  assert(hookChanges?.data?.name === "Test User", "onUserUpdate received correct changes");

  cleanDir(dir);
}

// Test 3: onIssueSession hook fires on signin
async function testOnIssueSession() {
  console.log("\nTest 3: onIssueSession hook fires on signin");
  const dir = "/tmp/busybase_test_issuesession_" + Date.now();
  let hookCallCount = 0;
  let hookUser: any = null;

  const client = await createEmbedded({
    dir,
    hooks: {
      onIssueSession: (user: any) => { hookCallCount++; hookUser = user; },
    },
  });

  await client.auth.signUp({ email: "test@example.com", password: "password123" });
  assert(hookCallCount === 0, "onIssueSession not called on signup (no session issued)");

  await client.auth.signInWithPassword({ email: "test@example.com", password: "password123" });
  assert(hookCallCount === 1, "onIssueSession called once on signin");
  assert(hookUser?.email === "test@example.com", "onIssueSession received correct user");

  cleanDir(dir);
}

// Test 4: onEmailChange hook fires on email change
async function testOnEmailChange() {
  console.log("\nTest 4: onEmailChange hook fires on email change");
  const dir = "/tmp/busybase_test_emailchange_" + Date.now();
  let hookCalled = false;
  let hookUser: any = null;
  let hookNewEmail: string | null = null;

  const client = await createEmbedded({
    dir,
    hooks: {
      onEmailChange: (user: any, newEmail: string) => { hookCalled = true; hookUser = user; hookNewEmail = newEmail; },
    },
  });

  await client.auth.signUp({ email: "old@example.com", password: "password123" });
  await client.auth.signInWithPassword({ email: "old@example.com", password: "password123" });

  await client.auth.updateUser({ email: "new@example.com" });
  assert(hookCalled, "onEmailChange hook was called");
  assert(hookUser?.email === "old@example.com", "onEmailChange received old user email");
  assert(hookNewEmail === "new@example.com", "onEmailChange received new email");

  cleanDir(dir);
}

// Test 5: onEmailChange hook can abort
async function testOnEmailChangeAbort() {
  console.log("\nTest 5: onEmailChange hook can abort email change");
  const dir = "/tmp/busybase_test_emailchange_abort_" + Date.now();

  const client = await createEmbedded({
    dir,
    hooks: {
      onEmailChange: (_user: any, _newEmail: string) => ({ error: "Email changes not allowed" }),
    },
  });

  await client.auth.signUp({ email: "old@example.com", password: "password123" });
  await client.auth.signInWithPassword({ email: "old@example.com", password: "password123" });

  const result = await client.auth.updateUser({ email: "new@example.com" });
  assert(result.error != null, "update returned an error");
  assert(result.error?.message === "Email changes not allowed", "error message matches hook error");

  // Verify email was NOT changed
  const { data: userData } = await client.auth.getUser();
  assert(userData?.user?.email === "old@example.com", "email was not changed after abort");

  cleanDir(dir);
}

// Run all tests
(async () => {
  console.log("Running missing-hooks tests...");
  try {
    await testOnSignout();
    await testOnUserUpdate();
    await testOnIssueSession();
    await testOnEmailChange();
    await testOnEmailChangeAbort();
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
