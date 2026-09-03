/**
 * Edge-coverage tests for BusyBase.
 *
 * Covers: malformed JSON bodies, concurrent operations, clean() stripping,
 * ilike filter, gt/gte/lt/lte filters, Content-Range edge cases, custom CORS
 * origin, and build step verification.
 *
 * Main server on port 54511 (BUSYBASE_DIR=/tmp/bb_edge_test).
 * Custom CORS server on port 54512.
 */

import { Subprocess } from "bun";

const PORT = 54511;
const PORT_CORS = 54512;
const BASE = `http://localhost:${PORT}`;
const REST = `${BASE}/rest/v1`;
const AUTH = `${BASE}/auth/v1`;
const DIR = "/tmp/bb_edge_test";
const DIR_CORS = "/tmp/bb_edge_test_cors";

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label}${detail ? " -- " + detail : ""}`);
  }
}

async function rawFetch(
  url: string,
  method: string,
  rawBody?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers: Headers }> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", ...headers },
  };
  if (rawBody !== undefined) opts.body = rawBody;
  const res = await fetch(url, opts);
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
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

// -- server lifecycle --------------------------------------------------------

async function cleanup(dir: string) {
  const { rmSync } = await import("node:fs");
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

async function spawnServer(
  port: number,
  dir: string,
  extraEnv?: Record<string, string>,
): Promise<Subprocess> {
  await cleanup(dir);
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: {
      ...process.env,
      BUSYBASE_DIR: dir,
      BUSYBASE_PORT: String(port),
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`http://localhost:${port}/studio/config`);
      return proc;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`Server on port ${port} did not start in time`);
}

function killServer(proc: Subprocess | null) {
  try {
    proc?.kill();
  } catch {}
}

// -- tests -------------------------------------------------------------------

async function testMalformedJSON() {
  console.log("\n== 1. Malformed JSON body handling ==");

  // POST /rest/v1/test_table with body "not json"
  {
    const r = await rawFetch(`${REST}/malformed_tbl`, "POST", "not json");
    assert(
      r.status === 400 && r.body?.error?.message === "Empty body",
      "1a. POST with 'not json' body -> Empty body error",
      `status=${r.status} msg=${r.body?.error?.message}`,
    );
  }

  // POST /auth/v1/signup with body "invalid"
  {
    const r = await rawFetch(`${AUTH}/signup`, "POST", "invalid");
    assert(
      r.status === 400 && r.body?.error != null,
      "1b. POST /auth/v1/signup with 'invalid' body -> error",
      `status=${r.status} msg=${r.body?.error?.message}`,
    );
  }

  // PATCH /rest/v1/test_table with body "broken{"
  {
    // First create a table and row so PATCH has something to target
    await api("POST", "/malformed_patch_tbl", { name: "x", val: "1" });
    const r = await rawFetch(
      `${REST}/malformed_patch_tbl?eq.name=x`,
      "PATCH",
      "broken{",
    );
    // Body parses to {} -> no keys to update, should handle gracefully (no crash)
    assert(
      r.status === 200 || r.status === 400 || r.status === 204,
      "1c. PATCH with 'broken{' body -> handles gracefully (no crash)",
      `status=${r.status}`,
    );
  }
}

async function testConcurrentOperations() {
  console.log("\n== 2. Concurrent operations ==");

  // 10 parallel inserts to same table
  {
    const promises = Array.from({ length: 10 }, (_, i) =>
      api("POST", "/concurrent_tbl", { name: `row_${i}`, idx: String(i) }),
    );
    const results = await Promise.all(promises);
    const allOk = results.every((r) => r.status === 201);
    assert(allOk, "2a. 10 parallel inserts all return 201");

    const g = await api("GET", "/concurrent_tbl");
    assert(
      g.body?.data?.length === 10,
      "2b. Table has exactly 10 rows after parallel inserts",
      `got ${g.body?.data?.length}`,
    );
  }

  // 5 parallel updates to same row
  {
    await api("POST", "/conc_upd_tbl", { name: "target", val: "0" });
    const promises = Array.from({ length: 5 }, (_, i) =>
      api("PATCH", "/conc_upd_tbl?eq.name=target", { val: String(i + 1) }),
    );
    const results = await Promise.all(promises);
    const allHandled = results.every(
      (r) => r.status === 200 || r.status === 204,
    );
    assert(allHandled, "2c. 5 parallel updates all handled (no crash)");

    const g = await api("GET", "/conc_upd_tbl?eq.name=target");
    const val = g.body?.data?.[0]?.val;
    assert(
      val !== undefined && val !== null,
      "2d. Row has one of the update values",
      `val=${val}`,
    );
  }

  // Parallel insert + select
  {
    await api("POST", "/conc_mix_tbl", { name: "seed", val: "0" });
    const [insertRes, selectRes] = await Promise.all([
      api("POST", "/conc_mix_tbl", { name: "new_row", val: "1" }),
      api("GET", "/conc_mix_tbl"),
    ]);
    assert(
      insertRes.status === 201 &&
        selectRes.status === 200 &&
        Array.isArray(selectRes.body?.data),
      "2e. Parallel insert + select -> no crash",
    );
  }
}

async function testCleanStripping() {
  console.log("\n== 3. clean() strips sensitive fields ==");

  // Create a user via signup
  const email = `clean_test_${Date.now()}@test.com`;
  await rawFetch(`${AUTH}/signup`, "POST", JSON.stringify({ email, password: "test1234" }));

  // GET /rest/v1/_users should be rejected (validId blocks _users)
  {
    const r = await api("GET", "/_users");
    assert(
      r.status === 400 && /[Ii]nvalid table/.test(r.body?.error?.message),
      "3a. GET /rest/v1/_users blocked by validId",
    );
  }

  // GET /studio/api/users should return users with pw and pubkey stripped
  {
    const res = await fetch(`${BASE}/studio/api/users`);
    const json = await res.json();
    assert(res.status === 200 && Array.isArray(json.data), "3b. /studio/api/users returns array");

    if (json.data.length > 0) {
      const user = json.data.find((u: any) => u.email === email) || json.data[0];
      assert(user.pw === undefined, "3c. pw field is stripped from user", `pw=${user.pw}`);
      assert(
        user.pubkey === undefined,
        "3d. pubkey field is stripped from user",
        `pubkey=${user.pubkey}`,
      );
      assert(user.id !== undefined, "3e. id field is present in cleaned user");
      assert(user.email !== undefined, "3f. email field is present in cleaned user");
    } else {
      assert(false, "3c. pw field is stripped from user", "no users found");
      assert(false, "3d. pubkey field is stripped from user", "no users found");
      assert(false, "3e. id field is present in cleaned user", "no users found");
      assert(false, "3f. email field is present in cleaned user", "no users found");
    }
  }
}

async function testIlikeFilter() {
  console.log("\n== 4. ilike filter via HTTP REST ==");

  await api("POST", "/ilike_tbl", [
    { name: "Alice", tag: "a" },
    { name: "ALICE", tag: "b" },
    { name: "alice", tag: "c" },
    { name: "Bob", tag: "d" },
  ]);

  // ilike filter should match case-insensitively
  {
    const r = await api("GET", "/ilike_tbl?ilike.name=alice");
    assert(
      r.body?.data?.length === 3,
      "4a. ilike.name=alice matches all 3 alice variants",
      `got ${r.body?.data?.length}`,
    );
  }

  // ilike with wildcard pattern
  {
    const r = await api("GET", "/ilike_tbl?ilike.name=%25ob");
    assert(
      r.body?.data?.length === 1 && r.body.data[0].name === "Bob",
      "4b. ilike.name=%ob matches Bob",
      `got ${r.body?.data?.length}`,
    );
  }
}

async function testComparisonFilters() {
  console.log("\n== 5. gt/gte/lt/lte filters via HTTP REST ==");

  await api("POST", "/scores_tbl", [
    { name: "a", score: "10" },
    { name: "b", score: "20" },
    { name: "c", score: "30" },
    { name: "d", score: "40" },
    { name: "e", score: "50" },
  ]);

  // gt (greater than)
  {
    const r = await api("GET", "/scores_tbl?gt.score=30");
    assert(
      r.body?.data?.length === 2,
      "5a. gt.score=30 returns 2 rows (40, 50)",
      `got ${r.body?.data?.length}`,
    );
  }

  // gte (greater than or equal)
  {
    const r = await api("GET", "/scores_tbl?gte.score=30");
    assert(
      r.body?.data?.length === 3,
      "5b. gte.score=30 returns 3 rows (30, 40, 50)",
      `got ${r.body?.data?.length}`,
    );
  }

  // lt (less than)
  {
    const r = await api("GET", "/scores_tbl?lt.score=30");
    assert(
      r.body?.data?.length === 2,
      "5c. lt.score=30 returns 2 rows (10, 20)",
      `got ${r.body?.data?.length}`,
    );
  }

  // lte (less than or equal)
  {
    const r = await api("GET", "/scores_tbl?lte.score=30");
    assert(
      r.body?.data?.length === 3,
      "5d. lte.score=30 returns 3 rows (10, 20, 30)",
      `got ${r.body?.data?.length}`,
    );
  }

  // Combined: gte + lte (range)
  {
    const r = await api("GET", "/scores_tbl?gte.score=20&lte.score=40");
    assert(
      r.body?.data?.length === 3,
      "5e. gte.score=20 & lte.score=40 returns 3 rows (20, 30, 40)",
      `got ${r.body?.data?.length}`,
    );
  }
}

async function testContentRangeEdgeCases() {
  console.log("\n== 6. Content-Range edge cases ==");

  // Empty result set with count=exact
  {
    const r = await api("GET", "/nonexistent_range_tbl?count=exact");
    const cr = r.headers.get("Content-Range");
    assert(cr === "*", "6a. Empty result Content-Range is '*'", `got '${cr}'`);
  }

  // With offset: insert data then query with offset
  {
    await api("POST", "/range_tbl", [
      { name: "a", idx: "1" },
      { name: "b", idx: "2" },
      { name: "c", idx: "3" },
      { name: "d", idx: "4" },
      { name: "e", idx: "5" },
    ]);

    const r = await api("GET", "/range_tbl?limit=2&offset=1&count=exact");
    const cr = r.headers.get("Content-Range");
    assert(
      cr === "1-2/5",
      "6b. Content-Range with offset=1, limit=2 is '1-2/5'",
      `got '${cr}'`,
    );
    assert(r.body?.data?.length === 2, "6b2. Returns 2 rows with limit=2");
  }

  // Prefer: count=exact header (not query param)
  {
    const r = await api("GET", "/range_tbl?limit=3", undefined, {
      Prefer: "count=exact",
    });
    const cr = r.headers.get("Content-Range");
    assert(
      cr !== null && cr.includes("/5"),
      "6c. Prefer: count=exact header works",
      `got '${cr}'`,
    );
    assert(r.body?.count === 5, "6c2. count field present in response body", `got ${r.body?.count}`);
  }

  // Without count=exact: Content-Range ends with /*
  {
    const r = await api("GET", "/range_tbl?limit=2");
    const cr = r.headers.get("Content-Range");
    assert(
      cr !== null && cr.endsWith("/*"),
      "6d. Without count=exact, Content-Range ends with '/*'",
      `got '${cr}'`,
    );
  }
}

async function testCustomCORS() {
  console.log("\n== 7. Custom CORS origin ==");

  let corsServer: Subprocess | null = null;
  try {
    corsServer = await spawnServer(PORT_CORS, DIR_CORS, {
      BUSYBASE_CORS_ORIGIN: "http://example.com",
    });

    // Check CORS header on various endpoints
    {
      const res = await fetch(`http://localhost:${PORT_CORS}/studio/config`);
      const origin = res.headers.get("Access-Control-Allow-Origin");
      assert(
        origin === "http://example.com",
        "7a. Custom CORS origin on /studio/config",
        `got '${origin}'`,
      );
      await res.text();
    }

    {
      const res = await fetch(`http://localhost:${PORT_CORS}/rest/v1/anything`);
      const origin = res.headers.get("Access-Control-Allow-Origin");
      assert(
        origin === "http://example.com",
        "7b. Custom CORS origin on REST endpoint",
        `got '${origin}'`,
      );
      await res.text();
    }

    {
      const res = await fetch(`http://localhost:${PORT_CORS}/studio/api/tables`);
      const origin = res.headers.get("Access-Control-Allow-Origin");
      assert(
        origin === "http://example.com",
        "7c. Custom CORS origin on /studio/api/tables",
        `got '${origin}'`,
      );
      await res.text();
    }

    // OPTIONS should also have the custom origin
    {
      const res = await fetch(`http://localhost:${PORT_CORS}/rest/v1/x`, {
        method: "OPTIONS",
      });
      const origin = res.headers.get("Access-Control-Allow-Origin");
      assert(
        origin === "http://example.com",
        "7d. Custom CORS origin on OPTIONS",
        `got '${origin}'`,
      );
    }
  } finally {
    killServer(corsServer);
    await cleanup(DIR_CORS);
  }
}

async function testBuildStep() {
  console.log("\n== 8. Build step verification ==");

  const outDir = "/tmp/bb_build_test";
  const outFile = `${outDir}/server.js`;

  const { rmSync, mkdirSync, existsSync, statSync } = await import("node:fs");
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {}
  mkdirSync(outDir, { recursive: true });

  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "src/server.ts",
      "--target=bun",
      `--outfile=${outFile}`,
      "--external",
      "@libsql/client",
    ],
    {
      cwd: "/home/user/busybase",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await proc.exited;

  // Verify the output file exists
  {
    const exists = existsSync(outFile);
    assert(exists, "8a. Build output file exists at /tmp/bb_build_test/server.js");
  }

  // Verify it is non-empty and valid JS
  if (existsSync(outFile)) {
    const stat = statSync(outFile);
    assert(stat.size > 0, "8b. Build output is non-empty", `size=${stat.size}`);

    const content = await Bun.file(outFile).text();
    const looksLikeJS =
      content.includes("function") ||
      content.includes("var ") ||
      content.includes("const ") ||
      content.includes("import") ||
      content.includes("export");
    assert(looksLikeJS, "8c. Build output looks like valid JavaScript");
  }

  // Clean up build artifacts
  try {
    rmSync(outDir, { recursive: true, force: true });
  } catch {}
}

// -- main --------------------------------------------------------------------

async function main() {
  let mainServer: Subprocess | null = null;

  try {
    console.log("Starting BusyBase server on port", PORT, "...");
    mainServer = await spawnServer(PORT, DIR);
    console.log("Server ready. Running tests...");

    await testMalformedJSON();
    await testConcurrentOperations();
    await testCleanStripping();
    await testIlikeFilter();
    await testComparisonFilters();
    await testContentRangeEdgeCases();
    await testCustomCORS();
    await testBuildStep();
  } catch (e: any) {
    console.error("\nFATAL:", e.message || e);
    fail++;
  } finally {
    killServer(mainServer);
    await cleanup(DIR);
  }

  console.log(`\n== Results: ${pass} passed, ${fail} failed ==`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
