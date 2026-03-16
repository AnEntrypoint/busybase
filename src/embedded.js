// @bun
// src/embedded.ts
import { connect } from "vectordb";
import { EventEmitter } from "events";
var SENTINEL = "_sentinel_";
var Z = [0];
var esc = (s) => s.replace(/'/g, "''");
var real = (col = "id") => `${col.toLowerCase()} != '${SENTINEL}'`;
var sqlCol = (col) => col.toLowerCase();
var validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";
var execFilter = async (t, filter) => {
  try {
    return await t.filter(filter).execute();
  } catch {
    return [];
  }
};
var makeUser = (u) => ({
  id: u.id,
  email: u.email || null,
  role: u.role || "authenticated",
  user_metadata: JSON.parse(u.meta || "{}"),
  app_metadata: JSON.parse(u.app_meta || "{}"),
  identities: [],
  aud: "authenticated",
  created_at: u.created,
  updated_at: u.updated || u.created,
  last_sign_in_at: u.last_sign_in || u.created,
  email_confirmed_at: u.email ? u.created : null
});
var makeSession = (token, refresh, exp, user) => ({
  access_token: token,
  refresh_token: refresh,
  token_type: "bearer",
  expires_in: 604800,
  expires_at: Math.floor(exp / 1000),
  user
});
var clean = (rows) => rows.map(({ vector, pw, pubkey: _pk, ...r }) => r);
var ok = (data, count) => count !== undefined ? { data, error: null, count } : { data, error: null };
var err = (message, code = 400) => ({ data: null, error: { message, code } });
var createEmbedded = async (config = {}) => {
  const dir = config.dir || "busybase_data";
  const hooks = config.hooks || {};
  const bus = new EventEmitter;
  bus.setMaxListeners(0);
  const vdb = await connect(dir);
  const tableCache = new Map;
  const nonces = new Map;
  const resetTokens = new Map;
  const openTbl = async (name) => {
    if (tableCache.has(name))
      return tableCache.get(name);
    const names = await vdb.tableNames();
    if (!names.includes(name))
      return null;
    const t = await vdb.openTable(name);
    tableCache.set(name, t);
    return t;
  };
  const mkTbl = async (name, schema) => {
    const t = await vdb.createTable(name, schema);
    tableCache.set(name, t);
    return t;
  };
  if (!await openTbl("_users"))
    await mkTbl("_users", [{ id: SENTINEL, email: SENTINEL, pw: "", pubkey: "", role: "authenticated", meta: "{}", app_meta: "{}", created: "", updated: "", last_sign_in: "", vector: Z }]);
  if (!await openTbl("_sessions"))
    await mkTbl("_sessions", [{ token: SENTINEL, refresh: SENTINEL, uid: "", exp: 0, vector: Z }]);
  const getRows = async (name, filter) => {
    const t = await openTbl(name);
    if (!t)
      return [];
    return execFilter(t, `(${real(name === "_sessions" ? "token" : "id")}) AND (${filter})`);
  };
  const getAllRows = async (name) => {
    const t = await openTbl(name);
    if (!t)
      return [];
    return execFilter(t, real("id"));
  };
  const fireHook = async (name, ...args) => {
    const fn = hooks[name];
    if (!fn)
      return null;
    try {
      const r = await fn(...args);
      if (r === false)
        return "Access denied";
      if (r && typeof r === "object" && typeof r.error === "string")
        return r.error;
    } catch (e) {
      return e?.message || String(e);
    }
    return null;
  };
  const pipeHook = async (name, value, ...args) => {
    const fn = hooks[name];
    if (!fn)
      return value;
    try {
      const r = await fn(value, ...args);
      if (r && typeof r === "object" && !r.error)
        return r;
    } catch {}
    return value;
  };
  const broadcastChange = (table, eventType, newRow, oldRow) => {
    const payload = { event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null };
    bus.emit(`table:${table}`, payload);
    bus.emit("*", payload);
  };
  const issueSession = async (uid) => {
    const token = crypto.randomUUID(), refresh = crypto.randomUUID();
    const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
    await (await openTbl("_sessions")).add([{ token, refresh, uid, exp, vector: Z }]);
    return { token, refresh, exp };
  };
  const getSessionUser = async (accessToken) => {
    if (!accessToken)
      return null;
    const sessions = await getRows("_sessions", `token = '${esc(accessToken)}'`);
    const s = sessions[0];
    if (!s || s.exp < Date.now())
      return null;
    const users = await getRows("_users", `id = '${esc(s.uid)}'`);
    return users[0] ? makeUser(users[0]) : null;
  };
  setInterval(async () => {
    const now = Date.now();
    for (const [k, exp] of nonces)
      if (exp < now)
        nonces.delete(k);
    for (const [k, v] of resetTokens)
      if (v.exp < now)
        resetTokens.delete(k);
    const st = await openTbl("_sessions");
    if (st) {
      const expired = await execFilter(st, `exp < ${now} AND token != '${SENTINEL}'`);
      for (const s of expired) {
        try {
          await st.delete(`token = '${esc(s.token)}'`);
        } catch {}
      }
    }
  }, 5 * 60000).unref();
  const toFilter = (filters) => {
    const parts = [];
    for (const f of filters) {
      const dot = f.indexOf(".");
      if (dot < 0)
        continue;
      const op = f.slice(0, dot), rest = f.slice(dot + 1);
      if (op === "eq" || op === "neq" || op === "gt" || op === "gte" || op === "lt" || op === "lte") {
        const eqPos = rest.indexOf("=");
        if (eqPos < 0)
          continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1);
        if (!validId(col))
          continue;
        const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
        parts.push(`${sqlCol(col)} ${s} '${esc(val)}'`);
      } else if (op === "like" || op === "ilike") {
        const eqPos = rest.indexOf("=");
        if (eqPos < 0)
          continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1);
        if (!validId(col))
          continue;
        parts.push(op === "like" ? `${sqlCol(col)} LIKE '${esc(val)}'` : `LOWER(${sqlCol(col)}) LIKE LOWER('${esc(val)}')`);
      } else if (op === "is") {
        const eqPos = rest.indexOf("=");
        if (eqPos < 0)
          continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1).trim().toUpperCase();
        if (!validId(col) || !["NULL", "TRUE", "FALSE"].includes(val))
          continue;
        parts.push(`${sqlCol(col)} IS ${val}`);
      } else if (op.startsWith("in.")) {
        const col = op.slice(3);
        if (!validId(col))
          continue;
        const list = rest.split(",").map((v) => `'${esc(v)}'`).join(",");
        parts.push(`${sqlCol(col)} IN (${list})`);
      } else if (op.startsWith("not.")) {
        const subop = op.slice(4), eqPos = rest.indexOf("=");
        if (eqPos < 0)
          continue;
        const col = rest.slice(0, eqPos), val = rest.slice(eqPos + 1);
        if (!validId(col))
          continue;
        const s = subop === "eq" ? "=" : subop === "neq" ? "!=" : "=";
        parts.push(`NOT (${sqlCol(col)} ${s} '${esc(val)}')`);
      }
    }
    return parts.join(" AND ");
  };
  const Q = (table, methodOverride, bodyOverride) => {
    const q = { filters: [], order: "", limit: 0, offset: 0, select: "*", count: "" };
    let _single = false, _maybeSingle = false;
    const resolve = async () => {
      if (hooks.canAccess) {
        const denied = await fireHook("canAccess", { user: null, table, method: methodOverride || "GET" });
        if (denied)
          return err(denied, 403);
      }
      if (methodOverride === "PATCH" || methodOverride === "PUT") {
        const filter2 = toFilter(q.filters);
        if (!filter2)
          return err("No filter provided");
        const t = await openTbl(table);
        if (!t)
          return err("Table not found", 404);
        const data = Array.isArray(bodyOverride) ? bodyOverride[0] : bodyOverride;
        let existing = await getRows(table, filter2);
        if (!existing.length)
          return ok([]);
        const preErr = await fireHook("beforeUpdate", table, existing, data);
        if (preErr)
          return err(preErr);
        await t.delete(`(${real()}) AND (${filter2})`);
        let updated = existing.map((r) => ({ ...r, ...data, vector: r.vector ?? Z }));
        updated = await pipeHook("afterUpdate", updated, table);
        await t.add(updated);
        for (let i = 0;i < updated.length; i++)
          broadcastChange(table, "UPDATE", clean([updated[i]])[0], clean([existing[i]])[0]);
        return ok(clean(updated));
      }
      if (methodOverride === "DELETE") {
        const filter2 = toFilter(q.filters);
        if (!filter2)
          return err("No filter provided");
        const t = await openTbl(table);
        if (!t)
          return err("Table not found", 404);
        const toDelete = await getRows(table, filter2);
        const preErr = await fireHook("beforeDelete", table, toDelete);
        if (preErr)
          return err(preErr);
        await t.delete(`(${real()}) AND (${filter2})`);
        await fireHook("afterDelete", table, toDelete);
        for (const row of clean(toDelete))
          broadcastChange(table, "DELETE", null, row);
        return ok([]);
      }
      const paramsHooked = await pipeHook("beforeSelect", q.filters, table);
      const filter = toFilter(Array.isArray(paramsHooked) ? paramsHooked : q.filters);
      let rows = filter ? await getRows(table, filter) : await getAllRows(table);
      rows = await pipeHook("afterSelect", rows, table);
      if (q.select && q.select !== "*") {
        const cols = q.select.split(",").filter((c) => validId(c));
        rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
      }
      if (q.order) {
        const [col, dir2] = q.order.split(".");
        if (validId(col))
          rows.sort((a, b2) => dir2 === "desc" ? b2[col] > a[col] ? 1 : -1 : a[col] > b2[col] ? 1 : -1);
      }
      const limit = Math.max(0, q.limit || 1000);
      const offset = Math.max(0, q.offset || 0);
      const page = clean(rows).slice(offset, offset + limit);
      if (_single) {
        if (!page.length)
          return err("JSON object requested, multiple (or no) rows returned", 406);
        return ok(page[0]);
      }
      if (_maybeSingle)
        return ok(page[0] ?? null);
      const countVal = q.count === "exact" ? rows.length : undefined;
      return ok(page, countVal);
    };
    const b = {
      select: (cols = "*") => (q.select = cols, b),
      eq: (col, val) => (q.filters.push(`eq.${col}=${val}`), b),
      neq: (col, val) => (q.filters.push(`neq.${col}=${val}`), b),
      gt: (col, val) => (q.filters.push(`gt.${col}=${val}`), b),
      gte: (col, val) => (q.filters.push(`gte.${col}=${val}`), b),
      lt: (col, val) => (q.filters.push(`lt.${col}=${val}`), b),
      lte: (col, val) => (q.filters.push(`lte.${col}=${val}`), b),
      like: (col, val) => (q.filters.push(`like.${col}=${val}`), b),
      ilike: (col, val) => (q.filters.push(`ilike.${col}=${val}`), b),
      is: (col, val) => (q.filters.push(`is.${col}=${val}`), b),
      in: (col, vals) => (q.filters.push(`in.${col}=${vals.join(",")}`), b),
      not: (col, op, val) => (q.filters.push(`not.${col}.${op}=${val}`), b),
      order: (col, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit: (n) => (q.limit = n, b),
      offset: (n) => (q.offset = n, b),
      range: (from2, to) => (q.offset = from2, q.limit = to - from2 + 1, b),
      count: (type = "exact") => (q.count = type, b),
      single: () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      then: (res, rej) => resolve().then(res, rej)
    };
    return b;
  };
  const from = (table) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: async (data) => {
      if (!validId(table))
        return err("Invalid table name");
      let rows = Array.isArray(data) ? data : [data];
      if (!rows.length || !Object.keys(rows[0]).length)
        return err("Empty body");
      const preErr = await fireHook("beforeInsert", table, rows);
      if (preErr)
        return err(preErr);
      rows = await pipeHook("afterInsert", rows.map((r) => ({ id: r.id ?? crypto.randomUUID(), ...r, vector: r.vector ?? Z })), table);
      let t = await openTbl(table);
      if (!t)
        t = await mkTbl(table, rows);
      else
        await t.add(rows);
      const cleaned = clean(rows);
      for (const row of cleaned)
        broadcastChange(table, "INSERT", row, null);
      return ok(cleaned);
    },
    upsert: async (data) => {
      const rows = Array.isArray(data) ? data : [data];
      const withIds = rows.map((r) => ({ ...r, id: r.id ?? crypto.randomUUID() }));
      const results = await Promise.all(withIds.map(async (r) => {
        const existing = await getRows(table, `id = '${esc(r.id)}'`);
        if (existing.length) {
          const t = await openTbl(table);
          if (!t)
            return ok([]);
          await t.delete(`id = '${esc(r.id)}'`);
          const updated = { ...existing[0], ...r, vector: existing[0].vector ?? Z };
          await t.add([updated]);
          broadcastChange(table, "UPDATE", clean([updated])[0], clean([existing[0]])[0]);
          return ok(clean([updated]));
        }
        return from(table).insert(r);
      }));
      return ok(results.flatMap((r) => r?.data ?? []));
    },
    update: (data) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });
  let currentToken = null;
  let currentSession = null;
  const authListeners = [];
  const emitAuth = (event, s) => authListeners.forEach((cb) => cb(event, s));
  const auth = {
    signUp: async ({ email, password, options }) => {
      const emailLower = email.toLowerCase();
      const existing = await getRows("_users", `email = '${esc(emailLower)}'`);
      if (existing.length)
        return err("User already registered");
      const now = new Date().toISOString();
      const u = { id: crypto.randomUUID(), email: emailLower, pw: await Bun.password.hash(password), pubkey: "", role: "authenticated", meta: JSON.stringify(options?.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now, vector: Z };
      await (await openTbl("_users")).add([u]);
      const hookErr = await fireHook("onSignup", makeUser(u));
      if (hookErr)
        return err(hookErr);
      return ok({ user: makeUser(u), session: null });
    },
    signInWithPassword: async ({ email, password }) => {
      const emailLower = email.toLowerCase();
      const users = await getRows("_users", `email = '${esc(emailLower)}'`);
      const u = users[0];
      if (!u || !await Bun.password.verify(password, u.pw))
        return err("Invalid login credentials");
      const now = new Date().toISOString();
      const ut = await openTbl("_users");
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
        if (st)
          await st.delete(`token = '${esc(currentToken)}'`);
      }
      currentToken = null;
      currentSession = null;
      emitAuth("SIGNED_OUT", null);
      return ok({});
    },
    getUser: async () => {
      const user = await getSessionUser(currentToken);
      if (!user)
        return err("Not authenticated", 401);
      return ok({ user });
    },
    getSession: () => Promise.resolve(ok({ session: currentSession })),
    updateUser: async (attrs) => {
      const user = await getSessionUser(currentToken);
      if (!user)
        return err("Not authenticated", 401);
      const existing = await getRows("_users", `id = '${esc(user.id)}'`);
      const u = existing[0];
      if (!u)
        return err("User not found", 404);
      const now = new Date().toISOString();
      const merged = {
        ...u,
        email: attrs.email ? attrs.email.toLowerCase() : u.email,
        pw: attrs.password ? await Bun.password.hash(attrs.password) : u.pw,
        meta: JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...attrs.data || {} }),
        updated: now
      };
      const ut = await openTbl("_users");
      await ut.delete(`id = '${esc(u.id)}'`);
      await ut.add([merged]);
      emitAuth("USER_UPDATED", currentSession);
      return ok({ user: makeUser(merged) });
    },
    setSession: (s) => {
      currentToken = s.access_token;
      currentSession = s;
      return Promise.resolve(ok({ session: s }));
    },
    resetPasswordForEmail: (_email) => Promise.resolve(ok({})),
    onAuthStateChange: (cb) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", currentSession);
      return { data: { subscription: { unsubscribe: () => {
        const i = authListeners.indexOf(cb);
        if (i > -1)
          authListeners.splice(i, 1);
      } } } };
    }
  };
  const channels = new Map;
  const channel = (name) => {
    const handlers = [];
    const ch = {
      on: (type, opts, cb) => {
        const listener = (payload) => {
          if (opts.event === "*" || opts.event === payload.eventType)
            cb(payload);
        };
        handlers.push({ event: opts.event, table: opts.table, cb, listener });
        return ch;
      },
      subscribe: (statusCb) => {
        for (const h of handlers)
          bus.on(`table:${h.table}`, h.listener);
        statusCb?.("SUBSCRIBED");
        channels.set(name, ch);
        return ch;
      },
      unsubscribe: () => {
        for (const h of handlers)
          bus.off(`table:${h.table}`, h.listener);
        channels.delete(name);
      }
    };
    return ch;
  };
  const removeAllChannels = () => {
    for (const ch of channels.values())
      ch.unsubscribe();
  };
  return { from, auth, channel, removeAllChannels, _bus: bus };
};
export {
  createEmbedded
};
