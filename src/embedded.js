// @bun
var __require = import.meta.require;

// src/embedded.ts
import { mkdirSync } from "fs";
import { EventEmitter } from "events";
var lazyBackends = {
  libsql: async () => {
    const mod = await import("@libsql/client").catch(() => null);
    if (!mod || typeof mod.createClient !== "function") {
      throw new Error("backend 'libsql' requires @libsql/client (npm install @libsql/client)");
    }
    return (cfg) => mod.createClient(cfg);
  },
  plugkit: async () => {
    const mod = await import("libsql-plugkit-client").catch(() => null);
    if (!mod || typeof mod.createClient !== "function") {
      throw new Error("backend 'plugkit' requires libsql-plugkit-client (npm install libsql-plugkit-client)");
    }
    return (cfg) => mod.createClient({ url: cfg.url });
  }
};
var backends = {};
var registerBackend = (name, factory) => {
  backends[name] = factory;
};
var resolveClient = async (backend, url) => {
  let f = backends[backend];
  if (!f && lazyBackends[backend]) {
    f = await lazyBackends[backend]();
    backends[backend] = f;
  }
  if (!f)
    throw new Error(`busybase: unknown backend '${backend}'. Registered: ${[...Object.keys(backends), ...Object.keys(lazyBackends)].join(", ")}`);
  return await f({ url });
};
var esc = (s) => String(s).replace(/'/g, "''");
var validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";
var clean = (rows) => rows.map(({ pw, pubkey: _pk, ...r }) => r);
var makeUser = (u) => ({ id: u.id, email: u.email || null, role: u.role || "authenticated", user_metadata: JSON.parse(u.meta || "{}"), app_metadata: JSON.parse(u.app_meta || "{}"), identities: [], aud: "authenticated", created_at: u.created, updated_at: u.updated || u.created, last_sign_in_at: u.last_sign_in || u.created, email_confirmed_at: u.email ? u.created : null });
var makeSession = (token, refresh, exp, user) => ({ access_token: token, refresh_token: refresh, token_type: "bearer", expires_in: 604800, expires_at: Math.floor(exp / 1000), user });
var ok = (data, count) => count !== undefined ? { data, error: null, count } : { data, error: null };
var err = (message, code = 400) => ({ data: null, error: { message, code } });
var FILE_BACKENDS = new Set(["libsql", "plugkit"]);
var createEmbedded = async (config = {}) => {
  const dir = config.dir || "busybase_data";
  const hooks = config.hooks || {};
  const backend = config.backend || "plugkit";
  if (FILE_BACKENDS.has(backend))
    mkdirSync(dir, { recursive: true });
  const url = config.url || `file:${dir}/db.sqlite`;
  const db = await resolveClient(backend, url);
  if (FILE_BACKENDS.has(backend)) {
    try {
      await db.execute("PRAGMA busy_timeout = 5000");
    } catch {}
  }
  const bus = new EventEmitter;
  bus.setMaxListeners(0);
  const nonces = new Map;
  const resetTokens = new Map;
  const tblExists = async (n) => (await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [n] })).rows.length > 0;
  const qid = (n) => `"${String(n).replaceAll('"', '""')}"`;
  const ensureColsLocks = new Map;
  const ensureCols = async (n, row) => {
    const prev = ensureColsLocks.get(n) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const info = await db.execute(`PRAGMA table_info(${qid(n)})`);
      const ex = new Set(info.rows.map((r) => r.name));
      for (const k of Object.keys(row))
        if (!ex.has(k))
          await db.execute(`ALTER TABLE ${qid(n)} ADD COLUMN ${qid(k)} TEXT`);
    });
    ensureColsLocks.set(n, run);
    try {
      await run;
    } finally {
      if (ensureColsLocks.get(n) === run)
        ensureColsLocks.delete(n);
    }
  };
  const mkTbl = async (n, row) => {
    await db.execute(`CREATE TABLE IF NOT EXISTS ${qid(n)} (${Object.keys(row).map((k) => qid(k) + " TEXT").join(", ")})`);
  };
  const getRows = async (n, where) => {
    if (!await tblExists(n))
      return [];
    return (await db.execute(`SELECT * FROM ${qid(n)} WHERE ${where}`)).rows.map((r) => ({ ...r }));
  };
  const getAllRows = async (n) => {
    if (!await tblExists(n))
      return [];
    return (await db.execute(`SELECT * FROM ${qid(n)}`)).rows.map((r) => ({ ...r }));
  };
  const insertRow = async (n, row) => {
    const keys = Object.keys(row);
    await db.execute({ sql: `INSERT INTO ${qid(n)} (${keys.map(qid).join(",")}) VALUES (${keys.map(() => "?").join(",")})`, args: keys.map((k) => row[k] == null ? null : String(row[k])) });
  };
  const updateRow = async (n, data, where) => {
    const keys = Object.keys(data).filter((k) => k !== "id");
    if (!keys.length)
      return;
    await ensureCols(n, data);
    await db.execute({ sql: `UPDATE ${qid(n)} SET ${keys.map((k) => qid(k) + "=?").join(",")} WHERE ${where}`, args: keys.map((k) => data[k] == null ? null : String(data[k])) });
  };
  const deleteRow = async (n, where) => {
    await db.execute(`DELETE FROM ${qid(n)} WHERE ${where}`);
  };
  const broadcast = (table, ev, nw, old) => {
    const p = { event: ev, table, eventType: ev, new: nw ?? null, old: old ?? null };
    bus.emit(`table:${table}`, p);
    bus.emit("*", p);
  };
  await db.execute("CREATE TABLE IF NOT EXISTS _users (id TEXT, email TEXT, pw TEXT, pubkey TEXT, role TEXT, meta TEXT, app_meta TEXT, created TEXT, updated TEXT, last_sign_in TEXT)");
  await db.execute("CREATE TABLE IF NOT EXISTS _sessions (token TEXT, refresh TEXT, uid TEXT, exp INTEGER)");
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
  const issueSession = async (uid) => {
    const token = crypto.randomUUID(), refresh = crypto.randomUUID(), exp = Date.now() + 604800000;
    await db.execute({ sql: "INSERT INTO _sessions (token,refresh,uid,exp) VALUES (?,?,?,?)", args: [token, refresh, uid, exp] });
    return { token, refresh, exp };
  };
  const getSessionUser = async (t) => {
    if (!t)
      return null;
    const s = (await db.execute({ sql: "SELECT * FROM _sessions WHERE token=? AND exp>?", args: [t, Date.now()] })).rows[0];
    if (!s)
      return null;
    const u = (await getRows("_users", `id='${esc(s.uid)}'`))[0];
    return u ? makeUser(u) : null;
  };
  const NUM_LIT = /^-?\d+(\.\d+)?$/;
  const cmp = (col, s, val) => NUM_LIT.test(val) ? `(${col} ${s} '${esc(val)}' OR ${col} ${s} CAST('${esc(val)}' AS NUMERIC))` : `${col} ${s} '${esc(val)}'`;
  const toFilter = (filters) => {
    const parts = [];
    for (const f of filters) {
      if (f.startsWith("or=")) {
        const orP = f.slice(3).split(",").map((c) => {
          const d1 = c.indexOf("."), d2 = c.indexOf(".", d1 + 1);
          if (d1 < 0 || d2 < 0)
            return null;
          const col = c.slice(0, d1), op2 = c.slice(d1 + 1, d2), v = c.slice(d2 + 1);
          if (!validId(col))
            return null;
          const s = op2 === "eq" ? "=" : op2 === "neq" ? "!=" : op2 === "gt" ? ">" : op2 === "gte" ? ">=" : op2 === "lt" ? "<" : op2 === "lte" ? "<=" : null;
          return s ? cmp(col, s, v) : null;
        }).filter(Boolean);
        if (orP.length)
          parts.push(`(${orP.join(" OR ")})`);
        continue;
      }
      const dot = f.indexOf(".");
      if (dot < 0)
        continue;
      const op = f.slice(0, dot), rest = f.slice(dot + 1);
      if (["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike"].includes(op)) {
        const eq = rest.indexOf("=");
        if (eq < 0)
          continue;
        const col = rest.slice(0, eq), val = rest.slice(eq + 1);
        if (!validId(col))
          continue;
        const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : op === "lte" ? "<=" : op === "like" ? null : null;
        if (op === "like")
          parts.push(`${col} LIKE '${esc(val)}'`);
        else if (op === "ilike")
          parts.push(`LOWER(${col}) LIKE LOWER('${esc(val)}')`);
        else if (s)
          parts.push(cmp(col, s, val));
      } else if (op === "is") {
        const eq = rest.indexOf("=");
        if (eq < 0)
          continue;
        const col = rest.slice(0, eq), val = rest.slice(eq + 1).trim().toUpperCase();
        if (!validId(col) || !["NULL", "TRUE", "FALSE"].includes(val))
          continue;
        parts.push(`${col} IS ${val}`);
      } else if (op === "in") {
        const eq = rest.indexOf("=");
        if (eq < 0)
          continue;
        const col = rest.slice(0, eq), val = rest.slice(eq + 1);
        if (!validId(col))
          continue;
        parts.push(`${col} IN (${val.split(",").flatMap((v) => NUM_LIT.test(v) ? [`'${esc(v)}'`, v] : [`'${esc(v)}'`]).join(",")})`);
      } else if (op === "not") {
        const dp = rest.indexOf(".");
        if (dp < 0)
          continue;
        const col = rest.slice(0, dp), after = rest.slice(dp + 1), eq = after.indexOf("=");
        if (eq < 0)
          continue;
        const sub = after.slice(0, eq), val = after.slice(eq + 1);
        if (!validId(col))
          continue;
        const s = sub === "eq" ? "=" : sub === "neq" ? "!=" : sub === "gt" ? ">" : sub === "gte" ? ">=" : sub === "lt" ? "<" : "<=";
        parts.push(`NOT (${col} ${s} '${esc(val)}')`);
      }
    }
    return parts.join(" AND ");
  };
  setInterval(async () => {
    const now = Date.now();
    for (const [k, v] of nonces)
      if (v < now)
        nonces.delete(k);
    for (const [k, v] of resetTokens)
      if (v.exp < now)
        resetTokens.delete(k);
    await db.execute({ sql: "DELETE FROM _sessions WHERE exp<?", args: [now] }).catch(() => {});
  }, 300000).unref();
  const Q = (table, method, body) => {
    const q = { filters: [], order: "", limit: 0, offset: 0, select: "*", count: "" };
    let _single = false, _maybe = false;
    const resolve = async () => {
      if (hooks.canAccess) {
        const d = await fireHook("canAccess", { user: null, table, method: method || "GET" });
        if (d)
          return err(d, 403);
      }
      if (method === "PATCH" || method === "PUT") {
        const f2 = toFilter(q.filters);
        if (!f2)
          return err("No filter provided");
        if (!await tblExists(table))
          return err("Table not found", 404);
        const data = Array.isArray(body) ? body[0] : body;
        let ex = await getRows(table, f2);
        if (!ex.length)
          return ok([]);
        const pe = await fireHook("beforeUpdate", table, ex, data);
        if (pe)
          return err(pe);
        await updateRow(table, data, f2);
        let up = ex.map((r) => ({ ...r, ...data }));
        up = await pipeHook("afterUpdate", up, table);
        for (let i = 0;i < up.length; i++)
          broadcast(table, "UPDATE", clean([up[i]])[0], clean([ex[i]])[0]);
        return ok(clean(up));
      }
      if (method === "DELETE") {
        const f2 = toFilter(q.filters);
        if (!f2)
          return err("No filter provided");
        if (!await tblExists(table))
          return err("Table not found", 404);
        const td = await getRows(table, f2);
        const pe = await fireHook("beforeDelete", table, td);
        if (pe)
          return err(pe);
        await deleteRow(table, f2);
        await fireHook("afterDelete", table, td);
        for (const r of clean(td))
          broadcast(table, "DELETE", null, r);
        return ok([]);
      }
      const ph = await pipeHook("beforeSelect", q.filters, table);
      const f = toFilter(Array.isArray(ph) ? ph : q.filters);
      let rows = f ? await getRows(table, f) : await getAllRows(table);
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
      const lim = Math.max(0, q.limit || 1000), off = Math.max(0, q.offset || 0), page = clean(rows).slice(off, off + lim);
      if (_single) {
        if (!page.length)
          return err("JSON object requested, multiple (or no) rows returned", 406);
        return ok(page[0]);
      }
      if (_maybe)
        return ok(page[0] ?? null);
      return ok(page, q.count === "exact" ? rows.length : undefined);
    };
    const b = { select: (c = "*") => (q.select = c, b), eq: (c, v) => (q.filters.push(`eq.${c}=${v}`), b), neq: (c, v) => (q.filters.push(`neq.${c}=${v}`), b), gt: (c, v) => (q.filters.push(`gt.${c}=${v}`), b), gte: (c, v) => (q.filters.push(`gte.${c}=${v}`), b), lt: (c, v) => (q.filters.push(`lt.${c}=${v}`), b), lte: (c, v) => (q.filters.push(`lte.${c}=${v}`), b), like: (c, v) => (q.filters.push(`like.${c}=${v}`), b), ilike: (c, v) => (q.filters.push(`ilike.${c}=${v}`), b), is: (c, v) => (q.filters.push(`is.${c}=${v}`), b), in: (c, vs) => (q.filters.push(`in.${c}=${vs.join(",")}`), b), not: (c, op, v) => (q.filters.push(`not.${c}.${op}=${v}`), b), or: (cl) => (q.filters.push(`or=${cl}`), b), filter: (c, op, v) => (q.filters.push(`${op}.${c}=${v}`), b), order: (c, { ascending = true } = {}) => (q.order = `${c}.${ascending ? "asc" : "desc"}`, b), limit: (n) => (q.limit = n, b), offset: (n) => (q.offset = n, b), range: (from2, to) => (q.offset = from2, q.limit = to - from2 + 1, b), count: (t = "exact") => (q.count = t, b), single: () => (_single = true, b), maybeSingle: () => (_maybe = true, b), then: (res, rej) => resolve().then(res, rej) };
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
      const pe = await fireHook("beforeInsert", table, rows);
      if (pe)
        return err(pe);
      rows = await pipeHook("afterInsert", rows.map((r) => ({ id: r.id ?? crypto.randomUUID(), ...r })), table);
      if (!await tblExists(table))
        await mkTbl(table, rows[0]);
      else
        await ensureCols(table, rows[0]);
      for (const row of rows)
        await insertRow(table, row);
      const c = clean(rows);
      for (const row of c)
        broadcast(table, "INSERT", row, null);
      return ok(c);
    },
    upsert: async (data) => {
      const rows = (Array.isArray(data) ? data : [data]).map((r) => ({ ...r, id: r.id ?? crypto.randomUUID() }));
      const results = await Promise.all(rows.map(async (r) => {
        const ex = await getRows(table, `id='${esc(r.id)}'`);
        if (ex.length) {
          await updateRow(table, r, `id='${esc(r.id)}'`);
          const up = { ...ex[0], ...r };
          broadcast(table, "UPDATE", clean([up])[0], clean([ex[0]])[0]);
          return ok(clean([up]));
        }
        return from(table).insert(r);
      }));
      return ok(results.flatMap((r) => r?.data ?? []));
    },
    update: (data) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });
  let currentToken = null, currentSession = null;
  const authListeners = [];
  const emitAuth = (e, s) => authListeners.forEach((cb) => cb(e, s));
  const auth = {
    signUp: async ({ email, password, options }) => {
      const el = email.toLowerCase();
      if ((await getRows("_users", `email='${esc(el)}'`)).length)
        return err("User already registered");
      const now = new Date().toISOString();
      const u = { id: crypto.randomUUID(), email: el, pw: await Bun.password.hash(password), pubkey: "", role: "authenticated", meta: JSON.stringify(options?.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now };
      await insertRow("_users", u);
      const he = await fireHook("onSignup", makeUser(u));
      if (he)
        return err(he);
      return ok({ user: makeUser(u), session: null });
    },
    signInWithPassword: async ({ email, password }) => {
      const el = email.toLowerCase();
      const u = (await getRows("_users", `email='${esc(el)}'`))[0];
      if (!u || !await Bun.password.verify(password, u.pw))
        return err("Invalid login credentials");
      const now = new Date().toISOString();
      await updateRow("_users", { last_sign_in: now, updated: now }, `id='${esc(u.id)}'`);
      const { token, refresh, exp } = await issueSession(u.id);
      const user = makeUser({ ...u, last_sign_in: now });
      currentToken = token;
      currentSession = makeSession(token, refresh, exp, user);
      await fireHook("onIssueSession", user);
      await fireHook("onSignin", user);
      emitAuth("SIGNED_IN", currentSession);
      return ok({ user, session: currentSession });
    },
    signIn: async () => {
      const { token, refresh, exp } = await issueSession(crypto.randomUUID());
      currentToken = token;
      currentSession = makeSession(token, refresh, exp, { id: "anon", role: "anon" });
      emitAuth("SIGNED_IN", currentSession);
      return ok({ session: currentSession });
    },
    signOut: async () => {
      const user = currentToken ? await getSessionUser(currentToken) : null;
      if (currentToken)
        await db.execute({ sql: "DELETE FROM _sessions WHERE token=?", args: [currentToken] }).catch(() => {});
      if (user)
        await fireHook("onSignout", user);
      currentToken = null;
      currentSession = null;
      emitAuth("SIGNED_OUT", null);
      return ok({});
    },
    getUser: async () => {
      const u = await getSessionUser(currentToken);
      if (!u)
        return err("Not authenticated", 401);
      return ok({ user: u });
    },
    getSession: () => Promise.resolve(ok({ session: currentSession })),
    updateUser: async (attrs) => {
      const u = await getSessionUser(currentToken);
      if (!u)
        return err("Not authenticated", 401);
      const ex = (await getRows("_users", `id='${esc(u.id)}'`))[0];
      if (!ex)
        return err("User not found", 404);
      const now = new Date().toISOString();
      const newEmail = attrs.email ? attrs.email.toLowerCase() : ex.email;
      if (attrs.email && newEmail !== ex.email) {
        const taken = await getRows("_users", `email='${esc(newEmail)}'`);
        if (taken.length)
          return err("Email already in use");
        const emailHookErr = await fireHook("onEmailChange", makeUser(ex), newEmail);
        if (emailHookErr)
          return err(emailHookErr);
      }
      const merged = { email: newEmail, pw: attrs.password ? await Bun.password.hash(attrs.password) : ex.pw, meta: JSON.stringify({ ...JSON.parse(ex.meta || "{}"), ...attrs.data || {} }), updated: now };
      await updateRow("_users", merged, `id='${esc(u.id)}'`);
      await fireHook("onUserUpdate", makeUser({ ...ex, ...merged }), { email: attrs.email, password: !!attrs.password, data: attrs.data, app_metadata: attrs.app_metadata });
      emitAuth("USER_UPDATED", currentSession);
      return ok({ user: makeUser({ ...ex, ...merged }) });
    },
    setSession: (s) => {
      currentToken = s.access_token;
      currentSession = s;
      return Promise.resolve(ok({ session: s }));
    },
    resetPasswordForEmail: (_) => Promise.resolve(ok({})),
    onAuthStateChange: (cb) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", currentSession);
      return { data: { subscription: { unsubscribe: () => {
        const i = authListeners.indexOf(cb);
        if (i > -1)
          authListeners.splice(i, 1);
      } } } };
    },
    keypair: { signIn: async () => ok({}), restore: async () => ok({}), export: () => ({}) }
  };
  const channels = new Map;
  const channel = (name) => {
    const handlers = [];
    const ch = {
      on: (type, opts, cb) => {
        const listener = (p) => {
          if (opts.event === "*" || opts.event === p.eventType)
            cb(p);
        };
        handlers.push({ ...opts, cb, listener });
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
  const close = () => {
    try {
      db.close?.();
    } catch {}
  };
  const raw = (sql, args = []) => db.execute({ sql, args });
  const ftsInitialized = new Set;
  const ensureFts = async (table, column) => {
    const key = `${table}.${column}`;
    if (ftsInitialized.has(key))
      return;
    const ftsTbl = `${table}_fts`;
    const existed = (await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [ftsTbl] })).rows.length > 0;
    await db.execute(`CREATE VIRTUAL TABLE IF NOT EXISTS ${qid(ftsTbl)} USING fts5(${qid(column)}, content=${qid(table)}, content_rowid='rowid')`);
    await db.execute(`CREATE TRIGGER IF NOT EXISTS ${qid(table + "_fts_ai")} AFTER INSERT ON ${qid(table)} BEGIN INSERT INTO ${qid(ftsTbl)}(rowid, ${qid(column)}) VALUES (new.rowid, new.${qid(column)}); END`);
    if (!existed) {
      try {
        await db.execute(`INSERT INTO ${qid(ftsTbl)}(${qid(ftsTbl)}) VALUES('rebuild')`);
      } catch {}
    }
    ftsInitialized.add(key);
  };
  const escapeFtsQuery = (q) => '"' + String(q).replace(/"/g, '""') + '"';
  const search = async (table, column, query, opts = {}) => {
    if (!validId(table) || !validId(column))
      return { ...err("Invalid table or column name"), searchMode: null };
    const limit = Math.max(0, opts.limit || 20);
    const ftsTbl = `${table}_fts`;
    try {
      await ensureFts(table, column);
      const ftsQuery = escapeFtsQuery(query);
      const filterClause2 = opts.filter ? ` AND m.${opts.filter}` : "";
      const sql2 = `SELECT m.* FROM ${qid(ftsTbl)} f JOIN ${qid(table)} m ON m.rowid = f.rowid WHERE ${qid(ftsTbl)} MATCH ?${filterClause2} ORDER BY rank LIMIT ?`;
      const r2 = await db.execute({ sql: sql2, args: [ftsQuery, limit] });
      if (r2.rows && r2.rows.length > 0) {
        const rows2 = clean(r2.rows.map((row) => ({ ...row })));
        return ok(rows2, undefined);
      }
    } catch {}
    const likePattern = `%${query}%`;
    const filterClause = opts.filter ? ` AND ${opts.filter}` : "";
    const sql = `SELECT * FROM ${qid(table)} WHERE ${qid(column)} LIKE ?${filterClause} LIMIT ?`;
    const r = await db.execute({ sql, args: [likePattern, limit] });
    const rows = clean((r.rows || []).map((row) => ({ ...row })));
    return { ...ok(rows), searchMode: "like" };
  };
  const vectorInitialized = new Set;
  const ensureVectorIndex = async (table, column, dims) => {
    const key = `${table}.${column}`;
    if (vectorInitialized.has(key))
      return;
    await ensureCols(table, { [column]: null });
    if (!await tblExists(table))
      await mkTbl(table, { id: null, [column]: null });
    try {
      await db.execute(`ALTER TABLE ${qid(table)} ADD COLUMN ${qid(column)} F32_BLOB(${dims})`);
    } catch {}
    const idxName = `${table}_${column}_vidx`;
    try {
      await db.execute(`CREATE INDEX IF NOT EXISTS ${qid(idxName)} ON ${qid(table)}(libsql_vector_idx(${qid(column)}))`);
    } catch {}
    vectorInitialized.add(key);
  };
  const vecLiteral = (v) => `[${v.join(",")}]`;
  const vectorSearch = async (table, column, queryVector, opts = {}) => {
    if (!validId(table) || !validId(column))
      return { data: null, error: { message: "Invalid table or column name" } };
    const limit = Math.max(0, opts.limit || 20);
    const dims = queryVector.length;
    const idxName = `${table}_${column}_vidx`;
    try {
      await ensureVectorIndex(table, column, dims);
      const filterClause = opts.filter ? ` AND m.${opts.filter}` : "";
      const sql = `SELECT m.* FROM vector_top_k('${idxName}', vector(?), ?) t JOIN ${qid(table)} m ON m.rowid = t.id${filterClause}`;
      const r = await db.execute({ sql, args: [vecLiteral(queryVector), limit] });
      const rows = clean((r.rows || []).map((row) => ({ ...row })));
      return { data: rows, error: null };
    } catch {
      try {
        const filterClause = opts.filter ? ` AND ${opts.filter}` : "";
        const sql = `SELECT *, vector_distance_cos(${qid(column)}, vector(?)) as _dist FROM ${qid(table)} WHERE ${qid(column)} IS NOT NULL${filterClause} ORDER BY _dist ASC LIMIT ?`;
        const r = await db.execute({ sql, args: [vecLiteral(queryVector), limit] });
        const rows = clean((r.rows || []).map((row) => ({ ...row })));
        return { data: rows, error: null };
      } catch (e) {
        return { data: null, error: { message: e?.message || String(e) } };
      }
    }
  };
  const transaction = async (fn) => {
    try {
      await db.execute("BEGIN TRANSACTION");
      const result = await fn({ from, raw });
      await db.execute("COMMIT");
      return result;
    } catch (e) {
      try {
        await db.execute("ROLLBACK");
      } catch {}
      throw e;
    }
  };
  return { from, auth, channel, removeAllChannels: () => {
    for (const ch of channels.values())
      ch.unsubscribe();
  }, close, raw, search, vectorSearch, transaction, _bus: bus };
};
export {
  createEmbedded,
  registerBackend
};
