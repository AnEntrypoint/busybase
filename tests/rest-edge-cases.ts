/**
 * REST CRUD edge-case tests for BusyBase.
 *
 * Starts a server on port 54503 with a temp data dir, runs all assertions
 * via plain fetch(), then reports pass/fail and exits non-zero on failure.
 */

import { Subprocess } from "bun";

const PORT = 54503;
const BASE = `http://localhost:${PORT}`;
const REST = `${BASE}/rest/v1`;
const DIR = "/tmp/bb_rest_test";

// ── helpers ──────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}`);
  }
}

async function api(
  method: string,
  path: string,
  body?: any,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: Headers }> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${REST}${path}`, opts);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

// ── server lifecycle ─────────────────────────────────────────────────────────

async function cleanup() {
  const { rmSync } = await import("node:fs");
  try {
    rmSync(DIR, { recursive: true, force: true });
  } catch {}
}

let server: Subprocess;

async function startServer(): Promise<void> {
  await cleanup();
  server = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: {
      ...process.env,
      BUSYBASE_DIR: DIR,
      BUSYBASE_PORT: String(PORT),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the server to be ready (up to 8 seconds)
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${BASE}/studio/config`);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("Server did not start in time");
}

function stopServer() {
  try {
    server?.kill();
  } catch {}
}

// ── tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  // ─── 1. POST with empty body (no content) ─────────────────────────────
  {
    const r = await api("POST", "/empty_body_test");
    assert(r.status === 400 && r.body?.error?.message === "Empty body", "1. POST with empty body returns error");
  }

  // ─── 2. POST with empty object {} ─────────────────────────────────────
  {
    const r = await api("POST", "/empty_obj_test", {});
    assert(r.status === 400 && r.body?.error?.message === "Empty body", "2. POST with empty object {} returns error");
  }

  // ─── 3. Invalid table names ────────────────────────────────────────────
  {
    // Special chars
    const r1 = await api("GET", "/my-table");
    assert(r1.status === 400 && /[Ii]nvalid table/.test(r1.body?.error?.message), "3a. Table with hyphens rejected");

    // _users reserved
    const r2 = await api("GET", "/_users");
    assert(r2.status === 400 && /[Ii]nvalid table/.test(r2.body?.error?.message), "3b. _users table rejected");

    // _sessions reserved
    const r3 = await api("GET", "/_sessions");
    assert(r3.status === 400 && /[Ii]nvalid table/.test(r3.body?.error?.message), "3c. _sessions table rejected");

    // Starting with number
    const r4 = await api("GET", "/1table");
    assert(r4.status === 400 && /[Ii]nvalid table/.test(r4.body?.error?.message), "3d. Table starting with number rejected");

    // Spaces / special
    const r5 = await api("GET", "/my%20table");
    assert(r5.status === 400 && /[Ii]nvalid table/.test(r5.body?.error?.message), "3e. Table with spaces rejected");
  }

  // ─── 4. GET on non-existent table → empty array ───────────────────────
  {
    const r = await api("GET", "/nonexistent_table_xyz");
    assert(r.status === 200 && Array.isArray(r.body?.data) && r.body.data.length === 0, "4. GET on non-existent table returns empty array");
  }

  // ─── 5. PUT/PATCH without filter → error ──────────────────────────────
  {
    const r1 = await api("PUT", "/some_table", { name: "x" });
    assert(r1.status === 400 && /[Nn]o filter/.test(r1.body?.error?.message), "5a. PUT without filter returns error");

    const r2 = await api("PATCH", "/some_table", { name: "x" });
    assert(r2.status === 400 && /[Nn]o filter/.test(r2.body?.error?.message), "5b. PATCH without filter returns error");
  }

  // ─── 6. DELETE without filter → error ──────────────────────────────────
  {
    const r = await api("DELETE", "/some_table");
    assert(r.status === 400 && /[Nn]o filter/.test(r.body?.error?.message), "6. DELETE without filter returns error");
  }

  // ─── 7. PUT/PATCH on non-existent table → error ───────────────────────
  {
    const r1 = await api("PUT", "/nosuchtable?eq.id=abc", { name: "x" });
    assert(r1.status === 404 && /[Tt]able not found/.test(r1.body?.error?.message), "7a. PUT on non-existent table returns 404");

    const r2 = await api("PATCH", "/nosuchtable?eq.id=abc", { name: "x" });
    assert(r2.status === 404 && /[Tt]able not found/.test(r2.body?.error?.message), "7b. PATCH on non-existent table returns 404");
  }

  // ─── 8. Auto table creation on first POST ─────────────────────────────
  {
    const r = await api("POST", "/auto_create_tbl", { name: "alice", score: "10" });
    assert(r.status === 201 && r.body?.data?.[0]?.name === "alice", "8. Auto table creation on first POST");
  }

  // ─── 9. Auto column creation when new keys in subsequent POST ─────────
  {
    const r = await api("POST", "/auto_create_tbl", { name: "bob", score: "20", extra_col: "hello" });
    assert(r.status === 201 && r.body?.data?.[0]?.extra_col === "hello", "9. Auto column creation on subsequent POST with new keys");

    // Verify the new column is visible via GET
    const g = await api("GET", "/auto_create_tbl?eq.name=bob");
    assert(g.body?.data?.[0]?.extra_col === "hello", "9b. New column visible in GET");
  }

  // ─── 10. Null value handling in insert and select ──────────────────────
  {
    const r = await api("POST", "/null_test", { name: "with_null", value: null });
    assert(r.status === 201, "10a. POST with null value succeeds");

    const g = await api("GET", "/null_test?eq.name=with_null");
    assert(g.body?.data?.[0]?.value === null, "10b. Null value preserved in select");

    // IS NULL filter
    const g2 = await api("GET", "/null_test?is.value=null");
    assert(g2.body?.data?.length >= 1, "10c. IS NULL filter works");
  }

  // ─── 11. Large batch insert (100 rows) ────────────────────────────────
  {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      name: `batch_${i}`,
      idx: String(i),
    }));
    const r = await api("POST", "/batch_tbl", rows);
    assert(r.status === 201 && r.body?.data?.length === 100, "11a. Batch insert 100 rows returns 100");

    const g = await api("GET", "/batch_tbl");
    assert(g.body?.data?.length === 100, "11b. GET returns all 100 rows");
  }

  // ─── 12. Column selection (select=name,score) ─────────────────────────
  {
    const g = await api("GET", "/auto_create_tbl?select=name,score");
    const row = g.body?.data?.[0];
    assert(
      row && "name" in row && "score" in row && !("id" in row) && !("extra_col" in row),
      "12. select=name,score returns only those columns",
    );
  }

  // ─── 13. Order by desc ─────────────────────────────────────────────────
  {
    const g = await api("GET", "/auto_create_tbl?order=name.desc");
    const names = g.body?.data?.map((r: any) => r.name);
    assert(names?.[0] === "bob" && names?.[1] === "alice", "13. order=name.desc sorts descending");
  }

  // ─── 14. Multiple filters combined ─────────────────────────────────────
  {
    // Insert some data first
    await api("POST", "/filter_tbl", [
      { name: "a", score: "10", tag: "x" },
      { name: "b", score: "20", tag: "x" },
      { name: "c", score: "30", tag: "y" },
    ]);

    const g = await api("GET", "/filter_tbl?eq.tag=x&gt.score=10");
    assert(g.body?.data?.length === 1 && g.body.data[0].name === "b", "14. Multiple filters (eq + gt) combined with AND");
  }

  // ─── 15. Content-Range with offset ─────────────────────────────────────
  {
    const g = await api("GET", "/batch_tbl?limit=10&offset=5&count=exact");
    assert(g.body?.data?.length === 10, "15a. limit=10 returns 10 rows");
    assert(g.body?.count === 100, "15b. count=exact returns total count");
    const cr = g.headers.get("Content-Range");
    assert(cr === "5-14/100", "15c. Content-Range header is 5-14/100");
  }

  // ─── 16. Prefer: return=minimal on PATCH and DELETE ────────────────────
  {
    // PATCH minimal
    const rp = await api(
      "PATCH",
      "/auto_create_tbl?eq.name=alice",
      { score: "99" },
      { Prefer: "return=minimal" },
    );
    assert(rp.status === 204, "16a. PATCH with return=minimal gives 204");

    // DELETE minimal — insert a sacrificial row first
    await api("POST", "/minimal_del", { name: "bye" });
    const rd = await api("DELETE", "/minimal_del?eq.name=bye", undefined, {
      Prefer: "return=minimal",
    });
    assert(rd.status === 204, "16b. DELETE with return=minimal gives 204");
  }

  // ─── 17. Method not allowed (TRACE) ────────────────────────────────────
  {
    const res = await fetch(`${REST}/auto_create_tbl`, { method: "TRACE" });
    const j = await res.json();
    assert(res.status === 405 || j?.error?.message === "Method not allowed", "17. TRACE method returns 405 or error");
  }

  // ─── 18. Table name with valid but unusual chars ───────────────────────
  {
    const r = await api("POST", "/_leading_underscore", { val: "1" });
    // _leading_underscore is valid per regex (starts with _, not _users/_sessions)
    assert(r.status === 201, "18a. Table with leading underscore accepted");

    const r2 = await api("POST", "/MixedCaseTable", { val: "2" });
    assert(r2.status === 201, "18b. Mixed-case table name accepted");

    const r3 = await api("POST", "/with_123_numbers", { val: "3" });
    assert(r3.status === 201, "18c. Table with numbers (not leading) accepted");
  }

  // ─── 19. Update that changes no rows (filter matches nothing) ──────────
  {
    const r = await api("PATCH", "/auto_create_tbl?eq.name=nobody_here", { score: "0" });
    assert(r.status === 200 && Array.isArray(r.body?.data) && r.body.data.length === 0, "19. PATCH matching nothing returns empty array");
  }

  // ─── 20. Delete that matches nothing ───────────────────────────────────
  {
    const r = await api("DELETE", "/auto_create_tbl?eq.name=ghost");
    assert(r.status === 200 && Array.isArray(r.body?.data) && r.body.data.length === 0, "20. DELETE matching nothing returns empty array");
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Starting BusyBase server on port", PORT, "...");
  await startServer();
  console.log("Server ready. Running tests...\n");

  try {
    await runTests();
  } catch (e: any) {
    console.error("\nFATAL:", e.message || e);
    fail++;
  } finally {
    stopServer();
    await cleanup();
  }

  console.log(`\n── Results: ${pass} passed, ${fail} failed ──`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
