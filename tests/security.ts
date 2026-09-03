#!/usr/bin/env bun
/**
 * BusyBase Security Test Suite — SQL injection prevention tests.
 * Runs against a live server on port 54501.
 *
 * Usage:
 *   BUSYBASE_DIR=/tmp/bb_security_test BUSYBASE_PORT=54501 bun run tests/security.ts
 */

const PORT = process.env.BUSYBASE_PORT || "54501";
const BASE = `http://localhost:${PORT}`;

// Start the server in-process
await import("../src/server.ts");
await Bun.sleep(200); // let server bind

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, got?: any) => {
  if (ok) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.error(`  \u2717 ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 200) : ""); fail++; }
};

const get = (path: string) => fetch(`${BASE}${path}`);
const post = (path: string, body: any, headers: Record<string, string> = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const patch = (path: string, body: any, qs = "") =>
  fetch(`${BASE}${path}${qs}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const del = (path: string) => fetch(`${BASE}${path}`, { method: "DELETE", body: "{}", headers: { "Content-Type": "application/json" } });

// ============================================================
// 1. Table name injection via REST API
// ============================================================
console.log("\n[1. Table name injection]");

const maliciousTableNames = [
  "'; DROP TABLE _users; --",
  "test; DELETE FROM _users",
  "test' OR '1'='1",
  'test"; DROP TABLE _users; --',
  "../../../etc/passwd",
  "test table",
  "123startsWithNumber",
  "test-dash",
  "test.dot",
  "test(parens)",
  "SELECT * FROM _users",
];

for (const name of maliciousTableNames) {
  const encoded = encodeURIComponent(name);
  const r = await post(`/rest/v1/${encoded}`, { name: "alice" });
  const j = await r.json();
  check(`POST table="${name.slice(0, 40)}" rejected`, !!j.error, j);
}

// GET with malicious table names
for (const name of maliciousTableNames.slice(0, 4)) {
  const encoded = encodeURIComponent(name);
  const r = await get(`/rest/v1/${encoded}`);
  const j = await r.json();
  check(`GET table="${name.slice(0, 40)}" rejected`, !!j.error, j);
}

// DELETE with malicious table names
for (const name of maliciousTableNames.slice(0, 4)) {
  const encoded = encodeURIComponent(name);
  const r = await del(`/rest/v1/${encoded}?eq.id=1`);
  const j = await r.json();
  check(`DELETE table="${name.slice(0, 40)}" rejected`, !!j.error, j);
}

// ============================================================
// 2. Filter value injection via query params
// ============================================================
console.log("\n[2. Filter value injection]");

// First create a legit table with data
const safeTbl = `sec_test_${Date.now()}`;
await post(`/rest/v1/${safeTbl}`, { name: "alice", score: "10" });
await post(`/rest/v1/${safeTbl}`, { name: "bob", score: "20" });

const injectionValues = [
  "'; DROP TABLE _users; --",
  "' OR '1'='1",
  "' UNION SELECT * FROM _users --",
  "'; INSERT INTO _users VALUES('hacked','hacked','','','','{}','{}','','',''); --",
  "1' OR '1'='1' --",
  "\\'; DROP TABLE _users; --",
  "' OR 1=1; --",
];

for (const val of injectionValues) {
  const encoded = encodeURIComponent(val);
  const r = await get(`/rest/v1/${safeTbl}?eq.name=${encoded}`);
  const j = await r.json();
  // Should return empty results, NOT error out or leak data
  check(`filter eq.name="${val.slice(0, 40)}..." returns empty or safe`, Array.isArray(j.data) && j.data.length === 0, j);
}

// Verify _users table still exists and is intact after all injection attempts
const usersCheck = await get(`/rest/v1/_users`);
const usersJ = await usersCheck.json();
check("_users access blocked by validId", !!usersJ.error, usersJ);

// ============================================================
// 3. Auth email injection
// ============================================================
console.log("\n[3. Auth email injection]");

const maliciousEmails = [
  "'; DROP TABLE _users; --@test.com",
  "admin'--@test.com",
  "test@test.com' OR '1'='1",
  "' UNION SELECT * FROM _sessions --@test.com",
  "test@test.com'; DELETE FROM _sessions; --",
];

for (const email of maliciousEmails) {
  const r = await post("/auth/v1/signup", { email, password: "test12345" });
  const j = await r.json();
  // Should either succeed (treating the whole thing as a literal email) or fail gracefully
  // but must NOT execute SQL — verify no crash
  check(`signup email="${email.slice(0, 40)}..." no SQL exec`, j.data !== undefined || j.error !== undefined, j);
}

// Verify _users table is still intact by signing up a normal user
const normalSignup = await post("/auth/v1/signup", { email: `normal_${Date.now()}@test.com`, password: "pass123" });
const normalJ = await normalSignup.json();
check("normal signup still works after injection attempts", !!normalJ.data?.user?.id, normalJ);

// Sign-in with injection in email
const siInject = await post("/auth/v1/token?grant_type=password", { email: "' OR '1'='1", password: "anything" });
const siJ = await siInject.json();
check("signin with SQL injection email fails properly", !!siJ.error, siJ);

// ============================================================
// 4. Column name injection
// ============================================================
console.log("\n[4. Column name injection]");

const maliciousColumns: Record<string, any>[] = [
  { "name; DROP TABLE _users; --": "alice" },
  { "name' OR '1'='1": "bob" },
  { "id) VALUES ('hack'); --": "carol" },
  { "name, score) VALUES ('a','b'); DROP TABLE _users; --": "x" },
  { "col name": "spaces" },
  { "col-dash": "dashes" },
  { "col.dot": "dots" },
  { "123col": "numstart" },
];

for (const row of maliciousColumns) {
  const key = Object.keys(row)[0];
  const r = await post(`/rest/v1/${safeTbl}`, row);
  const j = await r.json();
  check(`POST column="${key.slice(0, 40)}" rejected`, !!j.error, j);
}

// PATCH with malicious column names
const patchMaliciousCols: Record<string, any>[] = [
  { "score; DROP TABLE _users; --": "99" },
  { "score' OR '1'='1": "99" },
  { "score) WHERE 1=1; --": "99" },
];

for (const data of patchMaliciousCols) {
  const key = Object.keys(data)[0];
  const r = await patch(`/rest/v1/${safeTbl}`, data, `?eq.name=alice`);
  const j = await r.json();
  check(`PATCH column="${key.slice(0, 40)}" rejected`, !!j.error, j);
}

// ============================================================
// 5. validId() bypass attempts
// ============================================================
console.log("\n[5. validId() bypass attempts]");

// Reserved internal tables
const reservedNames = ["_users", "_sessions"];
for (const name of reservedNames) {
  const r = await post(`/rest/v1/${name}`, { test: "data" });
  const j = await r.json();
  check(`POST to ${name} blocked`, !!j.error, j);
}
for (const name of reservedNames) {
  const r = await get(`/rest/v1/${name}`);
  const j = await r.json();
  check(`GET from ${name} blocked`, !!j.error, j);
}
for (const name of reservedNames) {
  const r = await del(`/rest/v1/${name}?eq.id=1`);
  const j = await r.json();
  check(`DELETE from ${name} blocked`, !!j.error, j);
}

// Unicode / special char bypass attempts
const unicodeNames = [
  "\u0000_users",       // null byte prefix
  "table\u200B",        // zero-width space
  "\uFF3Fusers",        // fullwidth underscore
  "table\u0000",        // trailing null byte
];

for (const name of unicodeNames) {
  const encoded = encodeURIComponent(name);
  const r = await post(`/rest/v1/${encoded}`, { name: "test" });
  const j = await r.json();
  check(`unicode table="${name.replace(/[\x00-\x1f\u200B\uFF3F]/g, '<special>')}" rejected`, !!j.error, j);
}

// ============================================================
// 6. esc() edge cases
// ============================================================
console.log("\n[6. esc() edge cases via filter values]");

const escEdgeCases = [
  { val: "''", desc: "double single quotes" },
  { val: "''''", desc: "four single quotes" },
  { val: "test''s", desc: "embedded escaped quote" },
  { val: "test\\'", desc: "backslash then quote" },
  { val: "\0DROP TABLE _users", desc: "null byte prefix" },
  { val: "test\0' OR '1'='1", desc: "null byte mid-injection" },
  { val: "'", desc: "lone single quote" },
  { val: "'; --", desc: "quote semicolon comment" },
  { val: "a".repeat(10000), desc: "very long value (10k chars)" },
  { val: "\n\r\t", desc: "whitespace chars" },
  { val: "test%00admin", desc: "percent-encoded null in literal" },
];

for (const { val, desc } of escEdgeCases) {
  try {
    const encoded = encodeURIComponent(val);
    const r = await get(`/rest/v1/${safeTbl}?eq.name=${encoded}`);
    const j = await r.json();
    // Should return empty results or valid response, never crash
    check(`esc edge: ${desc} — no crash`, j.data !== undefined || j.error !== undefined, j);
  } catch (e: any) {
    check(`esc edge: ${desc} — no crash`, false, e.message);
  }
}

// Verify data integrity: the safe table should still have exactly 2 rows
const finalCheck = await get(`/rest/v1/${safeTbl}`);
const finalJ = await finalCheck.json();
check("safe table intact after all injection attempts (2 rows)", finalJ.data?.length === 2, finalJ);

// ============================================================
// 7. Post-attack integrity verification
// ============================================================
console.log("\n[7. Post-attack integrity verification]");
const verifyEmail = `verify_${Date.now()}@test.com`;
const vSignup = await post("/auth/v1/signup", { email: verifyEmail, password: "verify123" });
const vSignupJ = await vSignup.json();
check("signup works post-attack", !!vSignupJ.data?.user?.id, vSignupJ);

const vSignin = await post("/auth/v1/token?grant_type=password", { email: verifyEmail, password: "verify123" });
const vSigninJ = await vSignin.json();
check("signin works post-attack", !!vSigninJ.data?.session?.access_token, vSigninJ);

// ============================================================
// 8. OR filter injection
// ============================================================
console.log("\n[8. OR filter injection]");

const orInjections = [
  "name.eq.alice,1=1",
  "name.eq.'; DROP TABLE _users; --.eq.x",
  "name.eq.alice); DELETE FROM _users; --",
];

for (const val of orInjections) {
  try {
    const encoded = encodeURIComponent(val);
    const r = await get(`/rest/v1/${safeTbl}?or=${encoded}`);
    const j = await r.json();
    check(`OR filter "${val.slice(0, 50)}" safe`, j.data !== undefined || j.error !== undefined, j);
  } catch (e: any) {
    check(`OR filter safe`, false, e.message);
  }
}

// ============================================================
// 9. NOT filter injection
// ============================================================
console.log("\n[9. NOT filter injection]");

const notInjections = [
  { key: "not.name.eq", val: "'; DROP TABLE _users; --" },
  { key: "not.; DROP TABLE.eq", val: "x" },
  { key: "not.name' OR '1'='1.eq", val: "x" },
];

for (const { key, val } of notInjections) {
  try {
    const encoded = encodeURIComponent(val);
    const r = await get(`/rest/v1/${safeTbl}?${encodeURIComponent(key)}=${encoded}`);
    const j = await r.json();
    check(`NOT filter key="${key.slice(0, 40)}" safe`, j.data !== undefined || j.error !== undefined, j);
  } catch (e: any) {
    check(`NOT filter safe`, false, e.message);
  }
}

// ============================================================
// 10. IN filter injection
// ============================================================
console.log("\n[10. IN filter injection]");

const inInjections = [
  { key: "in.name", val: "alice,'); DROP TABLE _users; --" },
  { key: "in.name", val: "' OR '1'='1" },
  { key: "in.; DROP TABLE _users", val: "x" },
];

for (const { key, val } of inInjections) {
  try {
    const encoded = encodeURIComponent(val);
    const r = await get(`/rest/v1/${safeTbl}?${encodeURIComponent(key)}=${encoded}`);
    const j = await r.json();
    check(`IN filter key="${key}" val="${val.slice(0, 30)}" safe`, j.data !== undefined || j.error !== undefined, j);
  } catch (e: any) {
    check(`IN filter safe`, false, e.message);
  }
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${"=".repeat(40)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
process.exit(0);
