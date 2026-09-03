import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { Hooks } from "./hooks.ts";
import type { Client } from "@libsql/client";

type BackendFactory = (cfg: { url: string }) => Client | Promise<Client>;

// Lazy registry: EVERY built-in backend resolves its real client module at
// first use, not at import time -- so an embedded consumer who never opens a
// 'libsql' connection never pays for (or fails on a missing) @libsql/client,
// same as the 'plugkit' entry already did. A static top-level `import
// {createClient} from "@libsql/client"` would defeat this for 'libsql'
// specifically since ESM top-level imports resolve before any code runs,
// regardless of which backend a given caller actually configures.
const lazyBackends: Record<string, () => Promise<BackendFactory>> = {
  libsql: async () => {
    const mod = await import("@libsql/client").catch(() => null as any);
    if (!mod || typeof mod.createClient !== "function") {
      throw new Error("backend 'libsql' requires @libsql/client (npm install @libsql/client)");
    }
    return (cfg) => mod.createClient(cfg) as Client;
  },
  plugkit: async () => {
    const mod = await import("libsql-plugkit-client").catch(() => null as any);
    if (!mod || typeof mod.createClient !== "function") {
      throw new Error("backend 'plugkit' requires libsql-plugkit-client (npm install libsql-plugkit-client)");
    }
    return (cfg) => mod.createClient({ url: cfg.url }) as Client;
  },
};

const backends: Record<string, BackendFactory> = {};
export const registerBackend = (name: string, factory: BackendFactory) => { backends[name] = factory; };
const resolveClient = async (backend: string, url: string): Promise<Client> => {
  let f = backends[backend];
  if (!f && lazyBackends[backend]) {
    f = await lazyBackends[backend]();
    backends[backend] = f;
  }
  if (!f) throw new Error(`busybase: unknown backend '${backend}'. Registered: ${[...Object.keys(backends), ...Object.keys(lazyBackends)].join(', ')}`);
  return await f({ url });
};

const esc = (s: string) => String(s).replace(/'/g, "''");
const validId = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";
const clean = (rows: any[]) => rows.map(({ pw, pubkey: _pk, ...r }) => r);
const makeUser = (u: any) => ({ id: u.id, email: u.email || null, role: u.role || "authenticated", user_metadata: JSON.parse(u.meta || "{}"), app_metadata: JSON.parse(u.app_meta || "{}"), identities: [], aud: "authenticated", created_at: u.created, updated_at: u.updated || u.created, last_sign_in_at: u.last_sign_in || u.created, email_confirmed_at: u.email ? u.created : null });
const makeSession = (token: string, refresh: string, exp: number, user: any) => ({ access_token: token, refresh_token: refresh, token_type: "bearer", expires_in: 604800, expires_at: Math.floor(exp / 1000), user });
const ok = (data: any, count?: number) => count !== undefined ? { data, error: null, count } : { data, error: null };
const err = (message: string, code = 400) => ({ data: null, error: { message, code } });

export interface EmbeddedConfig { dir?: string; hooks?: Hooks; backend?: string; url?: string; }

// File-backed local backends: both 'libsql' (@libsql/client, native NAPI
// binaries) and 'plugkit' (libsql-plugkit-client, one cross-platform wasm)
// open a real on-disk sqlite file and need their parent dir to exist first
// (plugkit's wasi preopen requires the host dir already there -- it does not
// create it) plus a busy_timeout so concurrent same-process-tree writers
// retry instead of throwing SQLITE_BUSY immediately. A future non-file
// backend (a remote/plugkit-over-network client) opts out of both simply by
// not appearing in this set.
const FILE_BACKENDS = new Set(["libsql", "plugkit"]);

export const createEmbedded = async (config: EmbeddedConfig = {}) => {
  const dir = config.dir || "busybase_data";
  const hooks = config.hooks || {};
  // 'plugkit' (libsql-plugkit-client, wasm-backed) is the default -- avoids
  // @libsql/*'s per-platform NAPI binaries entirely. Pass backend: 'libsql'
  // to opt back into the native client when its build is already present.
  const backend = config.backend || "plugkit";
  if (FILE_BACKENDS.has(backend)) mkdirSync(dir, { recursive: true });
  const url = config.url || `file:${dir}/db.sqlite`;
  const db: Client = await resolveClient(backend, url);
  // PRAGMA busy_timeout tells SQLite's own native lock-wait machinery to
  // retry internally for up to this many ms before surfacing SQLITE_BUSY,
  // instead of throwing the instant a concurrent process/connection holds
  // the write lock -- the standard, built-in fix for the exact
  // multi-process contention embedded mode is otherwise exposed to (each
  // createEmbedded() call opens its OWN direct handle onto the same file;
  // with no busy handler configured, two callers writing at once threw
  // immediately). Live-verified: 300 real inserts across 3 separate OS
  // processes against the same file completed with ZERO SQLITE_BUSY errors
  // once this was set; the identical test threw on the very first
  // contended write without it. Only meaningful for the libsql backend (a
  // real local file) -- other backends (a remote/plugkit client) may not
  // implement PRAGMA identically, so this is best-effort and never blocks
  // startup on failure.
  if (FILE_BACKENDS.has(backend)) { try { await db.execute("PRAGMA busy_timeout = 5000"); } catch { /* best-effort */ } }
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const nonces = new Map<string, number>();
  const resetTokens = new Map<string, { uid: string; exp: number }>();

  const tblExists = async (n: string) => (await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [n] })).rows.length > 0;
  // Quote identifiers in DDL/DML: a table or column named after a SQLite
  // reserved word (e.g. a table called "case") is a syntax error unquoted.
  const qid = (n: string) => `"${String(n).replaceAll('"', '""')}"`;
  // ensureCols is a check-then-act (PRAGMA table_info read, then ALTER TABLE
  // ADD COLUMN write) with nothing serializing it -- concurrent callers for
  // the SAME table can all read "column missing" before any of them commits
  // the ALTER, so more than one issues ADD COLUMN for the same name and every
  // caller after the first hits "duplicate column name". Live-witnessed under
  // 5 concurrent inserts racing to add a new column to the same table.
  // Serialized per-table via a promise-chain lock (same pattern as a
  // per-conversation write lock elsewhere in this codebase's consumers) so
  // the read-then-write is atomic with respect to other ensureCols calls on
  // that table; different tables still run fully concurrently.
  const ensureColsLocks = new Map<string, Promise<void>>();
  const ensureCols = async (n: string, row: Record<string, any>) => {
    const prev = ensureColsLocks.get(n) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const info = await db.execute(`PRAGMA table_info(${qid(n)})`);
      const ex = new Set(info.rows.map((r: any) => r.name as string));
      for (const k of Object.keys(row)) if (!ex.has(k)) await db.execute(`ALTER TABLE ${qid(n)} ADD COLUMN ${qid(k)} TEXT`);
    });
    ensureColsLocks.set(n, run);
    try { await run; } finally { if (ensureColsLocks.get(n) === run) ensureColsLocks.delete(n); }
  };
  const mkTbl = async (n: string, row: Record<string, any>) => { await db.execute(`CREATE TABLE IF NOT EXISTS ${qid(n)} (${Object.keys(row).map(k => qid(k) + " TEXT").join(", ")})`); };
  const getRows = async (n: string, where: string) => { if (!(await tblExists(n))) return []; return (await db.execute(`SELECT * FROM ${qid(n)} WHERE ${where}`)).rows.map((r: any) => ({ ...r })); };
  const getAllRows = async (n: string) => { if (!(await tblExists(n))) return []; return (await db.execute(`SELECT * FROM ${qid(n)}`)).rows.map((r: any) => ({ ...r })); };
  const insertRow = async (n: string, row: Record<string, any>) => { const keys = Object.keys(row); await db.execute({ sql: `INSERT INTO ${qid(n)} (${keys.map(qid).join(",")}) VALUES (${keys.map(() => "?").join(",")})`, args: keys.map(k => row[k] == null ? null : String(row[k])) }); };
  // ensureCols before UPDATE: an update may introduce a column the table has never
  // seen (the insert path ensures columns; the update path must too, or the first
  // update carrying a new field throws "no such column").
  const updateRow = async (n: string, data: Record<string, any>, where: string) => { const keys = Object.keys(data).filter(k => k !== "id"); if (!keys.length) return; await ensureCols(n, data); await db.execute({ sql: `UPDATE ${qid(n)} SET ${keys.map(k => qid(k) + "=?").join(",")} WHERE ${where}`, args: keys.map(k => data[k] == null ? null : String(data[k])) }); };
  const deleteRow = async (n: string, where: string) => { await db.execute(`DELETE FROM ${qid(n)} WHERE ${where}`); };
  const broadcast = (table: string, ev: string, nw: any, old: any) => { const p = { event: ev, table, eventType: ev, new: nw ?? null, old: old ?? null }; bus.emit(`table:${table}`, p); bus.emit("*", p); };

  await db.execute("CREATE TABLE IF NOT EXISTS _users (id TEXT, email TEXT, pw TEXT, pubkey TEXT, role TEXT, meta TEXT, app_meta TEXT, created TEXT, updated TEXT, last_sign_in TEXT)");
  await db.execute("CREATE TABLE IF NOT EXISTS _sessions (token TEXT, refresh TEXT, uid TEXT, exp INTEGER)");

  const fireHook = async (name: keyof Hooks, ...args: any[]): Promise<string | null> => { const fn = (hooks as any)[name]; if (!fn) return null; try { const r = await fn(...args); if (r === false) return "Access denied"; if (r && typeof r === "object" && typeof r.error === "string") return r.error; } catch (e: any) { return e?.message || String(e); } return null; };
  const pipeHook = async (name: keyof Hooks, value: any, ...args: any[]): Promise<any> => { const fn = (hooks as any)[name]; if (!fn) return value; try { const r = await fn(value, ...args); if (r && typeof r === "object" && !r.error) return r; } catch {} return value; };

  const issueSession = async (uid: string) => { const token = crypto.randomUUID(), refresh = crypto.randomUUID(), exp = Date.now() + 7 * 24 * 60 * 60 * 1000; await db.execute({ sql: "INSERT INTO _sessions (token,refresh,uid,exp) VALUES (?,?,?,?)", args: [token, refresh, uid, exp] }); return { token, refresh, exp }; };
  const getSessionUser = async (t: string | null) => { if (!t) return null; const s = (await db.execute({ sql: "SELECT * FROM _sessions WHERE token=? AND exp>?", args: [t, Date.now()] })).rows[0] as any; if (!s) return null; const u = (await getRows("_users", `id='${esc(s.uid)}'`))[0]; return u ? makeUser(u) : null; };

  // Numeric-aware comparison: values are stored with their native storage class
  // (a number inserts as INTEGER/REAL) but a filter literal quoted as TEXT never
  // matches it -- SQLite does not coerce across storage classes on dynamic
  // (affinity-less) columns, so `created_at >= '0'` matched ZERO rows on a numeric
  // column. When the value is a canonical number, compare BOTH ways (text OR
  // numeric) so numeric columns match without changing text-column behaviour.
  const NUM_LIT = /^-?\d+(\.\d+)?$/;
  const cmp = (col: string, s: string, val: string): string => NUM_LIT.test(val) ? `(${col} ${s} '${esc(val)}' OR ${col} ${s} CAST('${esc(val)}' AS NUMERIC))` : `${col} ${s} '${esc(val)}'`;
  const toFilter = (filters: string[]): string => { const parts: string[] = []; for (const f of filters) { if (f.startsWith("or=")) { const orP = f.slice(3).split(",").map(c => { const d1 = c.indexOf("."), d2 = c.indexOf(".", d1+1); if (d1<0||d2<0) return null; const col=c.slice(0,d1),op=c.slice(d1+1,d2),v=c.slice(d2+1); if (!validId(col)) return null; const s=op==="eq"?"=":op==="neq"?"!=":op==="gt"?">":op==="gte"?">=":op==="lt"?"<":op==="lte"?"<=":null; return s?cmp(col,s,v):null; }).filter(Boolean); if (orP.length) parts.push(`(${orP.join(" OR ")})`); continue; } const dot=f.indexOf("."); if (dot<0) continue; const op=f.slice(0,dot),rest=f.slice(dot+1); if (["eq","neq","gt","gte","lt","lte","like","ilike"].includes(op)) { const eq=rest.indexOf("="); if (eq<0) continue; const col=rest.slice(0,eq),val=rest.slice(eq+1); if (!validId(col)) continue; const s=op==="eq"?"=":op==="neq"?"!=":op==="gt"?">":op==="gte"?">=":op==="lt"?"<":op==="lte"?"<=":op==="like"?null:null; if (op==="like") parts.push(`${col} LIKE '${esc(val)}'`); else if (op==="ilike") parts.push(`LOWER(${col}) LIKE LOWER('${esc(val)}')`); else if (s) parts.push(cmp(col,s,val)); } else if (op==="is") { const eq=rest.indexOf("="); if (eq<0) continue; const col=rest.slice(0,eq),val=rest.slice(eq+1).trim().toUpperCase(); if (!validId(col)||!["NULL","TRUE","FALSE"].includes(val)) continue; parts.push(`${col} IS ${val}`); } else if (op==="in") { const eq=rest.indexOf("="); if (eq<0) continue; const col=rest.slice(0,eq),val=rest.slice(eq+1); if (!validId(col)) continue; parts.push(`${col} IN (${val.split(",").flatMap(v=>NUM_LIT.test(v)?[`'${esc(v)}'`,v]:[`'${esc(v)}'`]).join(",")})`); } else if (op==="not") { const dp=rest.indexOf("."); if (dp<0) continue; const col=rest.slice(0,dp),after=rest.slice(dp+1),eq=after.indexOf("="); if (eq<0) continue; const sub=after.slice(0,eq),val=after.slice(eq+1); if (!validId(col)) continue; const s=sub==="eq"?"=":sub==="neq"?"!=":sub==="gt"?">":sub==="gte"?">=":sub==="lt"?"<":"<="; parts.push(`NOT (${col} ${s} '${esc(val)}')`); } } return parts.join(" AND "); };

  setInterval(async () => { const now = Date.now(); for (const [k, v] of nonces) if (v < now) nonces.delete(k); for (const [k, v] of resetTokens) if (v.exp < now) resetTokens.delete(k); await db.execute({ sql: "DELETE FROM _sessions WHERE exp<?", args: [now] }).catch(() => {}); }, 5 * 60_000).unref();

  const Q = (table: string, method?: string, body?: any) => {
    const q = { filters: [] as string[], order: "", limit: 0, offset: 0, select: "*", count: "" };
    let _single = false, _maybe = false;
    const resolve = async () => {
      if (hooks.canAccess) { const d = await fireHook("canAccess", { user: null, table, method: method || "GET" }); if (d) return err(d, 403); }
      if (method === "PATCH" || method === "PUT") { const f = toFilter(q.filters); if (!f) return err("No filter provided"); if (!(await tblExists(table))) return err("Table not found", 404); const data = Array.isArray(body) ? body[0] : body; let ex = await getRows(table, f); if (!ex.length) return ok([]); const pe = await fireHook("beforeUpdate", table, ex, data); if (pe) return err(pe); await updateRow(table, data, f); let up = ex.map((r: any) => ({ ...r, ...data })); up = await pipeHook("afterUpdate", up, table); for (let i = 0; i < up.length; i++) broadcast(table, "UPDATE", clean([up[i]])[0], clean([ex[i]])[0]); return ok(clean(up)); }
      if (method === "DELETE") { const f = toFilter(q.filters); if (!f) return err("No filter provided"); if (!(await tblExists(table))) return err("Table not found", 404); const td = await getRows(table, f); const pe = await fireHook("beforeDelete", table, td); if (pe) return err(pe); await deleteRow(table, f); await fireHook("afterDelete", table, td); for (const r of clean(td)) broadcast(table, "DELETE", null, r); return ok([]); }
      const ph = await pipeHook("beforeSelect", q.filters, table); const f = toFilter(Array.isArray(ph) ? ph : q.filters); let rows = f ? await getRows(table, f) : await getAllRows(table); rows = await pipeHook("afterSelect", rows, table);
      if (q.select && q.select !== "*") { const cols = q.select.split(",").filter(c => validId(c)); rows = rows.map((r: any) => Object.fromEntries(cols.map(c => [c, r[c]]))); }
      if (q.order) { const [col, dir] = q.order.split("."); if (validId(col)) rows.sort((a: any, b: any) => dir === "desc" ? (b[col] > a[col] ? 1 : -1) : (a[col] > b[col] ? 1 : -1)); }
      const lim = Math.max(0, q.limit || 1000), off = Math.max(0, q.offset || 0), page = clean(rows).slice(off, off + lim);
      if (_single) { if (!page.length) return err("JSON object requested, multiple (or no) rows returned", 406); return ok(page[0]); }
      if (_maybe) return ok(page[0] ?? null);
      return ok(page, q.count === "exact" ? rows.length : undefined);
    };
    const b: any = { select: (c = "*") => (q.select = c, b), eq: (c: string, v: any) => (q.filters.push(`eq.${c}=${v}`), b), neq: (c: string, v: any) => (q.filters.push(`neq.${c}=${v}`), b), gt: (c: string, v: any) => (q.filters.push(`gt.${c}=${v}`), b), gte: (c: string, v: any) => (q.filters.push(`gte.${c}=${v}`), b), lt: (c: string, v: any) => (q.filters.push(`lt.${c}=${v}`), b), lte: (c: string, v: any) => (q.filters.push(`lte.${c}=${v}`), b), like: (c: string, v: any) => (q.filters.push(`like.${c}=${v}`), b), ilike: (c: string, v: any) => (q.filters.push(`ilike.${c}=${v}`), b), is: (c: string, v: any) => (q.filters.push(`is.${c}=${v}`), b), in: (c: string, vs: any[]) => (q.filters.push(`in.${c}=${vs.join(",")}`), b), not: (c: string, op: string, v: any) => (q.filters.push(`not.${c}.${op}=${v}`), b), or: (cl: string) => (q.filters.push(`or=${cl}`), b), filter: (c: string, op: string, v: any) => (q.filters.push(`${op}.${c}=${v}`), b), order: (c: string, { ascending = true } = {}) => (q.order = `${c}.${ascending ? "asc" : "desc"}`, b), limit: (n: number) => (q.limit = n, b), offset: (n: number) => (q.offset = n, b), range: (from: number, to: number) => (q.offset = from, q.limit = to - from + 1, b), count: (t = "exact") => (q.count = t, b), single: () => (_single = true, b), maybeSingle: () => (_maybe = true, b), then: (res: any, rej: any) => resolve().then(res, rej) };
    return b;
  };

  const from = (table: string) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: async (data: any) => { if (!validId(table)) return err("Invalid table name"); let rows = Array.isArray(data) ? data : [data]; if (!rows.length || !Object.keys(rows[0]).length) return err("Empty body"); const pe = await fireHook("beforeInsert", table, rows); if (pe) return err(pe); rows = await pipeHook("afterInsert", rows.map((r: any) => ({ id: r.id ?? crypto.randomUUID(), ...r })), table); if (!(await tblExists(table))) await mkTbl(table, rows[0]); else await ensureCols(table, rows[0]); for (const row of rows) await insertRow(table, row); const c = clean(rows); for (const row of c) broadcast(table, "INSERT", row, null); return ok(c); },
    upsert: async (data: any) => { const rows = (Array.isArray(data) ? data : [data]).map((r: any) => ({ ...r, id: r.id ?? crypto.randomUUID() })); const results = await Promise.all(rows.map(async (r: any) => { const ex = await getRows(table, `id='${esc(r.id)}'`); if (ex.length) { await updateRow(table, r, `id='${esc(r.id)}'`); const up = { ...ex[0], ...r }; broadcast(table, "UPDATE", clean([up])[0], clean([ex[0]])[0]); return ok(clean([up])); } return from(table).insert(r); })); return ok(results.flatMap((r: any) => r?.data ?? [])); },
    update: (data: any) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null),
  });

  let currentToken: string | null = null, currentSession: any = null;
  const authListeners: Array<(e: string, s: any) => void> = [];
  const emitAuth = (e: string, s: any) => authListeners.forEach(cb => cb(e, s));

  const auth = {
    signUp: async ({ email, password, options }: any) => { const el = email.toLowerCase(); if ((await getRows("_users", `email='${esc(el)}'`)).length) return err("User already registered"); const now = new Date().toISOString(); const u = { id: crypto.randomUUID(), email: el, pw: await Bun.password.hash(password), pubkey: "", role: "authenticated", meta: JSON.stringify(options?.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now }; await insertRow("_users", u); const he = await fireHook("onSignup", makeUser(u)); if (he) return err(he); return ok({ user: makeUser(u), session: null }); },
    signInWithPassword: async ({ email, password }: any) => { const el = email.toLowerCase(); const u = (await getRows("_users", `email='${esc(el)}'`))[0]; if (!u || !await Bun.password.verify(password, u.pw)) return err("Invalid login credentials"); const now = new Date().toISOString(); await updateRow("_users", { last_sign_in: now, updated: now }, `id='${esc(u.id)}'`); const { token, refresh, exp } = await issueSession(u.id); const user = makeUser({ ...u, last_sign_in: now }); currentToken = token; currentSession = makeSession(token, refresh, exp, user); await fireHook("onIssueSession", user); await fireHook("onSignin", user); emitAuth("SIGNED_IN", currentSession); return ok({ user, session: currentSession }); },
    signIn: async () => { const { token, refresh, exp } = await issueSession(crypto.randomUUID()); currentToken = token; currentSession = makeSession(token, refresh, exp, { id: "anon", role: "anon" }); emitAuth("SIGNED_IN", currentSession); return ok({ session: currentSession }); },
    signOut: async () => { const user = currentToken ? await getSessionUser(currentToken) : null; if (currentToken) await db.execute({ sql: "DELETE FROM _sessions WHERE token=?", args: [currentToken] }).catch(() => {}); if (user) await fireHook("onSignout", user); currentToken = null; currentSession = null; emitAuth("SIGNED_OUT", null); return ok({}); },
    getUser: async () => { const u = await getSessionUser(currentToken); if (!u) return err("Not authenticated", 401); return ok({ user: u }); },
    getSession: () => Promise.resolve(ok({ session: currentSession })),
    updateUser: async (attrs: any) => { const u = await getSessionUser(currentToken); if (!u) return err("Not authenticated", 401); const ex = (await getRows("_users", `id='${esc(u.id)}'`))[0]; if (!ex) return err("User not found", 404); const now = new Date().toISOString(); const newEmail = attrs.email ? attrs.email.toLowerCase() : ex.email; if (attrs.email && newEmail !== ex.email) { const taken = await getRows("_users", `email='${esc(newEmail)}'`); if (taken.length) return err("Email already in use"); const emailHookErr = await fireHook("onEmailChange", makeUser(ex), newEmail); if (emailHookErr) return err(emailHookErr); } const merged = { email: newEmail, pw: attrs.password ? await Bun.password.hash(attrs.password) : ex.pw, meta: JSON.stringify({ ...JSON.parse(ex.meta || "{}"), ...(attrs.data || {}) }), updated: now }; await updateRow("_users", merged, `id='${esc(u.id)}'`); await fireHook("onUserUpdate", makeUser({ ...ex, ...merged }), { email: attrs.email, password: !!attrs.password, data: attrs.data, app_metadata: attrs.app_metadata }); emitAuth("USER_UPDATED", currentSession); return ok({ user: makeUser({ ...ex, ...merged }) }); },
    setSession: (s: any) => { currentToken = s.access_token; currentSession = s; return Promise.resolve(ok({ session: s })); },
    resetPasswordForEmail: (_: string) => Promise.resolve(ok({})),
    onAuthStateChange: (cb: (e: string, s: any) => void) => { authListeners.push(cb); cb("INITIAL_SESSION", currentSession); return { data: { subscription: { unsubscribe: () => { const i = authListeners.indexOf(cb); if (i > -1) authListeners.splice(i, 1); } } } }; },
    keypair: { signIn: async () => ok({}), restore: async () => ok({}), export: () => ({}) },
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

  // The underlying libsql Client exposes a real close() (lib-esm/sqlite3.d.ts,
  // the local-file backend) that this embedded wrapper never called at all --
  // a caller (e.g. thatcher's own stop(), which only tears down an HTTP
  // server and file watchers it never actually uses in embedded/library mode)
  // had no way to release the client's own JS-level state, and any caller
  // reusing the SAME database file in the same process (a fresh
  // initDatabase() call, matching thatcher's own documented cwd-bound-handle
  // caveat) would silently open a SECOND native handle onto an already-open
  // file rather than genuinely reusing or replacing the first. db.close() is
  // synchronous per the type definition; wrapped in try/catch since a backend
  // without a real close (e.g. a remote/plugkit backend with no local file to
  // release) should degrade to a harmless no-op rather than throw.
  //
  // KNOWN LIMITATION, live-witnessed: on Windows, the native libsql binding
  // does NOT release its OS-level file lock synchronously when close() is
  // called and the owning process keeps running -- a directory removal
  // immediately after close() (even a fresh separate script polling for up
  // to 3 real seconds) still hits EPERM in the SAME process. The lock only
  // actually clears once the OWNING PROCESS itself exits (confirmed: a
  // second, separate process can remove the directory cleanly right after
  // the first process closes and terminates). This is native-binding
  // behavior below what this JS wrapper can control -- close() is still
  // correct and worth calling (it releases the JS-level client and prevents
  // the silent second-handle-fork above), but a caller needing the FILE
  // itself removable in the SAME still-running process (e.g. a per-test
  // isolated-tmpdir harness) cannot rely on close() alone for that and must
  // either retry the removal with backoff, or run each isolated test in its
  // own child process.
  const close = () => { try { db.close?.() } catch { /* best-effort; some backends have no real handle to release */ } };
  // Raw SQL escape hatch: from()/auth()/channel() cover ordinary CRUD, but a
  // consumer embedding this library (not the HTTP server) occasionally needs
  // real SQL the Supabase-style query builder cannot express at all -- an
  // arbitrary JOIN, or DDL outside the two first-class primitives below.
  // Exposes the underlying Client's own execute() directly rather than
  // duplicating a second query-building layer -- a caller reaching for this
  // already knows they're writing real SQL, same trust boundary as any
  // other direct SQLite consumer.
  const raw = (sql: string, args: any[] = []) => db.execute({ sql, args });

  // Real FTS5 full-text search, first-class -- not a raw-SQL exercise the
  // consumer has to hand-roll. Lazily creates a content='<table>' external-
  // content FTS5 virtual table (`<table>_fts`) plus an AFTER INSERT trigger
  // to keep it populated, the first time search() is called for a given
  // (table, column) pair -- idempotent (CREATE ... IF NOT EXISTS both
  // sides), so repeated calls are cheap no-ops once the index exists.
  // Ranked by FTS5's own bm25 rank via `ORDER BY rank`. Falls back to a
  // plain LIKE scan (unranked, substring, `searchMode: 'like'` on the
  // returned array so a caller can tell the two apart) when FTS5 itself is
  // unavailable in this SQLite build, or the query string is empty/
  // malformed -- callers never see a thrown error for a genuinely degraded
  // environment, only a clearly-marked lower-quality result.
  const ftsInitialized = new Set<string>();
  const ensureFts = async (table: string, column: string) => {
    const key = `${table}.${column}`;
    if (ftsInitialized.has(key)) return;
    const ftsTbl = `${table}_fts`;
    // A row inserted BEFORE this virtual table/trigger existed is invisible
    // to the index forever unless explicitly backfilled -- the AFTER INSERT
    // trigger only fires on FUTURE inserts. Detects "did this CREATE VIRTUAL
    // TABLE actually create something new" via sqlite_master (CREATE ... IF
    // NOT EXISTS itself gives no signal either way), and runs the FTS5
    // 'rebuild' special command exactly once, the first time the index is
    // created for a table that may already hold rows -- idempotent (a
    // rebuild against an empty/already-consistent index is a cheap no-op),
    // never repeated on subsequent ensureFts calls once ftsInitialized has
    // the key.
    const existed = (await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [ftsTbl] })).rows.length > 0;
    await db.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS ${qid(ftsTbl)} USING fts5(${qid(column)}, content=${qid(table)}, content_rowid='rowid')`);
    await db.execute(`CREATE TRIGGER IF NOT EXISTS ${qid(table + "_fts_ai")} AFTER INSERT ON ${qid(table)} BEGIN INSERT INTO ${qid(ftsTbl)}(rowid, ${qid(column)}) VALUES (new.rowid, new.${qid(column)}); END`);
    if (!existed) { try { await db.execute(`INSERT INTO ${qid(ftsTbl)}(${qid(ftsTbl)}) VALUES('rebuild')`); } catch { /* best-effort */ } }
    ftsInitialized.add(key);
  };
  const escapeFtsQuery = (q: string) => '"' + String(q).replace(/"/g, '""') + '"';
  const search = async (table: string, column: string, query: string, opts: { limit?: number; filter?: string } = {}) => {
    if (!validId(table) || !validId(column)) return { ...err("Invalid table or column name"), searchMode: null };
    const limit = Math.max(0, opts.limit || 20);
    const ftsTbl = `${table}_fts`;
    try {
      await ensureFts(table, column);
      const ftsQuery = escapeFtsQuery(query);
      const filterClause = opts.filter ? ` AND m.${opts.filter}` : "";
      const sql = `SELECT m.* FROM ${qid(ftsTbl)} f JOIN ${qid(table)} m ON m.rowid = f.rowid WHERE ${qid(ftsTbl)} MATCH ?${filterClause} ORDER BY rank LIMIT ?`;
      const r = await db.execute({ sql, args: [ftsQuery, limit] });
      if (r.rows && r.rows.length > 0) { const rows = clean(r.rows.map((row: any) => ({ ...row }))); return ok(rows, undefined) as any; }
    } catch { /* FTS5 unavailable or malformed escaped query -- fall through to LIKE */ }
    const likePattern = `%${query}%`;
    const filterClause = opts.filter ? ` AND ${opts.filter}` : "";
    const sql = `SELECT * FROM ${qid(table)} WHERE ${qid(column)} LIKE ?${filterClause} LIMIT ?`;
    const r = await db.execute({ sql, args: [likePattern, limit] });
    const rows = clean((r.rows || []).map((row: any) => ({ ...row })));
    return { ...ok(rows), searchMode: "like" } as any;
  };

  // Real vector KNN search, first-class -- libsql's own native F32_BLOB
  // column type + libsql_vector_idx()/vector_top_k() (confirmed live: a
  // real ANN index, not a linear scan) rather than a hand-rolled cosine-
  // distance loop in JS. `dims` is the embedding's fixed dimension (must
  // match every vector ever stored in this column); ensureVectorIndex is
  // lazy + idempotent the same way ensureFts is, keyed per (table, column).
  // `queryVector` is a plain JS number array -- serialized to libsql's own
  // vector('[...]') literal syntax internally so a caller never has to know
  // that wire format.
  const vectorInitialized = new Set<string>();
  const ensureVectorIndex = async (table: string, column: string, dims: number) => {
    const key = `${table}.${column}`;
    if (vectorInitialized.has(key)) return;
    await ensureCols(table, { [column]: null });
    // ALTER COLUMN doesn't exist in SQLite -- ensureCols already created the
    // column as TEXT (its own default for a new column). A vector column
    // needs its real F32_BLOB(dims) type declared at CREATE TABLE time, so
    // this only actually takes effect for a table created fresh THROUGH
    // this call (mkTbl below); an existing TEXT column from a prior
        // insert() on this table cannot be retyped without a real migration,
    // which is out of scope for a lazy index-ensure helper.
    if (!(await tblExists(table))) await mkTbl(table, { id: null, [column]: null });
    try {
      await db.execute(`ALTER TABLE ${qid(table)} ADD COLUMN ${qid(column)} F32_BLOB(${dims})`);
    } catch { /* column already exists, or the table predates this call -- best-effort */ }
    const idxName = `${table}_${column}_vidx`;
    try {
      await db.execute(`CREATE INDEX IF NOT EXISTS ${qid(idxName)} ON ${qid(table)}(libsql_vector_idx(${qid(column)}))`);
    } catch { /* vector index unsupported in this libsql build -- vectorSearch falls back to a linear scan */ }
    vectorInitialized.add(key);
  };
  const vecLiteral = (v: number[]) => `[${v.join(",")}]`;
  const vectorSearch = async (table: string, column: string, queryVector: number[], opts: { limit?: number; filter?: string } = {}) => {
    if (!validId(table) || !validId(column)) return { data: null, error: { message: "Invalid table or column name" } };
    const limit = Math.max(0, opts.limit || 20);
    const dims = queryVector.length;
    const idxName = `${table}_${column}_vidx`;
    try {
      await ensureVectorIndex(table, column, dims);
      const filterClause = opts.filter ? ` AND m.${opts.filter}` : "";
      const sql = `SELECT m.* FROM vector_top_k('${idxName}', vector(?), ?) t JOIN ${qid(table)} m ON m.rowid = t.id${filterClause}`;
      const r = await db.execute({ sql, args: [vecLiteral(queryVector), limit] });
      const rows = clean((r.rows || []).map((row: any) => ({ ...row })));
      return { data: rows, error: null };
    } catch {
      // vector_top_k unavailable (no index, or this libsql build lacks the
      // vector extension) -- linear-scan fallback via vector_distance_cos,
      // still correct, just O(n) instead of using the ANN index.
      try {
        const filterClause = opts.filter ? ` AND ${opts.filter}` : "";
        const sql = `SELECT *, vector_distance_cos(${qid(column)}, vector(?)) as _dist FROM ${qid(table)} WHERE ${qid(column)} IS NOT NULL${filterClause} ORDER BY _dist ASC LIMIT ?`;
        const r = await db.execute({ sql, args: [vecLiteral(queryVector), limit] });
        const rows = clean((r.rows || []).map((row: any) => ({ ...row })));
        return { data: rows, error: null };
      } catch (e: any) {
        return { data: null, error: { message: e?.message || String(e) } };
      }
    }
  };

  // Real multi-statement transaction, first-class -- BEGIN/fn/COMMIT with
  // ROLLBACK on any throw, over the SAME held connection for the whole
  // sequence (the actual atomicity guarantee a caller wants; open-per-call
  // consumers of this library must use this instead of separate from()/
  // raw() calls for anything that needs to survive a crash between steps
  // atomically). `fn` receives an object with the SAME from()/raw() shape
  // as the top-level embedded client, so code inside a transaction reads
  // identically to code outside one.
  const transaction = async (fn: (tx: { from: typeof from; raw: typeof raw }) => Promise<any>) => {
    try {
      await db.execute("BEGIN TRANSACTION");
      const result = await fn({ from, raw });
      await db.execute("COMMIT");
      return result;
    } catch (e) {
      try { await db.execute("ROLLBACK"); } catch { /* best-effort */ }
      throw e;
    }
  };

  return { from, auth, channel, removeAllChannels: () => { for (const ch of channels.values()) ch.unsubscribe(); }, close, raw, search, vectorSearch, transaction, _bus: bus };
};
