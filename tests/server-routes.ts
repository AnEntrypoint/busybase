/**
 * Server routing and static file serving tests.
 * Starts server on port 54505, runs tests, reports results.
 */

const PORT = 54505;
const BASE = `http://localhost:${PORT}`;
const DIR = `/tmp/bb_routes_test_${Date.now()}`;
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

async function startServer() {
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: { ...process.env, BUSYBASE_DIR: DIR, BUSYBASE_PORT: String(PORT) },
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/studio/config`); return proc; } catch { await Bun.sleep(150); }
  }
  throw new Error("Server did not start");
}

async function run() {
  const serverProc = await startServer();
  console.log("Server ready. Running tests...\n");
  // 1. OPTIONS request → 204 with CORS headers
  {
    const res = await fetch(`${BASE}/rest/v1/anything`, { method: "OPTIONS" });
    assert(res.status === 204, "OPTIONS → 204");
    assert(res.headers.get("Access-Control-Allow-Origin") === "*", "OPTIONS CORS Allow-Origin");
    assert(
      res.headers.get("Access-Control-Allow-Methods")?.includes("GET") === true,
      "OPTIONS CORS Allow-Methods includes GET"
    );
    assert(
      res.headers.get("Access-Control-Allow-Headers")?.includes("Content-Type") === true,
      "OPTIONS CORS Allow-Headers includes Content-Type"
    );
  }

  // 2. GET /studio → returns HTML
  {
    const res = await fetch(`${BASE}/studio`);
    assert(res.status === 200, "GET /studio → 200");
    assert(
      (res.headers.get("Content-Type") || "").includes("text/html"),
      "GET /studio Content-Type is HTML"
    );
    const body = await res.text();
    assert(body.includes("<"), "GET /studio body contains HTML");
  }

  // 3. GET /studio/ → returns HTML
  {
    const res = await fetch(`${BASE}/studio/`);
    assert(res.status === 200, "GET /studio/ → 200");
    assert(
      (res.headers.get("Content-Type") || "").includes("text/html"),
      "GET /studio/ Content-Type is HTML"
    );
    await res.text();
  }

  // 4. GET /studio/config → returns JSON with expected keys, no secrets
  {
    const res = await fetch(`${BASE}/studio/config`);
    assert(res.status === 200, "GET /studio/config → 200");
    const json = await res.json();
    assert(json.data != null, "GET /studio/config has data");
    assert(typeof json.data.BUSYBASE_DIR === "string", "config has BUSYBASE_DIR");
    assert(typeof json.data.BUSYBASE_PORT === "string", "config has BUSYBASE_PORT");
    assert(typeof json.data.BUSYBASE_CORS_ORIGIN === "string", "config has BUSYBASE_CORS_ORIGIN");
    assert(json.data.BUSYBASE_SMTP_PASS === undefined, "config does not expose SMTP_PASS");
    assert(json.data.BUSYBASE_SMTP_HOST === undefined, "config does not expose SMTP_HOST");
    assert(json.error === null, "config error is null");
  }

  // 5. GET /studio/api/tables → {data: string[], error: null}
  {
    const res = await fetch(`${BASE}/studio/api/tables`);
    assert(res.status === 200, "GET /studio/api/tables → 200");
    const json = await res.json();
    assert(Array.isArray(json.data), "tables data is array");
    assert(json.error === null, "tables error is null");
  }

  // 6. GET /studio/api/users → {data: [...], error: null}
  {
    const res = await fetch(`${BASE}/studio/api/users`);
    assert(res.status === 200, "GET /studio/api/users → 200");
    const json = await res.json();
    assert(Array.isArray(json.data), "users data is array");
    assert(json.error === null, "users error is null");
  }

  // 7. GET /studio/tables.js → returns JavaScript content-type
  {
    const res = await fetch(`${BASE}/studio/tables.js`);
    assert(res.status === 200, "GET /studio/tables.js → 200");
    assert(
      (res.headers.get("Content-Type") || "").includes("javascript"),
      "GET /studio/tables.js Content-Type is JavaScript"
    );
    await res.text();
  }

  // 8. GET /studio/../../../etc/passwd → blocked (path traversal)
  {
    const res = await fetch(`${BASE}/studio/..%2F..%2F..%2Fetc%2Fpasswd`);
    assert(res.status === 404, "Path traversal via encoded dots → 404", `got ${res.status}`);
    await res.text();
  }

  // 9. GET /studio/nonexistent.js → 404
  {
    const res = await fetch(`${BASE}/studio/nonexistent.js`);
    assert(res.status === 404, "GET /studio/nonexistent.js → 404");
    await res.text();
  }

  // 10. GET /unknown-route → 404
  {
    const res = await fetch(`${BASE}/unknown-route`);
    assert(res.status === 404, "GET /unknown-route → 404");
    await res.text();
  }

  // 11. GET / → serves gui.html or 404 if missing
  {
    const res = await fetch(`${BASE}/`);
    assert(
      res.status === 200 || res.status === 404,
      "GET / → 200 or 404",
      `got ${res.status}`
    );
    if (res.status === 200) {
      assert(
        (res.headers.get("Content-Type") || "").includes("text/html"),
        "GET / Content-Type is HTML"
      );
    }
    await res.text();
  }

  // 12. CORS headers present on various responses
  {
    const endpoints = ["/studio/config", "/studio/api/tables", "/rest/v1/_users"];
    for (const ep of endpoints) {
      const res = await fetch(`${BASE}${ep}`);
      assert(
        res.headers.get("Access-Control-Allow-Origin") != null,
        `CORS header present on ${ep}`
      );
      await res.text();
    }
  }

  // 13. WebSocket upgrade on /realtime/v1/websocket succeeds
  {
    try {
      const ws = new WebSocket(`ws://localhost:54505/realtime/v1/websocket`);
      const connected = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        setTimeout(() => resolve(false), 3000);
      });
      assert(connected, "WebSocket upgrade on /realtime/v1/websocket succeeds");
      ws.close();
    } catch (e: any) {
      assert(false, "WebSocket upgrade on /realtime/v1/websocket succeeds", e.message);
    }
  }

  // 14. WebSocket upgrade on /rest/v1/anything fails (no upgrade)
  {
    try {
      const ws = new WebSocket(`ws://localhost:54505/rest/v1/anything`);
      const connected = await new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true);
        ws.onerror = () => resolve(false);
        ws.onclose = () => resolve(false);
        setTimeout(() => resolve(false), 3000);
      });
      assert(!connected, "WebSocket upgrade on /rest/v1/anything fails");
      ws.close();
    } catch {
      assert(true, "WebSocket upgrade on /rest/v1/anything fails");
    }
  }

  // 15. POST /auth/v1/nonexistent-action → 404
  {
    const res = await fetch(`${BASE}/auth/v1/nonexistent-action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(res.status === 404, "POST /auth/v1/nonexistent-action → 404", `got ${res.status}`);
    const json = await res.json();
    assert(json.error != null, "auth nonexistent-action returns error object");
  }

  // Summary
  serverProc.kill();
  await serverProc.exited;
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Test suite error:", e);
  process.exit(1);
});
