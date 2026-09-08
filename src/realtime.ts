import type { ServerWebSocket } from "bun";
import { validId } from "./db.ts";
import { fireHook, hooks } from "./hooks.ts";

type WSUser = { id: string; email: string | null; role: string } | null;
type WSData = { tables: Set<string>; user?: WSUser };

const registry = new Map<string, Set<ServerWebSocket<WSData>>>();

const sub = (ws: ServerWebSocket<WSData>, table: string) => {
  ws.data.tables.add(table);
  if (!registry.has(table)) registry.set(table, new Set());
  registry.get(table)!.add(ws);
};

const unsub = (ws: ServerWebSocket<WSData>, table: string) => {
  ws.data.tables.delete(table);
  const subs = registry.get(table);
  if (!subs) return;
  subs.delete(ws);
  if (subs.size === 0) registry.delete(table);
};

export const broadcastChange = (table: string, eventType: "INSERT" | "UPDATE" | "DELETE", newRow: any, oldRow: any) => {
  const subs = registry.get(table);
  if (!subs?.size) return;
  const msg = JSON.stringify({ event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null });
  for (const ws of subs) {
    try { ws.send(msg); }
    catch (e) { console.error(`[BusyBase] Realtime send failed for table "${table}":`, e); }
  }
};

export const wsHandlers = {
  open(ws: ServerWebSocket<WSData>) { ws.data.tables = new Set(); },
  message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
    (async () => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (msg.type === "subscribe" && msg.table) {
          if (!validId(msg.table)) return;
          if (hooks.canAccess) {
            const denied = await fireHook("canAccess", { user: ws.data.user ?? null, table: msg.table, method: "GET" });
            if (denied) return;
          }
          sub(ws, msg.table);
        } else if (msg.type === "unsubscribe" && msg.table) unsub(ws, msg.table);
      } catch {}
    })();
  },
  close(ws: ServerWebSocket<WSData>) {
    for (const table of [...(ws.data?.tables ?? [])]) unsub(ws, table);
  },
};
