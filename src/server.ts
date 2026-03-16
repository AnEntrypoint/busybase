import { hooks } from "./hooks.ts";
import { wsHandlers } from "./realtime.ts";
import { cors, err } from "./db.ts";
import { initAuthTables, sweepExpired, handleAuth } from "./auth.ts";
import { handleRest } from "./rest.ts";

const PORT = process.env.BUSYBASE_PORT || 54321;

await initAuthTables();
setInterval(sweepExpired, 5 * 60_000).unref();

const server = Bun.serve({ port: PORT, websocket: wsHandlers, fetch: async (req) => {
  if (req.headers.get("upgrade") === "websocket" && new URL(req.url).pathname === "/realtime/v1/websocket") {
    const upgraded = server.upgrade(req, { data: { tables: new Set() } });
    return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
  }
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  if (hooks.onRequest) { const r = await hooks.onRequest(req); if (r) return r; }

  const { pathname, searchParams } = new URL(req.url);
  const P = Object.fromEntries(searchParams);
  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  const B = hasBody ? await req.json().catch(() => ({})) : {};

  if (pathname.startsWith("/auth/v1/")) {
    const action = pathname.split("/")[3];
    const result = await handleAuth(action, req, B);
    return result ?? err("Not found", 404);
  }

  if (pathname.startsWith("/rest/v1/")) {
    const table = pathname.slice(9).split("/").map(decodeURIComponent).filter(Boolean)[0];
    if (!table) return err("Table required");
    return handleRest(table, req, P, B);
  }

  const staticRoutes: Record<string, string> = { "/": "./gui.html", "/gui": "./gui.html", "/docs": "../docs/docs.html", "/site": "../docs/index.html" };
  if (pathname in staticRoutes) {
    const file = Bun.file(new URL(staticRoutes[pathname], import.meta.url));
    if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html", ...cors } });
    return err("Not found", 404);
  }

  return err("Not found", 404);
}});

console.log(`BusyBase: http://localhost:${PORT}`);
