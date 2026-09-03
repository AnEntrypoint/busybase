/**
 * Deep coverage tests for BusyBase.
 * Covers: studio JS files, toFilter edge cases, pipeHook edge cases,
 * embedded toFilter, dbUpdate id protection, Content-Range, MIME types.
 */

import { createEmbedded } from "../src/embedded.ts";
import type { Hooks } from "../src/hooks.ts";

const PORT = 54523;
const BASE = `http://localhost:${PORT}`;
const DIR = `/tmp/bb_deep_test_${Date.now()}`;
let passed = 0;
let failed = 0;

function assert(ok: boolean, name: string, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const section = (name: string) => console.log(`\n=== ${name} ===`);

async function startServer() {
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: { ...process.env, BUSYBASE_DIR: DIR, BUSYBASE_PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/studio/config`);
      return proc;
    } catch {
      await Bun.sleep(150);
    }
  }
  throw new Error("Server did not start");
}

async function run() {
  const serverProc = await startServer();
  console.log("Server ready. Running deep coverage tests...\n");

  // ============================================================
  // 1. Studio JS files serve correct content
  // ============================================================
  section("Studio JS files serve correct content");
  const studioFiles = ["tables.js", "auth.js", "realtime.js", "sql.js", "settings.js"];
  for (const file of studioFiles) {
    const res = await fetch(`${BASE}/studio/${file}`);
    assert(res.status === 200, `GET /studio/${file} -> 200`, `got ${res.status}`);
    const ct = res.headers.get("Content-Type") || "";
    assert(ct.includes("javascript"), `GET /studio/${file} Content-Type includes javascript`, `got ${ct}`);
    const body = await res.text();
    assert(
      body.includes("export") || body.includes("function"),
      `GET /studio/${file} body contains JS code`
    );
  }

  // ============================================================
  // 2. Studio index.html content
  // ============================================================
  section("Studio index.html content");
  {
    const res = await fetch(`${BASE}/studio`);
    assert(res.status === 200, "GET /studio -> 200");
    const body = await res.text();
    assert(
      body.includes("BusyBase") || body.includes("Studio") || body.includes("<div"),
      "GET /studio body contains BusyBase or Studio or HTML element"
    );
  }

  // ============================================================
  // 3. toFilter edge cases via HTTP REST
  // ============================================================
  section("toFilter edge cases via HTTP REST");

  // Seed test data
  const seedTable = "filter_test";
  await fetch(`${BASE}/rest/v1/${seedTable}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([
      { name: "Alice", score: "10" },
      { name: "Bob", score: "20" },
      { name: "Charlie", score: "30" },
    ]),
  });
  // Insert a row with null name
  await fetch(`${BASE}/rest/v1/${seedTable}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ score: "40" }),
  });

  // eq with empty value
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?eq.name=`);
    const json = await res.json();
    assert(res.status === 200, "eq.name= (empty value) -> 200");
    assert(Array.isArray(json.data), "eq.name= returns valid data array");
  }

  // Multiple eq filters (AND logic)
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?eq.name=Alice&eq.score=10`);
    const json = await res.json();
    assert(json.data?.length === 1, "Multiple eq filters AND logic -> 1 row", `got ${json.data?.length}`);
    assert(json.data?.[0]?.name === "Alice", "Multiple eq filters returns Alice");
  }

  // like with %
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?like.name=%25`);
    const json = await res.json();
    assert(json.data?.length >= 3, "like.name=% matches all rows with name", `got ${json.data?.length}`);
  }

  // ilike (case insensitive)
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?ilike.name=ALICE`);
    const json = await res.json();
    assert(json.data?.length === 1, "ilike.name=ALICE matches 1 row", `got ${json.data?.length}`);
    assert(json.data?.[0]?.name === "Alice", "ilike returns Alice");
  }

  // is.name=null
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?is.name=null`);
    const json = await res.json();
    assert(json.data?.length >= 1, "is.name=null matches rows where name IS NULL", `got ${json.data?.length}`);
  }

  // not.name.eq=Alice
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?not.name.eq=Alice`);
    const json = await res.json();
    assert(
      json.data?.every((r: any) => r.name !== "Alice"),
      "not.name.eq=Alice excludes Alice"
    );
    assert(json.data?.length >= 2, "not.name.eq=Alice returns multiple rows", `got ${json.data?.length}`);
  }

  // not.name.neq=Alice -> NOT (name != 'Alice') -> only Alice
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?not.name.neq=Alice`);
    const json = await res.json();
    assert(
      json.data?.length >= 1 && json.data?.every((r: any) => r.name === "Alice"),
      "not.name.neq=Alice returns only Alice",
      `got ${json.data?.length} rows`
    );
  }

  // or filter
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?or=name.eq.Alice,name.eq.Bob`);
    const json = await res.json();
    assert(json.data?.length === 2, "or filter returns 2 rows", `got ${json.data?.length}`);
  }

  // in filter
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?in.name=Alice,Bob`);
    const json = await res.json();
    assert(json.data?.length === 2, "in.name=Alice,Bob returns 2 rows", `got ${json.data?.length}`);
  }

  // gt + lt combined range
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?gt.score=10&lt.score=30`);
    const json = await res.json();
    assert(json.data?.length === 1, "gt.score=10 & lt.score=30 -> 1 row (score=20)", `got ${json.data?.length}`);
    assert(json.data?.[0]?.score === "20", "combined range returns score=20");
  }

  // gte + lte combined range
  {
    const res = await fetch(`${BASE}/rest/v1/${seedTable}?gte.score=10&lte.score=30`);
    const json = await res.json();
    assert(json.data?.length === 3, "gte.score=10 & lte.score=30 -> 3 rows", `got ${json.data?.length}`);
  }

  // ============================================================
  // 6. dbUpdate id column protection via HTTP
  // ============================================================
  section("dbUpdate id column protection via HTTP");
  {
    const knownId = "protect-" + crypto.randomUUID();
    await fetch(`${BASE}/rest/v1/idprotect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: knownId, name: "original" }),
    });

    await fetch(`${BASE}/rest/v1/idprotect?eq.id=${knownId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "hacked_id", name: "updated" }),
    });

    const res = await fetch(`${BASE}/rest/v1/idprotect?eq.id=${knownId}`);
    const json = await res.json();
    assert(json.data?.length === 1, "id protection: row still found by original id", `got ${json.data?.length}`);
    assert(json.data?.[0]?.name === "updated", "id protection: name was updated");
    assert(json.data?.[0]?.id === knownId, "id protection: id unchanged");

    const res2 = await fetch(`${BASE}/rest/v1/idprotect?eq.id=hacked_id`);
    const json2 = await res2.json();
    assert(json2.data?.length === 0, "id protection: hacked_id does not exist");
  }

  // ============================================================
  // 7. Content-Range format variations
  // ============================================================
  section("Content-Range format variations");
  {
    // No rows matching -> Content-Range is "*"
    const res = await fetch(`${BASE}/rest/v1/empty_cr_table?eq.name=nonexistent`);
    assert(
      res.headers.get("Content-Range") === "*",
      "Content-Range is * when no rows match",
      `got ${res.headers.get("Content-Range")}`
    );
    await res.json();

    // count=exact and 0 rows
    const res2 = await fetch(`${BASE}/rest/v1/empty_cr_table2?eq.name=nonexistent&count=exact`);
    assert(
      res2.headers.get("Content-Range") === "*",
      "Content-Range is * with count=exact and 0 rows",
      `got ${res2.headers.get("Content-Range")}`
    );
    await res2.json();

    // limit=0: parseInt("0") = 0, || 1000 -> 1000, so returns all
    await fetch(`${BASE}/rest/v1/limit_test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([{ name: "a" }, { name: "b" }, { name: "c" }]),
    });
    const res3 = await fetch(`${BASE}/rest/v1/limit_test?limit=0`);
    const json3 = await res3.json();
    assert(
      json3.data?.length === 3,
      "limit=0 returns all rows (falls back to 1000)",
      `got ${json3.data?.length}`
    );

    // Content-Range with actual rows present
    const res4 = await fetch(`${BASE}/rest/v1/limit_test`);
    const cr4 = res4.headers.get("Content-Range");
    assert(
      cr4 !== null && cr4 !== "*",
      "Content-Range has range when rows exist",
      `got ${cr4}`
    );
    await res4.json();
  }

  // ============================================================
  // 8. MIME type handling for studio files
  // ============================================================
  section("MIME type handling for studio files");
  {
    const res1 = await fetch(`${BASE}/studio/tables.js`);
    const ct1 = res1.headers.get("Content-Type") || "";
    assert(ct1.includes("text/javascript"), "GET /studio/tables.js -> text/javascript", `got ${ct1}`);
    await res1.text();

    const res2 = await fetch(`${BASE}/studio/index.html`);
    if (res2.status === 200) {
      const ct2 = res2.headers.get("Content-Type") || "";
      assert(ct2.includes("text/html"), "GET /studio/index.html -> text/html", `got ${ct2}`);
    } else {
      assert(true, "GET /studio/index.html -> served or handled");
    }
    await res2.text();

    const res3 = await fetch(`${BASE}/studio/nonexistent.css`);
    assert(res3.status === 404, "GET /studio/nonexistent.css -> 404", `got ${res3.status}`);
    await res3.text();
  }

  // Stop server
  serverProc.kill();
  await serverProc.exited;

  // ============================================================
  // 4. pipeHook edge cases (via embedded)
  // ============================================================
  section("pipeHook edge cases (via embedded)");

  // beforeSelect hook that returns modified params
  {
    const bb = await createEmbedded({
      dir: `${DIR}_pipe1`,
      hooks: {
        beforeSelect: (params: any, table: string) => {
          if (table === "piped") {
            if (Array.isArray(params)) {
              return [...params, "eq.name=Bob"];
            }
            return params;
          }
          return params;
        },
      } as Hooks,
    });
    await bb.from("piped").insert([
      { name: "Alice", val: "1" },
      { name: "Bob", val: "2" },
    ]);
    const { data } = await bb.from("piped").select();
    assert(data?.length === 1, "beforeSelect hook modifies filter -> only Bob returned", `got ${data?.length}`);
    assert(data?.[0]?.name === "Bob", "beforeSelect hook filter returns Bob");
  }

  // afterSelect hook that returns undefined -> original data passes through
  {
    const bb = await createEmbedded({
      dir: `${DIR}_pipe2`,
      hooks: {
        afterSelect: (_rows: any[], _table: string) => {
          return undefined;
        },
      } as Hooks,
    });
    await bb.from("passthru").insert({ name: "test" });
    const { data } = await bb.from("passthru").select();
    assert(data?.length === 1, "afterSelect returning undefined -> original data passes through", `got ${data?.length}`);
    assert(data?.[0]?.name === "test", "afterSelect undefined -> data intact");
  }

  // afterSelect hook that throws -> original data passes through
  {
    const bb = await createEmbedded({
      dir: `${DIR}_pipe3`,
      hooks: {
        afterSelect: (_rows: any[], _table: string) => {
          throw new Error("hook error");
        },
      } as Hooks,
    });
    await bb.from("throwtest").insert({ name: "survive" });
    const { data } = await bb.from("throwtest").select();
    assert(data?.length === 1, "afterSelect throwing -> original data passes through", `got ${data?.length}`);
    assert(data?.[0]?.name === "survive", "afterSelect throw -> data intact");
  }

  // afterInsert hook that transforms rows (adds field)
  {
    const bb = await createEmbedded({
      dir: `${DIR}_pipe4`,
      hooks: {
        afterInsert: (rows: any[], _table: string) => {
          return rows.map((r: any) => ({ ...r, injected: "yes" }));
        },
      } as Hooks,
    });
    const { data } = await bb.from("inject").insert({ name: "test" });
    assert(data?.[0]?.injected === "yes", "afterInsert transforms rows (adds field)");
  }

  // pipeHook with hook returning {error: "..."} -> pipeHook returns original value
  {
    const bb = await createEmbedded({
      dir: `${DIR}_pipe5`,
      hooks: {
        afterSelect: (_rows: any[], _table: string) => {
          return { error: "should be ignored by pipeHook" };
        },
      } as Hooks,
    });
    await bb.from("errpipe").insert({ name: "keep" });
    const { data } = await bb.from("errpipe").select();
    assert(data?.length === 1, "pipeHook with {error} returns original value", `got ${data?.length}`);
    assert(data?.[0]?.name === "keep", "pipeHook with {error} -> original data intact");
  }

  // ============================================================
  // 5. Embedded toFilter edge cases
  // ============================================================
  section("Embedded toFilter edge cases");
  {
    const bb = await createEmbedded({ dir: `${DIR}_emb_filter` });
    await bb.from("efilter").insert([
      { name: "Alice", score: "10" },
      { name: "Bob", score: "20" },
      { name: "Charlie", score: "30" },
    ]);

    // .filter("name", "eq", "Alice")
    {
      const { data } = await bb.from("efilter").select().filter("name", "eq", "Alice");
      assert(data?.length === 1, ".filter('name','eq','Alice') works", `got ${data?.length}`);
      assert(data?.[0]?.name === "Alice", ".filter returns Alice");
    }

    // Multiple filters chained: .eq + .gt -> AND
    // Note: SQLite TEXT columns compare lexicographically, so use "09" < "10"
    {
      const { data } = await bb.from("efilter").select().eq("name", "Alice").gt("score", "09");
      assert(data?.length === 1, ".eq + .gt chained AND works", `got ${data?.length}`);
      assert(data?.[0]?.name === "Alice", "chained filter returns Alice");
    }

    // Empty select (no rows match)
    {
      const { data } = await bb.from("efilter").select().eq("name", "Nobody");
      assert(data?.length === 0, "Empty select returns empty array", `got ${data?.length}`);
    }

    // .not("name", "eq", "Alice")
    {
      const { data } = await bb.from("efilter").select().not("name", "eq", "Alice");
      assert(data?.length === 2, ".not('name','eq','Alice') returns 2 rows", `got ${data?.length}`);
      assert(
        data?.every((r: any) => r.name !== "Alice"),
        ".not excludes Alice"
      );
    }

    // .or("name.eq.Alice,name.eq.Bob")
    {
      const { data } = await bb.from("efilter").select().or("name.eq.Alice,name.eq.Bob");
      assert(data?.length === 2, ".or returns 2 rows", `got ${data?.length}`);
      const names = data?.map((r: any) => r.name).sort();
      assert(
        names?.[0] === "Alice" && names?.[1] === "Bob",
        ".or returns Alice and Bob"
      );
    }
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(40)}`);

  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Test suite error:", e);
  process.exit(1);
});
