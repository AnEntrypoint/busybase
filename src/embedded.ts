import { connect, type Table } from "vectordb";
import { EventEmitter } from "node:events";
import type { Hooks } from "./hooks.ts";

const SENTINEL = "_sentinel_";
const Z = [0];
const esc = (s: string) => s.replace(/'/g, "''");
const real = (col = "id") => `${col.toLowerCase()} != '${SENTINEL}'`;
const sqlCol = (col: string) => col.toLowerCase();

const validId = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";

const execFilter = async (t: Table, filter: string): Promise<any[]> => {
  try { return await t.filter(filter).execute() as any[]; }
  catch { return []; }
};

const makeUser = (u: any) => ({
  id: u.id, email: u.email || null, role: u.role || "authenticated",
  user_metadata: JSON.parse(u.meta || "{}"),
  app_metadata: JSON.parse(u.app_meta || "{}"),
  identities: [], aud: "authenticated",
  created_at: u.created, updated_at: u.updated || u.created,
  last_sign_in_at: u.last_sign_in || u.created,
  email_confirmed_at: u.email ? u.created : null,
});

const makeSession = (token: string, refresh: string, exp: number, user: any) => ({
  access_token: token, refresh_token: refresh,
  token_type: "bearer", expires_in: 604800,
  expires_at: Math.floor(exp / 1000), user,
});

const clean = (rows: any[]) => rows.map(({ vector, pw, pubkey: _pk, ...r }) => r);

const ok = (data: any, count?: number) => count !== undefined
  ? { data, error: null, count }
  : { data, error: null };
const err = (message: string, code = 400) => ({ data: null, error: { message, code } });

export interface EmbeddedConfig {
  dir?: string;
  hooks?: Hooks;
}

export const createEmbedded = async (config: EmbeddedConfig = {}) => {
  const dir = config.dir || "busybase_data";
  const hooks = config.hooks || {};
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  const vdb = await connect(dir);
  const tableCache = new Map<string, Table>();
  const nonces = new Map<string, number>();
  const resetTokens = new Map<string, { uid: string; exp: number }>();

  const openTbl = async (name: string): Promise<Table | null> => {
    if (tableCache.has(name)) return tableCache.get(name)!;
    const names = await vdb.tableNames();
    if (!names.includes(name)) return null;
    const t = await vdb.openTable(name);
    tableCache.set(name, t);
    return t;
  };

  const mkTbl = async (name: string, schema: any[]): Promise<Table> => {
    const t = await vdb.createTable(name, schema);
    tableCache.set(name, t);
    return t;
  };

  if (!(await openTbl("_users")))
    await mkTbl("_users", [{ id: SENTINEL, email: SENTINEL, pw: "", pubkey: "", role: "authenticated", meta: "{}", app_meta: "{}", created: "", updated: "", last_sign_in: "", vector: Z }]);
  if (!(await openTbl("_sessions")))
    await mkTbl("_sessions", [{ token: SENTINEL, refresh: SENTINEL, uid: "", exp: 0, vector: Z }]);

  const getRows = async (name: string, filter: string): Promise<any[]> => {
    const t = await openTbl(name);
    if (!t) return [];
    return execFilter(t, `(${real(name === "_sessions" ? "token" : "id")}) AND (${filter})`);
  };

  const getAllRows = async (name: string): Promise<any[]> => {
    const t = await openTbl(name);
    if (!t) return [];
    return execFilter(t, real("id"));
  };

  const fireHook = async (name: keyof Hooks, ...args: any[]): Promise<string | null> => {
    const fn = (hooks as any)[name];
    if (!fn) return null;
    try {
      const r = await fn(...args);
      if (r === false) return "Access denied";
      if (r && typeof r === "object" && typeof r.error === "string") return r.error;
    } catch (e: any) { return e?.message || String(e); }
    return null;
  };

  const pipeHook = async (name: keyof Hooks, value: any, ...args: any[]): Promise<any> => {
    const fn = (hooks as any)[name];
    if (!fn) return value;
    try {
      const r = await fn(value, ...args);
      if (r && typeof r === "object" && !r.error) return r;
    } catch {}
    return value;
  };

  const broadcastChange = (table: string, eventType: "INSERT" | "UPDATE" | "DELETE", newRow: any, oldRow: any) => {
    const payload = { event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null };
    bus.emit(`table:${table}`, payload);
    bus.emit("*", payload);
  };

  const issueSession = async (uid: string) => {
    const token = crypto.randomUUID(), refresh = crypto.randomUUID();
    const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await (await openTbl("_sessions"))!.add([{ token, refresh, uid, exp, vector: Z }]);
    return { token, refresh, exp };
  };

  const getSessionUser = async (accessToken: string | null) => {
    if (!accessToken) return null;
    const sessions = await getRows("_sessions", `token = '${esc(accessToken)}'`);
    const s = sessions[0];
    if (!s || s.exp < Date.now()) return null;
    const users = await getRows("_users", `id = '${esc(s.uid)}'`);
    return users[0] ? makeUser(users[0]) : null;
  };

  setInterval(async () => {
    const now = Date.now();
    for (const [k, exp] of nonces) if (exp < now) nonces.delete(k);
    for (const [k, v] of resetTokens) if (v.exp < now) resetTokens.delete(k);
    const st = await openTbl("_sessions");
    if (st) {
      const expired = await execFilter(st, `exp < ${now} AND token != '${SENTINEL}'`);
      for (const s of expired) { try { await st.delete(`token = '${esc(s.token)}'`); } catch {} }
    }
  }, 5 * 60_000).unref();

  const toFilter = (filters: string[]): string => {
    const parts: string[] = [];
    for (const f of filters) {
      const dot = f.indexOf(".");
      if (dot < 0) continue;
      const op = f.slice(0, dot), rest = f.slice(dot + 1);
      if (op === "eq" || op === "neq" || op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        const eqPos = rest.indexOf("=");
        if (eqPos < 0) continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1);
        if (!validId(col)) continue;
        const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
        parts.push(`${sqlCol(col)} ${s} '${esc(val)}'`);
      } else if (op === "like" || op === "ilike") {
        const eqPos = rest.indexOf("=");
        if (eqPos < 0) continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1);
        if (!validId(col)) continue;
        parts.push(op === "like" ? `${sqlCol(col)} LIKE '${esc(val)}'` : `LOWER(${sqlCol(col)}) LIKE LOWER('${esc(val)}')`);
      } else if (op === "is") {
        const eqPos = rest.indexOf("=");
        if (eqPos < 0) continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1).trim().toUpperCase();
        if (!validId(col) || !["NULL", "TRUE", "FALSE"].includes(val)) continue;
        parts.push(`${sqlCol(col)} IS ${val}`);
      } else if (op.startsWith("in.")) {
        const col = op.slice(3);
        if (!validId(col)) continue;
        const list = rest.split(",").map(v => `'${esc(v)}'`).join(",");
        parts.push(`${sqlCol(col)} IN (${list})`);
      } else if (op.startsWith("not.")) {
        const subop = op.slice(4), eqPos = rest.indexOf("=");
        if (eqPos < 0) continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1);
        if (!validId(col)) continue;
        const s = subop === "eq" ? "=" : subop === "neq" ? "!=" : "=";
        parts.push(`NOT (${sqlCol(col)} ${s} '${esc(val)}')`);
      }
    }
    return parts.join(" AND ");
  };

  const Q = (table: string, methodOverride?: string, bodyOverride?: any) => {
    const q = { filters: [] as string[], order: "", limit: 0, offset: 0, select: "*", count: "" };
    let _single = false, _maybeSingle = false;

    const resolve = async () => {
      if (hooks.canAccess) {
        const denied = await fireHook("canAccess", { user: null, table, method: methodOverride || "GET" });
        if (denied) return err(denied, 403);
      }

      if (methodOverride === "PATCH" || methodOverride === "PUT") {
        const filter = toFilter(q.filters);
        if (!filter) return err("No filter provided");
        const t = await openTbl(table);
        if (!t) return err("Table not found", 404);
        const data = Array.isArray(bodyOverride) ? bodyOverride[0] : bodyOverride;
        let existing = await getRows(table, filter);
        if (!existing.length) return ok([]);
        const preErr = await fireHook("beforeUpdate", table, existing, data);
        if (preErr) return err(preErr);
        await t.delete(`(${real()}) AND (${filter})`);
        let updated = existing.map((r: any) => ({ ...r, ...data, vector: r.vector ?? Z }));
        updated = await pipeHook("afterUpdate", updated, table);
        await t.add(updated);
        for (let i = 0; i < updated.length; i++) broadcastChange(table, "UPDATE", clean([updated[i]])[0], clean([existing[i]])[0]);
        return ok(clean(updated));
      }

      if (methodOverride === "DELETE") {
        const filter = toFilter(q.filters);
        if (!filter) return err("No filter provided");
        const t = await openTbl(table);
        if (!t) return err("Table not found", 404);
        const toDelete = await getRows(table, filter);
        const preErr = await fireHook("beforeDelete", table, toDelete);
        if (preErr) return err(preErr);
        await t.delete(`(${real()}) AND (${filter})`);
        await fireHook("afterDelete", table, toDelete);
        for (const row of clean(toDelete)) broadcastChange(table, "DELETE", null, row);
        return ok([]);
      }

      const paramsHooked = await pipeHook("beforeSelect", q.filters, table);
      const filter = toFilter(Array.isArray(paramsHooked) ? paramsHooked : q.filters);
      let rows = filter ? await getRows(table, filter) : await getAllRows(table);
      rows = await pipeHook("afterSelect", rows, table);

      if (q.select && q.select !== "*") {
        const cols = q.select.split(",").filter(c => validId(c));
        rows = rows.map((r: any) => Object.fromEntries(cols.map((c: string) => [c, r[c]])));
      }

      if (q.order) {
        const [col, dir] = q.order.split(".");
        if (validId(col)) rows.sort((a: any, b: any) => dir === "desc" ? (b[col] > a[col] ? 1 : -1) : (a[col] > b[col] ? 1 : -1));
      }

      const limit = Math.max(0, q.limit || 1000);
      const offset = Math.max(0, q.offset || 0);
      const page = clean(rows).slice(offset, offset + limit);

      if (_single) {
        if (!page.length) return err("JSON object requested, multiple (or no) rows returned", 406);
        return ok(page[0]);
      }
      if (_maybeSingle) return ok(page[0] ?? null);

      const countVal = q.count === "exact" ? rows.length : undefined;
      return ok(page, countVal);
    };

    const b: any = {
      select: (cols = "*") => (q.select = cols, b),
      eq: (col: string, val: any) => (q.filters.push(`eq.${col}=${val}`), b),
      neq: (col: string, val: any) => (q.filters.push(`neq.${col}=${val}`), b),
      gt: (col: string, val: any) => (q.filters.push(`gt.${col}=${val}`), b),
      gte: (col: string, val: any) => (q.filters.push(`gte.${col}=${val}`), b),
      lt: (col: string, val: any) => (q.filters.push(`lt.${col}=${val}`), b),
      lte: (col: string, val: any) => (q.filters.push(`lte.${col}=${val}`), b),
      like: (col: string, val: any) => (q.filters.push(`like.${col}=${val}`), b),
      ilike: (col: string, val: any) => (q.filters.push(`ilike.${col}=${val}`), b),
      is: (col: string, val: any) => (q.filters.push(`is.${col}=${val}`), b),
      in: (col: string, vals: any[]) => (q.filters.push(`in.${col}=${vals.join(",")}`), b),
      not: (col: string, op: string, val: any) => (q.filters.push(`not.${col}.${op}=${val}`), b),
      order: (col: string, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit: (n: number) => (q.limit = n, b),
      offset: (n: number) => (q.offset = n, b),
      range: (from: number, to: number) => (q.offset = from, q.limit = to - from + 1, b),
      count: (type = "exact") => (q.count = type, b),
      single: () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      then: (res: any, rej: any) => resolve().then(res, rej),
    };
    return b;
  };

  const from = (table: string) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: async (data: any) => {
      if (!validId(table)) return err("Invalid table name");
      let rows = Array.isArray(data) ? data : [data];
      if (!rows.length || !Object.keys(rows[0]).length) return err("Empty body");
      const preErr = await fireHook("beforeInsert", table, rows);
      if (preErr) return err(preErr);
      rows = await pipeHook("afterInsert", rows.map((r: any) => ({ id: r.id ?? crypto.randomUUID(), ...r, vector: r.vector ?? Z })), table);
      let t = await openTbl(table);
      if (!t) t = await mkTbl(table, rows);
      else await t.add(rows);
      const cleaned = clean(rows);
      for (const row of cleaned) broadcastChange(table, "INSERT", row, null);
      return ok(cleaned);
    },
    upsert: async (data: any) => {
      const rows = Array.isArray(data) ? data : [data];
      const withIds = rows.map((r: any) => ({ ...r, id: r.id ?? crypto.randomUUID() }));
      const results = await Promise.all(withIds.map(async (r: any) => {
        const existing = await getRows(table, `id = '${esc(r.id)}'`);
        if (existing.length) {
          const t = await openTbl(table);
          if (!t) return ok([]);
          await t.delete(`id = '${esc(r.id)}'`);
          const updated = { ...existing[0], ...r, vector: existing[0].vector ?? Z };
          await t.add([updated]);
          broadcastChange(table, "UPDATE", clean([updated])[0], clean([existing[0]])[0]);
          return ok(clean([updated]));
        }
        return from(table).insert(r);
      }));
      return ok(results.flatMap((r: any) => r?.data ?? []));
    },
    update: (data: any) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null),
  });

  let currentToken: string | null = null;
  let currentSession: any = null;
  const authListeners: Array<(event: string, session: any) => void> = [];
  const emitAuth = (event: string, s: any) => authListeners.forEach(cb => cb(event, s));

  const auth = {
    signUp: async ({ email, password, options }: { email: string; password: string; options?: any }) => {
      const emailLower = email.toLowerCase();
      const existing = await getRows("_users", `email = '${esc(emailLower)}'`);
      if (existing.length) return err("User already registered");
      const now = new Date().toISOString();
      const u = { id: crypto.randomUUID(), email: emailLower, pw: await Bun.password.hash(password), pubkey: "", role: "authenticated", meta: JSON.stringify(options?.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now, vector: Z };
      await (await openTbl("_users"))!.add([u]);
      const hookErr = await fireHook("onSignup", makeUser(u));
      if (hookErr) return err(hookErr);
      return ok({ user: makeUser(u), session: null });
    },

    signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
      const emailLower = email.toLowerCase();
      const users = await getRows("_users", `email = '${esc(emailLower)}'`);
      const u = users[0];
      if (!u || !await Bun.password.verify(password, u.pw)) return err("Invalid login credentials");
      const now = new Date().toISOString();
      const ut = (await openTbl("_users"))!;
      await ut.delete(`id = '${esc(u.id)}'`);
      await ut.add([{ ...u, last_sign_in: now, updated: now }]);
      const { token, refresh, exp } = await issueSession(u.id);
      const user = makeUser({ ...u, last_sign_in: now });
      currentToken = token;
      currentSession = makeSession(token, refresh, exp, user);
      await fireHook("onSignin", user);
      emitAuth("SIGNED_IN", currentSession);
      return ok({ user, session: currentSession });
    },

    signIn: async () => {
      const { token: access, refresh, exp } = await issueSession(crypto.randomUUID());
      currentToken = access;
      currentSession = makeSession(access, refresh, exp, { id: "anon", role: "anon" });
      emitAuth("SIGNED_IN", currentSession);
      return ok({ session: currentSession });
    },

    signOut: async () => {
      if (currentToken) {
        const st = await openTbl("_sessions");
        if (st) await st.delete(`token = '${esc(currentToken)}'`);
      }
      currentToken = null;
      currentSession = null;
      emitAuth("SIGNED_OUT", null);
      return ok({});
    },

    getUser: async () => {
      const user = await getSessionUser(currentToken);
      if (!user) return err("Not authenticated", 401);
      return ok({ user });
    },

    getSession: () => Promise.resolve(ok({ session: currentSession })),

    updateUser: async (attrs: { email?: string; password?: string; data?: any }) => {
      const user = await getSessionUser(currentToken);
      if (!user) return err("Not authenticated", 401);
      const existing = await getRows("_users", `id = '${esc(user.id)}'`);
      const u = existing[0];
      if (!u) return err("User not found", 404);
      const now = new Date().toISOString();
      const merged = {
        ...u,
        email: attrs.email ? attrs.email.toLowerCase() : u.email,
        pw: attrs.password ? await Bun.password.hash(attrs.password) : u.pw,
        meta: JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...(attrs.data || {}) }),
        updated: now,
      };
      const ut = (await openTbl("_users"))!;
      await ut.delete(`id = '${esc(u.id)}'`);
      await ut.add([merged]);
      emitAuth("USER_UPDATED", currentSession);
      return ok({ user: makeUser(merged) });
    },

    setSession: (s: { access_token: string; refresh_token: string }) => {
      currentToken = s.access_token;
      currentSession = s;
      return Promise.resolve(ok({ session: s }));
    },

    resetPasswordForEmail: (_email: string) => Promise.resolve(ok({})),

    onAuthStateChange: (cb: (event: string, session: any) => void) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", currentSession);
      return { data: { subscription: { unsubscribe: () => { const i = authListeners.indexOf(cb); if (i > -1) authListeners.splice(i, 1); } } } };
    },
  };

  const channels = new Map<string, any>();

  const channel = (name: string) => {
    const handlers: Array<{ event: string; table: string; cb: (payload: any) => void; listener: (p: any) => void }> = [];
    const ch: any = {
      on: (type: string, opts: { event: string; schema?: string; table: string }, cb: (payload: any) => void) => {
        const listener = (payload: any) => {
          if (opts.event === "*" || opts.event === payload.eventType) cb(payload);
        };
        handlers.push({ event: opts.event, table: opts.table, cb, listener });
        return ch;
      },
      subscribe: (statusCb?: (status: string) => void) => {
        for (const h of handlers) bus.on(`table:${h.table}`, h.listener);
        statusCb?.("SUBSCRIBED");
        channels.set(name, ch);
        return ch;
      },
      unsubscribe: () => {
        for (const h of handlers) bus.off(`table:${h.table}`, h.listener);
        channels.delete(name);
      },
    };
    return ch;
  };

  const removeAllChannels = () => { for (const ch of channels.values()) ch.unsubscribe(); };

  return { from, auth, channel, removeAllChannels, _bus: bus };
};
