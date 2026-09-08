// @bun
// src/db.ts
import { createClient } from "@libsql/client";
import { mkdirSync } from "fs";
var DIR = process.env.BUSYBASE_DIR || "busybase_data";
var CORS_ORIGIN = process.env.BUSYBASE_CORS_ORIGIN || "*";
var validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";
var openClient = (dir) => {
  mkdirSync(dir, { recursive: true });
  return createClient({ url: `file:${dir}/db.sqlite` });
};
var tableLocksByClient = new WeakMap;
var db = openClient(DIR);

// src/hooks.ts
var smtpHost = process.env.BUSYBASE_SMTP_HOST;
var smtpPort = parseInt(process.env.BUSYBASE_SMTP_PORT || "587");
var smtpUser = process.env.BUSYBASE_SMTP_USER || "";
var smtpPass = process.env.BUSYBASE_SMTP_PASS || "";
var smtpFrom = process.env.BUSYBASE_SMTP_FROM || smtpUser;
var hooksFile = process.env.BUSYBASE_HOOKS;
var userHooks = {};
if (hooksFile) {
  try {
    userHooks = await (hooksFile.startsWith(".") ? import(Bun.resolveSync(hooksFile, process.cwd())) : import(hooksFile));
    console.log(`[BusyBase] Hooks loaded: ${hooksFile}`);
  } catch (e) {
    console.warn(`[BusyBase] Could not load hooks file: ${hooksFile}`, e);
  }
}
var hooks = userHooks;
var fireHookOn = async (h, name, ...args) => {
  const fn = h[name];
  if (!fn)
    return null;
  try {
    const r = await fn(...args);
    if (r === false)
      return "Access denied";
    if (r && typeof r === "object" && typeof r.error === "string")
      return r.error;
  } catch (e) {
    console.error(`[BusyBase] Hook "${String(name)}" threw:`, e);
    return "Internal error";
  }
  return null;
};
var fireHook = (name, ...args) => fireHookOn(hooks, name, ...args);

// src/realtime.ts
var registry = new Map;
var sub = (ws, table) => {
  ws.data.tables.add(table);
  if (!registry.has(table))
    registry.set(table, new Set);
  registry.get(table).add(ws);
};
var unsub = (ws, table) => {
  ws.data.tables.delete(table);
  const subs = registry.get(table);
  if (!subs)
    return;
  subs.delete(ws);
  if (subs.size === 0)
    registry.delete(table);
};
var broadcastChange = (table, eventType, newRow, oldRow) => {
  const subs = registry.get(table);
  if (!subs?.size)
    return;
  const msg = JSON.stringify({ event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null });
  for (const ws of subs) {
    try {
      ws.send(msg);
    } catch (e) {
      console.error(`[BusyBase] Realtime send failed for table "${table}":`, e);
    }
  }
};
var wsHandlers = {
  open(ws) {
    ws.data.tables = new Set;
  },
  message(ws, raw) {
    (async () => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (msg.type === "subscribe" && msg.table) {
          if (!validId(msg.table))
            return;
          if (hooks.canAccess) {
            const denied = await fireHook("canAccess", { user: ws.data.user ?? null, table: msg.table, method: "GET" });
            if (denied)
              return;
          }
          sub(ws, msg.table);
        } else if (msg.type === "unsubscribe" && msg.table)
          unsub(ws, msg.table);
      } catch {}
    })();
  },
  close(ws) {
    for (const table of [...ws.data?.tables ?? []])
      unsub(ws, table);
  }
};
export {
  broadcastChange,
  wsHandlers
};
