import { hooks } from './hooks.ts';
import { wsHandlers } from './realtime.ts';
import { cors, err, tableNames, getAllRows, clean, db, getUserFromRequestIn } from './db.ts';
import { initAuthTables, sweepExpired, handleAuthDefault } from './auth.ts';
import { handleRestDefault, restRateLimiter } from './rest.ts';

const PORT = process.env.BUSYBASE_PORT || 54321;
const HOST = process.env.BUSYBASE_HOST || '127.0.0.1';
const UNIX_SOCKET = process.env.BUSYBASE_UNIX_SOCKET || null;
const STUDIO_TOKEN = process.env.BUSYBASE_STUDIO_TOKEN;
const MAX_REQUEST_BODY_SIZE =
  parseInt(process.env.BUSYBASE_MAX_BODY_SIZE || '') || 10 * 1024 * 1024;

if (!process.env.BUSYBASE_CORS_ORIGIN && process.env.NODE_ENV === 'production') {
  console.warn(
    '[BusyBase] BUSYBASE_CORS_ORIGIN is not set (defaulting to "*"). This is safe only because auth uses bearer tokens, not cookies. Set BUSYBASE_CORS_ORIGIN explicitly in production.',
  );
}

await initAuthTables();
setInterval(() => sweepExpired(), 5 * 60_000).unref();
setInterval(() => restRateLimiter.sweep(), 5 * 60_000).unref();

const mime: Record<string, string> = {
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.css': 'text/css',
};
const ext = (p: string) => p.slice(p.lastIndexOf('.')) || '';

const studioAuthorized = (req: Request, searchParams: URLSearchParams): boolean => {
  if (!STUDIO_TOKEN) return true;
  const bearer = req.headers.get('Authorization')?.split(' ')[1];
  const qtoken = searchParams.get('token');
  return bearer === STUDIO_TOKEN || qtoken === STUDIO_TOKEN;
};

const server = Bun.serve({
  ...(UNIX_SOCKET ? { unix: UNIX_SOCKET } : { hostname: HOST, port: PORT }),
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
  websocket: wsHandlers,
  fetch: async (req) => {
    const { pathname, searchParams } = new URL(req.url);
    if (req.headers.get('upgrade') === 'websocket' && pathname === '/realtime/v1/websocket') {
      if (hooks.onRequest) {
        const response = await hooks.onRequest(req);
        if (response) return response;
      }
      const wsToken = req.headers.get('Authorization')?.split(' ')[1] || searchParams.get('token');
      const wsUser = wsToken
        ? await getUserFromRequestIn(
            db,
            new Request(req.url, { headers: { Authorization: `Bearer ${wsToken}` } }),
          ).catch(() => null)
        : null;
      const upgraded = server.upgrade(req, { data: { tables: new Set(), user: wsUser } });
      return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
    }
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (pathname === '/healthz') return Response.json({ status: 'ok' }, { headers: cors });
    if (hooks.onRequest) {
      const r = await hooks.onRequest(req);
      if (r) return r;
    }

    const P = Object.fromEntries(searchParams);
    const hasBody =
      req.method === 'POST' ||
      req.method === 'PUT' ||
      req.method === 'PATCH' ||
      req.method === 'DELETE';
    const B = hasBody ? await req.json().catch(() => ({})) : {};

    if (pathname.startsWith('/auth/v1/')) {
      const action = pathname.split('/')[3];
      const ip = server.requestIP(req)?.address || 'unknown';
      const result = await handleAuthDefault(action, req, B, ip);
      return result ?? err('Not found', 404);
    }

    if (pathname.startsWith('/rest/v1/')) {
      const table = pathname.slice(9).split('/').map(decodeURIComponent).filter(Boolean)[0];
      if (!table) return err('Table required');
      const ip = server.requestIP(req)?.address || 'unknown';
      return handleRestDefault(table, req, P, B, ip);
    }

    if (pathname === '/studio' || pathname === '/studio/' || pathname.startsWith('/studio/')) {
      if (!studioAuthorized(req, searchParams))
        return err('Studio access requires a valid token', 401);
    }

    if (pathname === '/studio/config') {
      const data = {
        BUSYBASE_DIR: process.env.BUSYBASE_DIR || 'busybase_data',
        BUSYBASE_PORT: String(PORT),
        BUSYBASE_CORS_ORIGIN: process.env.BUSYBASE_CORS_ORIGIN || '*',
      };
      return Response.json({ data, error: null }, { headers: cors });
    }

    if (pathname === '/studio/api/tables') {
      const data = await tableNames();
      return Response.json({ data, error: null }, { headers: cors });
    }

    if (pathname === '/studio/api/users') {
      const rows = await getAllRows('_users');
      return Response.json({ data: clean(rows), error: null }, { headers: cors });
    }

    if (pathname === '/studio') {
      const redirectUrl = new URL(req.url);
      redirectUrl.pathname = '/studio/';
      return new Response(null, {
        status: 301,
        headers: { Location: redirectUrl.pathname + redirectUrl.search, ...cors },
      });
    }

    if (pathname === '/studio/') {
      const file = Bun.file(new URL('../studio/index.html', import.meta.url));
      if (await file.exists())
        return new Response(file, { headers: { 'Content-Type': 'text/html', ...cors } });
      return err('Studio not found', 404);
    }

    if (pathname.startsWith('/studio/')) {
      const name = pathname.slice(8);
      if (name && !name.includes('..')) {
        const file = Bun.file(new URL(`../studio/${name}`, import.meta.url));
        if (await file.exists())
          return new Response(file, {
            headers: { 'Content-Type': mime[ext(name)] || 'application/octet-stream', ...cors },
          });
      }
      return err('Not found', 404);
    }

    const staticRoutes: Record<string, string> = {
      '/': './gui.html',
      '/gui': './gui.html',
      '/docs': '../docs/docs.html',
      '/site': '../docs/index.html',
    };
    if (pathname in staticRoutes) {
      const file = Bun.file(new URL(staticRoutes[pathname], import.meta.url));
      if (await file.exists())
        return new Response(file, { headers: { 'Content-Type': 'text/html', ...cors } });
      return err('Not found', 404);
    }

    return err('Not found', 404);
  },
});

console.log(`BusyBase: http://localhost:${PORT}  |  Studio: http://localhost:${PORT}/studio`);

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[BusyBase] Received ${signal}, shutting down gracefully...`);
  server.stop();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
