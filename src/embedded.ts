import type { Client } from "@libsql/client";
import { EventEmitter } from "node:events";
import type { Hooks } from "./hooks.ts";
import { hooks as globalHooks } from "./hooks.ts";
import { openClient, initAuthTablesFor, sweepExpiredIn, getRowsIn } from "./db.ts";
import { handleAuth } from "./auth.ts";
import { handleRest, type BroadcastFn } from "./rest.ts";

export interface EmbeddedConfig { dir?: string; hooks?: Hooks; }

// Embedded mode reuses the exact same handleAuth/handleRest logic the HTTP
// server uses (auth.ts / rest.ts), just called in-process against a
// synthetic Request instead of over the network -- one implementation, two
// transports, so security/correctness fixes only need to happen once.
//
// Hooks are process-global (auth.ts/rest.ts read the hooks.ts singleton),
// matching the HTTP server's model of one hooks config per process. This
// means multiple createEmbedded() calls in one process share one hooks
// config -- the last config.hooks passed wins. This is a real, documented
// constraint (not a hidden bug): the zero-config embedded use case this
// mode targets (one app, one local db) never needs more than one.
export const createEmbedded = async (config: EmbeddedConfig = {}) => {
  const dir = config.dir || "busybase_data";
  if (config.hooks) Object.assign(globalHooks, config.hooks);

  const db: Client = openClient(dir);
  await initAuthTablesFor(db);

  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  const broadcast: BroadcastFn = (table, eventType, newRow, oldRow) => {
    const p = { event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null };
    bus.emit(`table:${table}`, p);
    bus.emit("*", p);
  };

  setInterval(() => sweepExpiredIn(db), 5 * 60_000).unref();

  let currentToken: string | null = null, currentSession: any = null;
  const authListeners: Array<(e: string, s: any) => void> = [];
  const emitAuth = (e: string, s: any) => authListeners.forEach(cb => cb(e, s));

  const NO_BODY_METHODS = new Set(["GET", "HEAD"]);
  const authedRequest = (method: string, body?: any) =>
    new Request("embedded://local/", {
      method,
      headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {},
      body: body !== undefined && !NO_BODY_METHODS.has(method) ? JSON.stringify(body) : undefined,
    });

  const unwrap = async (res: Response) => res.json();

  const Q = (table: string, method?: string, body?: any) => {
    const q = { filters: [] as string[], order: "", limit: 0, offset: 0, select: "*", count: "" };
    let _single = false, _maybe = false;

    const resolve = async () => {
      const P: Record<string, string> = {};
      for (const f of q.filters) {
        if (f.startsWith("or=")) { P.or = f.slice(3); continue; }
        const eq = f.indexOf("=");
        if (eq < 0) continue;
        P[f.slice(0, eq)] = f.slice(eq + 1);
      }
      if (q.select) P.select = q.select;
      if (q.order) P.order = q.order;
      if (q.limit) P.limit = String(q.limit);
      if (q.offset) P.offset = String(q.offset);
      if (q.count) P.count = q.count;

      const req = authedRequest(method || "GET", method === "PATCH" || method === "PUT" ? body : undefined);
      const res = await handleRest(db, table, req, P, method === "PATCH" || method === "PUT" ? body : {}, broadcast);
      const json = await unwrap(res);
      if (json.error) return json;
      const data = json.data;
      if (_single) {
        if (!Array.isArray(data) || !data.length) return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: 406 } };
        return { data: data[0], error: null };
      }
      if (_maybe) return { data: Array.isArray(data) ? (data[0] ?? null) : data, error: null };
      return { data, error: null, ...(json.count !== undefined ? { count: json.count } : {}) };
    };

    const b: any = {
      select: (c = "*") => (q.select = c, b),
      eq: (c: string, v: any) => (q.filters.push(`eq.${c}=${v}`), b),
      neq: (c: string, v: any) => (q.filters.push(`neq.${c}=${v}`), b),
      gt: (c: string, v: any) => (q.filters.push(`gt.${c}=${v}`), b),
      gte: (c: string, v: any) => (q.filters.push(`gte.${c}=${v}`), b),
      lt: (c: string, v: any) => (q.filters.push(`lt.${c}=${v}`), b),
      lte: (c: string, v: any) => (q.filters.push(`lte.${c}=${v}`), b),
      like: (c: string, v: any) => (q.filters.push(`like.${c}=${v}`), b),
      ilike: (c: string, v: any) => (q.filters.push(`ilike.${c}=${v}`), b),
      is: (c: string, v: any) => (q.filters.push(`is.${c}=${v}`), b),
      in: (c: string, vs: any[]) => (q.filters.push(`in.${c}=${vs.join(",")}`), b),
      not: (c: string, op: string, v: any) => (q.filters.push(`not.${c}.${op}=${v}`), b),
      or: (cl: string) => (q.filters.push(`or=${cl}`), b),
      filter: (c: string, op: string, v: any) => (q.filters.push(`${op}.${c}=${v}`), b),
      order: (c: string, { ascending = true } = {}) => (q.order = `${c}.${ascending ? "asc" : "desc"}`, b),
      limit: (n: number) => (q.limit = n, b),
      offset: (n: number) => (q.offset = n, b),
      range: (from: number, to: number) => (q.offset = from, q.limit = to - from + 1, b),
      count: (t = "exact") => (q.count = t, b),
      single: () => (_single = true, b),
      maybeSingle: () => (_maybe = true, b),
      then: (res: any, rej: any) => resolve().then(res, rej),
    };
    return b;
  };

  const from = (table: string) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: async (data: any) => {
      const req = authedRequest("POST", data);
      const res = await handleRest(db, table, req, {}, data, broadcast);
      return unwrap(res);
    },
    upsert: async (data: any) => {
      const rows = (Array.isArray(data) ? data : [data]).map((r: any) => ({ ...r, id: r.id ?? crypto.randomUUID() }));
      const results = await Promise.all(rows.map(async (r: any) => {
        const existing = await getRowsIn(db, table, `id='${r.id.replace(/'/g, "''")}'`);
        if (existing.length) {
          const req = authedRequest("PATCH", r);
          const res = await handleRest(db, table, req, { "eq.id": r.id }, r, broadcast);
          return unwrap(res);
        }
        return from(table).insert(r);
      }));
      return { data: results.flatMap((r: any) => r?.data ?? []), error: null };
    },
    update: (data: any) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null),
  });

  const auth = {
    signUp: async ({ email, password, options }: any) => {
      const req = authedRequest("POST", { email, password, data: options?.data });
      const res = await handleAuth(db, "signup", req, { email, password, data: options?.data });
      return unwrap(res!);
    },
    signInWithPassword: async ({ email, password }: any) => {
      const req = authedRequest("POST", { email, password });
      const res = await handleAuth(db, "token", req, { email, password });
      const json = await unwrap(res!);
      if (json.data?.session) { currentToken = json.data.session.access_token; currentSession = json.data.session; emitAuth("SIGNED_IN", currentSession); }
      return json;
    },
    signIn: async () => {
      const req = authedRequest("GET");
      const nonceRes = await handleAuth(db, "keypair", req, {});
      const { data } = await unwrap(nonceRes!);
      return { data: null, error: { message: "Embedded keypair signIn requires a client-held privkey; use auth.keypair.signIn(privkey) or auth.signInWithPassword instead." } };
    },
    signOut: async () => {
      const req = authedRequest("POST");
      const res = await handleAuth(db, "logout", req, {});
      currentToken = null; currentSession = null; emitAuth("SIGNED_OUT", null);
      return unwrap(res!);
    },
    getUser: async () => {
      const req = authedRequest("GET");
      const res = await handleAuth(db, "user", req, {});
      return unwrap(res!);
    },
    getSession: () => Promise.resolve({ data: { session: currentSession }, error: null }),
    updateUser: async (attrs: any) => {
      const req = authedRequest("PATCH", attrs);
      const res = await handleAuth(db, "update", req, attrs);
      const json = await unwrap(res!);
      if (json.data?.user) emitAuth("USER_UPDATED", currentSession);
      return json;
    },
    setSession: (s: any) => { currentToken = s.access_token; currentSession = s; return Promise.resolve({ data: { session: s }, error: null }); },
    resetPasswordForEmail: async (email: string) => {
      const req = authedRequest("POST", { email });
      const res = await handleAuth(db, "recover", req, { email });
      return unwrap(res!);
    },
    onAuthStateChange: (cb: (e: string, s: any) => void) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", currentSession);
      return { data: { subscription: { unsubscribe: () => { const i = authListeners.indexOf(cb); if (i > -1) authListeners.splice(i, 1); } } } };
    },
    keypair: {
      signIn: async (privkeyB64: string) => {
        if (!privkeyB64) return { data: null, error: { message: "Embedded keypair.signIn requires an explicit privkey (no localStorage in embedded mode)" } };
        return { data: null, error: { message: "Embedded keypair auth is not yet implemented; use email/password auth in embedded mode" } };
      },
      restore: async () => ({ data: null, error: { message: "Embedded keypair auth is not yet implemented; use email/password auth in embedded mode" } }),
      export: () => ({ privkey: null, pubkey: null }),
    },
  };

  const channels = new Map<string, any>();
  const channel = (name: string) => {
    const handlers: any[] = [];
    const ch: any = {
      on: (type: string, opts: any, cb: (p: any) => void) => { const listener = (p: any) => { if (opts.event === "*" || opts.event === p.eventType) cb(p); }; handlers.push({ ...opts, cb, listener }); return ch; },
      subscribe: (statusCb?: (s: string) => void) => { for (const h of handlers) bus.on(`table:${h.table}`, h.listener); statusCb?.("SUBSCRIBED"); channels.set(name, ch); return ch; },
      unsubscribe: () => { for (const h of handlers) bus.off(`table:${h.table}`, h.listener); channels.delete(name); },
    };
    return ch;
  };

  return { from, auth, channel, removeAllChannels: () => { for (const ch of channels.values()) ch.unsubscribe(); }, _bus: bus };
};
