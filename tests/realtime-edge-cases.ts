/**
 * Realtime WebSocket edge-case tests for BusyBase.
 *
 * Starts a server on port 54504, exercises raw WebSocket and SDK channel()
 * scenarios, then reports pass/fail and exits 1 on any failure.
 */

import { spawn } from "child_process";
import BB from "../src/sdk.ts";

const PORT = 54504;
const BASE = `http://localhost:${PORT}`;
const WS_URL = `ws://localhost:${PORT}/realtime/v1/websocket`;
const API_KEY = "test-key";

let serverProc: ReturnType<typeof spawn>;
let passed = 0;
let failed = 0;
const results: string[] = [];

function assert(ok: boolean, label: string) {
  if (ok) { passed++; results.push(`  PASS: ${label}`); }
  else    { failed++; results.push(`  FAIL: ${label}`); }
}

function waitFor(fn: () => boolean, ms = 3000): Promise<boolean> {
  return new Promise(res => {
    if (fn()) return res(true);
    const start = Date.now();
    const iv = setInterval(() => {
      if (fn() || Date.now() - start > ms) { clearInterval(iv); res(fn()); }
    }, 50);
  });
}

function openWS(): Promise<WebSocket> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => res(ws);
    ws.onerror = (e) => rej(e);
  });
}

function collect(ws: WebSocket): any[] {
  const msgs: any[] = [];
  ws.onmessage = (e) => {
    try { msgs.push(JSON.parse(typeof e.data === "string" ? e.data : e.data.toString())); } catch {}
  };
  return msgs;
}

async function rest(method: string, path: string, body?: any) {
  const url = `${BASE}/rest/v1/${path}`;
  const opts: RequestInit = { method, headers: { "Content-Type": "application/json", apikey: API_KEY } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

async function startServer() {
  await Bun.spawn(["rm", "-rf", "/tmp/bb_rt_test"]).exited;
  serverProc = spawn("bun", ["run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: { ...process.env, BUSYBASE_DIR: "/tmp/bb_rt_test", BUSYBASE_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(`${BASE}/studio/config`); if (r.ok) return; } catch {}
    await delay(250);
  }
  throw new Error("Server failed to start");
}

async function stopServer() {
  serverProc?.kill("SIGTERM");
  await delay(300);
}

// --- Test 1: Multiple table subscriptions on single WebSocket ---
async function test1_multiTableSub() {
  const ws = await openWS();
  const msgs = collect(ws);
  ws.send(JSON.stringify({ type: "subscribe", table: "t1_alpha" }));
  ws.send(JSON.stringify({ type: "subscribe", table: "t1_beta" }));
  await delay(100);
  await rest("POST", "t1_alpha", [{ id: "a1", x: "1" }]);
  await rest("POST", "t1_beta", [{ id: "b1", y: "2" }]);
  await waitFor(() => msgs.length >= 2);
  const tables = msgs.map(m => m.table);
  assert(tables.includes("t1_alpha"), "1: receives event from t1_alpha");
  assert(tables.includes("t1_beta"), "1: receives event from t1_beta");
  ws.close();
}

// --- Test 2: Unsubscribe from one table, still receive from other ---
async function test2_unsubOnlyOne() {
  const ws = await openWS();
  const msgs = collect(ws);
  ws.send(JSON.stringify({ type: "subscribe", table: "t2_keep" }));
  ws.send(JSON.stringify({ type: "subscribe", table: "t2_drop" }));
  await delay(100);
  ws.send(JSON.stringify({ type: "unsubscribe", table: "t2_drop" }));
  await delay(100);
  await rest("POST", "t2_drop", [{ id: "d1", v: "gone" }]);
  await rest("POST", "t2_keep", [{ id: "k1", v: "here" }]);
  await waitFor(() => msgs.length >= 1);
  await delay(300);
  assert(msgs.some(m => m.table === "t2_keep"), "2: still receives t2_keep events");
  assert(!msgs.some(m => m.table === "t2_drop"), "2: no t2_drop events after unsub");
  ws.close();
}

// --- Test 3: Multiple WebSocket clients on same table ---
async function test3_multipleClients() {
  const ws1 = await openWS();
  const ws2 = await openWS();
  const msgs1 = collect(ws1);
  const msgs2 = collect(ws2);
  ws1.send(JSON.stringify({ type: "subscribe", table: "t3_shared" }));
  ws2.send(JSON.stringify({ type: "subscribe", table: "t3_shared" }));
  await delay(100);
  await rest("POST", "t3_shared", [{ id: "s1", val: "hello" }]);
  await waitFor(() => msgs1.length >= 1 && msgs2.length >= 1);
  assert(msgs1.length >= 1, "3: client 1 receives event");
  assert(msgs2.length >= 1, "3: client 2 receives event");
  ws1.close();
  ws2.close();
}

// --- Test 4: Client disconnect — no crash, events still flow ---
async function test4_clientDisconnect() {
  const ws1 = await openWS();
  const ws2 = await openWS();
  const msgs2 = collect(ws2);
  ws1.send(JSON.stringify({ type: "subscribe", table: "t4_disc" }));
  ws2.send(JSON.stringify({ type: "subscribe", table: "t4_disc" }));
  await delay(100);
  ws1.close();
  await delay(200);
  await rest("POST", "t4_disc", [{ id: "d1", v: "post-disconnect" }]);
  await waitFor(() => msgs2.length >= 1);
  assert(msgs2.length >= 1, "4: remaining client receives events after peer disconnects");
  ws2.close();
}

// --- Test 5: Malformed WebSocket message — server doesn't crash ---
async function test5_malformedMessage() {
  const ws = await openWS();
  ws.send("not json at all {{{");
  ws.send(JSON.stringify({ type: "subscribe" })); // missing table
  ws.send(JSON.stringify({ bogus: true }));
  ws.send("");
  await delay(300);
  const r = await fetch(`${BASE}/studio/config`);
  assert(r.ok, "5: server alive after malformed WS messages");
  ws.close();
}

// --- Test 6: Subscribe to table that doesn't exist yet ---
async function test6_subscribeBeforeTableExists() {
  const ws = await openWS();
  const msgs = collect(ws);
  ws.send(JSON.stringify({ type: "subscribe", table: "t6_future" }));
  await delay(100);
  await rest("POST", "t6_future", [{ id: "f1", data: "created" }]);
  await waitFor(() => msgs.length >= 1);
  assert(msgs.length >= 1, "6: receives event for table created after subscribe");
  assert(msgs[0]?.eventType === "INSERT", "6: event is INSERT");
  ws.close();
}

// --- Test 7: Rapid subscribe/unsubscribe ---
async function test7_rapidSubUnsub() {
  const ws = await openWS();
  const msgs = collect(ws);
  for (let i = 0; i < 20; i++) {
    ws.send(JSON.stringify({ type: "subscribe", table: "t7_rapid" }));
    ws.send(JSON.stringify({ type: "unsubscribe", table: "t7_rapid" }));
  }
  ws.send(JSON.stringify({ type: "subscribe", table: "t7_rapid" }));
  await delay(150);
  await rest("POST", "t7_rapid", [{ id: "r1", v: "fast" }]);
  await waitFor(() => msgs.length >= 1);
  assert(msgs.length >= 1, "7: receives event after rapid sub/unsub ending subscribed");
  ws.close();
}

// --- Test 8: Large payload ---
async function test8_largePayload() {
  const ws = await openWS();
  const msgs = collect(ws);
  ws.send(JSON.stringify({ type: "subscribe", table: "t8_large" }));
  await delay(100);
  const bigValue = "X".repeat(50_000);
  await rest("POST", "t8_large", [{ id: "big1", content: bigValue }]);
  await waitFor(() => msgs.length >= 1, 5000);
  assert(msgs.length >= 1, "8: receives event with large payload");
  assert(msgs[0]?.new?.content?.length === 50_000, "8: payload content length preserved");
  ws.close();
}

// --- Test 9: SDK channel() with specific event filter ---
async function test9_sdkEventFilter() {
  const client = BB(BASE, API_KEY);
  const insertMsgs: any[] = [];

  const ch = client.channel("test9")
    .on("postgres_changes", { event: "INSERT", table: "t9_filter" }, (payload: any) => {
      insertMsgs.push(payload);
    })
    .subscribe();

  await delay(500);
  await rest("POST", "t9_filter", [{ id: "f1", v: "new" }]);
  await waitFor(() => insertMsgs.length >= 1);
  assert(insertMsgs.length === 1, "9: SDK receives INSERT event");

  await rest("PATCH", "t9_filter?eq.id=f1", { v: "updated" });
  await delay(500);
  assert(insertMsgs.length === 1, "9: SDK does NOT receive UPDATE when subscribed to INSERT only");
  ch.unsubscribe();
}

// --- Test 10: SDK subscribe status callback fires "SUBSCRIBED" ---
async function test10_sdkSubscribeStatus() {
  const client = BB(BASE, API_KEY);
  const statuses: string[] = [];

  const ch = client.channel("test10")
    .on("postgres_changes", { event: "*", table: "t10_status" }, () => {})
    .subscribe((status: string) => { statuses.push(status); });

  await waitFor(() => statuses.includes("SUBSCRIBED"));
  assert(statuses.includes("SUBSCRIBED"), "10: SDK subscribe status callback fires SUBSCRIBED");
  ch.unsubscribe();
}

// --- Test 11: SDK removeAllChannels cleans up ---
async function test11_removeAllChannels() {
  const client = BB(BASE, API_KEY);
  const msgs: any[] = [];

  client.channel("test11a")
    .on("postgres_changes", { event: "*", table: "t11_a" }, (p: any) => msgs.push(p))
    .subscribe();

  client.channel("test11b")
    .on("postgres_changes", { event: "*", table: "t11_b" }, (p: any) => msgs.push(p))
    .subscribe();

  await delay(500);
  client.removeAllChannels();
  await delay(300);

  await rest("POST", "t11_a", [{ id: "a1", v: "1" }]);
  await rest("POST", "t11_b", [{ id: "b1", v: "2" }]);
  await delay(500);
  assert(msgs.length === 0, "11: removeAllChannels prevents further events");
}

// ───────────────────────── runner ─────────────────────────

async function main() {
  console.log("Starting server on port", PORT);
  await startServer();
  console.log("Server started. Running tests...\n");

  try {
    await test1_multiTableSub();
    await test2_unsubOnlyOne();
    await test3_multipleClients();
    await test4_clientDisconnect();
    await test5_malformedMessage();
    await test6_subscribeBeforeTableExists();
    await test7_rapidSubUnsub();
    await test8_largePayload();
    await test9_sdkEventFilter();
    await test10_sdkSubscribeStatus();
    await test11_removeAllChannels();
  } catch (e) {
    console.error("Test runner error:", e);
    failed++;
  }

  await stopServer();

  console.log("\n--- Realtime Edge-Case Test Results ---");
  for (const r of results) console.log(r);
  console.log(`\nTotal: ${passed + failed}  Passed: ${passed}  Failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
