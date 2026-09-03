// @bun
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
  registry.get(table)?.delete(ws);
};
var broadcastChange = (table, eventType, newRow, oldRow) => {
  const subs = registry.get(table);
  if (!subs?.size)
    return;
  const msg = JSON.stringify({ event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null });
  for (const ws of subs) {
    try {
      ws.send(msg);
    } catch {}
  }
};
var wsHandlers = {
  open(ws) {
    ws.data = { tables: new Set };
  },
  message(ws, raw) {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "subscribe" && msg.table)
        sub(ws, msg.table);
      else if (msg.type === "unsubscribe" && msg.table)
        unsub(ws, msg.table);
    } catch {}
  },
  close(ws) {
    for (const table of ws.data?.tables ?? [])
      registry.get(table)?.delete(ws);
  }
};
export {
  broadcastChange,
  wsHandlers
};
