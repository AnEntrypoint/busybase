import type { ServerWebSocket } from "bun";

type WSData = { tables: Set<string> };

const registry = new Map<string, Set<ServerWebSocket<WSData>>>();

const sub = (ws: ServerWebSocket<WSData>, table: string) => {
  ws.data.tables.add(table);
  if (!registry.has(table)) registry.set(table, new Set());
  registry.get(table)!.add(ws);
};

const unsub = (ws: ServerWebSocket<WSData>, table: string) => {
  ws.data.tables.delete(table);
  registry.get(table)?.delete(ws);
};

export const broadcastChange = (table: string, eventType: "INSERT" | "UPDATE" | "DELETE", newRow: any, oldRow: any) => {
  const subs = registry.get(table);
  if (!subs?.size) return;
  const msg = JSON.stringify({ event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null });
  for (const ws of subs) { try { ws.send(msg); } catch {} }
};

export const wsHandlers = {
  open(ws: ServerWebSocket<WSData>) { ws.data = { tables: new Set() }; },
  message(ws: ServerWebSocket<WSData>, raw: string | Buffer) {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "subscribe" && msg.table) sub(ws, msg.table);
      else if (msg.type === "unsubscribe" && msg.table) unsub(ws, msg.table);
    } catch {}
  },
  close(ws: ServerWebSocket<WSData>) {
    for (const table of ws.data?.tables ?? []) registry.get(table)?.delete(ws);
  },
};
