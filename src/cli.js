#!/usr/bin/env bun
// @bun
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

// src/server.ts
var exports_server = {};
import { connect } from "vectordb";
var DIR, PORT, Z, SENTINEL = "_sentinel_", vdb, tableCache, openTbl = async (name) => {
  if (tableCache.has(name))
    return tableCache.get(name);
  const names = await vdb.tableNames();
  if (!names.includes(name))
    return null;
  const t = await vdb.openTable(name);
  tableCache.set(name, t);
  return t;
}, mkTbl = async (name, schema) => {
  const t = await vdb.createTable(name, schema);
  tableCache.set(name, t);
  return t;
}, real = (col = "id") => `${col} != '${SENTINEL}'`, execFilter = async (t, filter) => {
  try {
    return await t.filter(filter).execute();
  } catch {
    return [];
  }
}, getRows = async (tblName, filter) => {
  const t = await openTbl(tblName);
  if (!t)
    return [];
  const pk = tblName === "_sessions" ? "token" : "id";
  return execFilter(t, `(${real(pk)}) AND (${filter})`);
}, getAllRows = async (tblName) => {
  const t = await openTbl(tblName);
  if (!t)
    return [];
  return execFilter(t, real("id"));
}, validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && !s.startsWith("_"), cors, json = (data, status = 200) => Response.json(data, { status, headers: cors }), ok = (data, status = 200) => json({ data, error: null }, status), err = (msg, code = 400, details = null) => json({ data: null, error: { message: msg, details, code } }, code), toFilter = (p) => {
  const parts = [];
  const skip = new Set(["select", "order", "limit", "offset", "vec", "count"]);
  for (const [k, val] of Object.entries(p)) {
    if (skip.has(k))
      continue;
    if (k.startsWith("in.")) {
      const col2 = k.slice(3);
      if (!validId(col2))
        continue;
      const list = val.split(",").map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
      parts.push(`${col2} IN (${list})`);
      continue;
    }
    if (k === "or") {
      const orParts = val.split(",").map((clause) => {
        const [col2, op2, ...rest] = clause.split(".");
        const v = rest.join(".");
        if (!validId(col2))
          return null;
        const safe2 = v.replace(/'/g, "''");
        const sqlOp = op2 === "eq" ? "=" : op2 === "neq" ? "!=" : op2 === "gt" ? ">" : op2 === "gte" ? ">=" : op2 === "lt" ? "<" : op2 === "lte" ? "<=" : null;
        return sqlOp ? `${col2} ${sqlOp} '${safe2}'` : null;
      }).filter(Boolean);
      if (orParts.length)
        parts.push(`(${orParts.join(" OR ")})`);
      continue;
    }
    const op = k.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is|not)\./)?.[1];
    if (!op)
      continue;
    const col = k.slice(op.length + 1);
    if (!validId(col))
      continue;
    const safe = val.replace(/'/g, "''");
    if (op === "like" || op === "ilike")
      parts.push(`${col} LIKE '%${safe}%'`);
    else if (op === "is")
      parts.push(`${col} IS ${val}`);
    else if (op === "not")
      parts.push(`NOT (${col} = '${safe}')`);
    else {
      const sqlOp = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      parts.push(`${col} ${sqlOp} '${safe}'`);
    }
  }
  return parts.join(" AND ");
}, clean = (rows) => rows.map(({ vector, _distance, pw, ...r }) => _distance !== undefined ? { ...r, _distance } : r), getUser = async (r) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token)
    return null;
  const sessions = await getRows("_sessions", `token = '${token}'`);
  const s = sessions[0];
  if (!s || s.exp < Date.now())
    return null;
  const users = await getRows("_users", `id = '${s.uid}'`);
  const u = users[0];
  return u ? { id: u.id, email: u.email, user_metadata: JSON.parse(u.meta || "{}"), created_at: u.created } : null;
};
var init_server = __esm(async () => {
  DIR = process.env.BUSYBASE_DIR || "busybase_data";
  PORT = process.env.BUSYBASE_PORT || 54321;
  Z = [0];
  vdb = await connect(DIR);
  tableCache = new Map;
  if (!await openTbl("_users"))
    await mkTbl("_users", [{ id: SENTINEL, email: SENTINEL, pw: "", created: "", meta: "{}", vector: Z }]);
  if (!await openTbl("_sessions"))
    await mkTbl("_sessions", [{ token: SENTINEL, uid: "", exp: 0, vector: Z }]);
  cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer"
  };
  Bun.serve({ port: PORT, fetch: async (req) => {
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const { pathname, searchParams } = new URL(req.url);
    const P = Object.fromEntries(searchParams);
    const B = await req.json().catch(() => ({}));
    if (pathname.startsWith("/auth/v1/")) {
      const action = pathname.split("/")[3];
      if (action === "signup") {
        if (!B.email || !B.password)
          return err("Email & password required");
        const existing = await getRows("_users", `email = '${B.email.replace(/'/g, "''")}'`);
        if (existing.length)
          return err("Email already registered", 409);
        const id = crypto.randomUUID();
        const pw = await Bun.password.hash(B.password);
        const meta = JSON.stringify(B.data || {});
        await (await openTbl("_users")).add([{ id, email: B.email, pw, created: new Date().toISOString(), meta, vector: Z }]);
        const user = { id, email: B.email, user_metadata: B.data || {}, created_at: new Date().toISOString() };
        return ok({ user, session: null }, 201);
      }
      if (action === "token") {
        const users = await getRows("_users", `email = '${(B.email || "").replace(/'/g, "''")}'`);
        const u = users[0];
        if (!u || !await Bun.password.verify(B.password || "", u.pw))
          return err("Invalid login credentials", 400);
        const token = crypto.randomUUID();
        const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
        await (await openTbl("_sessions")).add([{ token, uid: u.id, exp, vector: Z }]);
        const user = { id: u.id, email: u.email, user_metadata: JSON.parse(u.meta || "{}"), created_at: u.created };
        const session = { access_token: token, token_type: "bearer", expires_in: 604800, user };
        return ok({ user, session });
      }
      if (action === "user") {
        const user = await getUser(req);
        if (!user)
          return err("Not authenticated", 401);
        return ok({ user });
      }
      if (action === "logout") {
        const token = req.headers.get("Authorization")?.split(" ")[1];
        if (token) {
          const st = await openTbl("_sessions");
          if (st)
            await st.delete(`token = '${token}'`);
        }
        return ok({});
      }
      if (action === "update") {
        const user = await getUser(req);
        if (!user)
          return err("Not authenticated", 401);
        const t = await openTbl("_users");
        const existing = await getRows("_users", `id = '${user.id}'`);
        const u = existing[0];
        if (!u)
          return err("User not found", 404);
        await t.delete(`id = '${user.id}'`);
        const newMeta = JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...B.data || {} });
        const newPw = B.password ? await Bun.password.hash(B.password) : u.pw;
        const newEmail = B.email || u.email;
        await t.add([{ id: u.id, email: newEmail, pw: newPw, created: u.created, meta: newMeta, vector: Z }]);
        return ok({ user: { id: u.id, email: newEmail, user_metadata: JSON.parse(newMeta), created_at: u.created } });
      }
    }
    if (pathname.startsWith("/rest/v1/")) {
      const table = pathname.slice(9).split("/").map(decodeURIComponent).filter(Boolean)[0];
      if (!table)
        return err("Table required");
      if (!validId(table))
        return err("Invalid table name");
      if (req.method === "GET") {
        if (P.vec) {
          const t = await openTbl(table);
          if (!t)
            return ok([]);
          const limit2 = P.limit ? parseInt(P.limit) : 10;
          const filter2 = toFilter(P);
          let q = t.search(JSON.parse(P.vec)).limit(limit2);
          q = q.filter(filter2 ? `(${real()}) AND (${filter2})` : real());
          return ok(clean(await q.execute()));
        }
        const filter = toFilter(P);
        let rows = filter ? await getRows(table, filter) : await getAllRows(table);
        if (P.select && P.select !== "*") {
          const cols = P.select.split(",").filter((c) => validId(c));
          rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
        }
        if (P.order) {
          const [col, dir] = P.order.split(".");
          if (validId(col))
            rows.sort((a, b) => dir === "desc" ? b[col] > a[col] ? 1 : -1 : a[col] > b[col] ? 1 : -1);
        }
        const limit = P.limit ? parseInt(P.limit) : 1000;
        const offset = P.offset ? parseInt(P.offset) : 0;
        const data = clean(rows).slice(offset, offset + limit);
        if (P.count === "exact")
          return json({ data, error: null, count: rows.length }, 200);
        return ok(data);
      }
      if (req.method === "POST") {
        const rows = Array.isArray(B) ? B : [B];
        if (!rows.length || !Object.keys(rows[0]).length)
          return err("Empty body");
        if (Object.keys(rows[0]).some((k) => k !== "vector" && !validId(k)))
          return err("Invalid column name");
        const prepared = rows.map((r) => ({ id: r.id ?? crypto.randomUUID(), ...r, vector: r.vector ?? Z }));
        let t = await openTbl(table);
        if (!t)
          t = await mkTbl(table, prepared);
        else
          await t.add(prepared);
        return ok(clean(prepared), 201);
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        const filter = toFilter(P);
        if (!filter)
          return err("No filter provided");
        const t = await openTbl(table);
        if (!t)
          return err("Table not found", 404);
        const data = Array.isArray(B) ? B[0] : B;
        const existing = await getRows(table, filter);
        if (!existing.length)
          return ok([]);
        await t.delete(`(${real()}) AND (${filter})`);
        const updated = existing.map((r) => ({ ...r, ...data, vector: r.vector ?? Z }));
        await t.add(updated);
        return ok(clean(updated));
      }
      if (req.method === "DELETE") {
        const filter = toFilter(P);
        if (!filter)
          return err("No filter provided");
        const t = await openTbl(table);
        if (!t)
          return err("Table not found", 404);
        await t.delete(`(${real()}) AND (${filter})`);
        return ok([]);
      }
    }
    return err("Not found", 404);
  } });
  console.log(`\uD83D\uDE80 BusyBase: http://localhost:${PORT}`);
});

// src/sdk.ts
var BB = (url, key) => {
  let token = null;
  let session = null;
  const authListeners = [];
  const base = url.replace(/\/$/, "");
  const emit = (event, s) => authListeners.forEach((cb) => cb(event, s));
  const req = async (path, opts = {}) => {
    const r = await globalThis.fetch(`${base}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, "Content-Type": "application/json", ...opts.headers }
    });
    return r.json();
  };
  const Q = (table, method, body) => {
    const q = { filters: [], order: "", limit: 0, offset: 0, select: "*", vec: "", count: "" };
    let _single = false, _maybeSingle = false;
    const qs = () => {
      const p = [`select=${q.select}`, ...q.filters];
      if (q.order)
        p.push(`order=${q.order}`);
      if (q.limit)
        p.push(`limit=${q.limit}`);
      if (q.offset)
        p.push(`offset=${q.offset}`);
      if (q.vec)
        p.push(`vec=${encodeURIComponent(q.vec)}`);
      if (q.count)
        p.push(`count=${q.count}`);
      return p.join("&");
    };
    const run = () => method && body !== undefined ? req(`rest/v1/${table}?${qs()}`, { method, body: JSON.stringify(body) }) : req(`rest/v1/${table}?${qs()}`);
    const resolve = async () => {
      const res = await run();
      if (res.error)
        return res;
      let data = res.data ?? res;
      if (_single) {
        if (!data?.length)
          return { data: null, error: { message: "No rows found", code: 406 } };
        return { data: data[0], error: null };
      }
      if (_maybeSingle)
        return { data: data?.[0] ?? null, error: null };
      return { data, error: null, ...res.count !== undefined ? { count: res.count } : {} };
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
      not: (col, _op, val) => (q.filters.push(`not.${col}=${val}`), b),
      or: (clause) => (q.filters.push(`or=${clause}`), b),
      order: (col, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit: (n) => (q.limit = n, b),
      offset: (n) => (q.offset = n, b),
      range: (from2, to) => (q.limit = to - from2 + 1, q.offset = from2, b),
      count: (type = "exact") => (q.count = type, b),
      single: () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      vec: (embedding, limit = 10) => (q.vec = JSON.stringify(embedding), q.limit = limit, b),
      then: (res, rej) => resolve().then(res, rej)
    };
    return b;
  };
  const from = (table) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data, opts = {}) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) }).then((r) => r.error ? r : { data: r.data ?? r, error: null }),
    upsert: (data) => req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) }).then((r) => r.error ? r : { data: r.data ?? r, error: null }),
    update: (data) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });
  const auth = {
    signUp: ({ email, password, options }) => req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password, data: options?.data }) }).then((r) => r.error ? r : (() => {
      if (r.data?.session?.access_token) {
        token = r.data.session.access_token;
        session = r.data.session;
        emit("SIGNED_IN", session);
      }
      return r;
    })()),
    signInWithPassword: ({ email, password }) => req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }) }).then((r) => r.error ? r : (() => {
      if (r.data?.session?.access_token) {
        token = r.data.session.access_token;
        session = r.data.session;
        emit("SIGNED_IN", session);
      }
      return r;
    })()),
    signIn: ({ email, password }) => auth.signInWithPassword({ email, password }),
    signOut: () => req("auth/v1/logout", { method: "POST" }).then((r) => {
      token = null;
      session = null;
      emit("SIGNED_OUT", null);
      return r;
    }),
    getUser: () => req("auth/v1/user"),
    getSession: () => Promise.resolve({ data: { session }, error: null }),
    updateUser: (attrs) => req("auth/v1/update", { method: "PATCH", body: JSON.stringify(attrs) }),
    onAuthStateChange: (cb) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", session);
      return { data: { subscription: { unsubscribe: () => {
        const i = authListeners.indexOf(cb);
        if (i > -1)
          authListeners.splice(i, 1);
      } } } };
    }
  };
  return { from, auth };
};
var sdk_default = BB;

// src/cli.ts
var URL2 = process.env.BUSYBASE_URL || `http://localhost:${process.env.BUSYBASE_PORT || 54321}`;
var KEY = process.env.BUSYBASE_KEY || "local";
var [cmd, ...args] = process.argv.slice(2);
var db = sdk_default(URL2, KEY);
var print = (x) => console.log(JSON.stringify(x, null, 2));
var die = (msg) => {
  console.error("Error:", msg);
  process.exit(1);
};
var parseFilter = (q, filters) => {
  for (const f of filters) {
    const [col, val] = f.split("=");
    q.eq(col, val);
  }
  return q;
};
if (cmd === "serve") {
  await init_server().then(() => exports_server);
} else if (cmd === "signup") {
  const [email, password] = args;
  if (!email || !password)
    die("Usage: busybase signup <email> <password>");
  const r = await db.auth.signUp({ email, password });
  print(r);
} else if (cmd === "signin") {
  const [email, password] = args;
  if (!email || !password)
    die("Usage: busybase signin <email> <password>");
  const r = await db.auth.signInWithPassword({ email, password });
  print(r);
} else if (cmd === "user") {
  const r = await db.auth.getUser();
  print(r);
} else if (cmd === "insert") {
  const [table, jsonStr] = args;
  if (!table || !jsonStr)
    die("Usage: busybase insert <table> <json>");
  const data = JSON.parse(jsonStr);
  const r = await db.from(table).insert(data);
  print(r);
} else if (cmd === "query") {
  const [table, ...filters] = args;
  if (!table)
    die("Usage: busybase query <table> [col=val ...]");
  let q = db.from(table).select("*");
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
} else if (cmd === "update") {
  const [table, jsonStr, ...filters] = args;
  if (!table || !jsonStr)
    die("Usage: busybase update <table> <json> [col=val ...]");
  const data = JSON.parse(jsonStr);
  let q = db.from(table).update(data);
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
} else if (cmd === "delete") {
  const [table, ...filters] = args;
  if (!table || !filters.length)
    die("Usage: busybase delete <table> <col=val> ...");
  let q = db.from(table).delete();
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
} else if (cmd === "vec") {
  const [table, vecStr, limitStr] = args;
  if (!table || !vecStr)
    die("Usage: busybase vec <table> <json-vec> [limit]");
  const vec = JSON.parse(vecStr);
  const limit = limitStr ? parseInt(limitStr) : 10;
  const r = await db.from(table).select("*").vec(vec, limit);
  print(r);
} else if (cmd === "test") {
  let pass = 0, fail = 0;
  const check = (name, ok2, got) => {
    if (ok2) {
      console.log(`  \u2713 ${name}`);
      pass++;
    } else {
      console.error(`  \u2717 ${name}`, got !== undefined ? JSON.stringify(got).slice(0, 120) : "");
      fail++;
    }
  };
  console.log(`
Testing against ${URL2}
`);
  console.log("[auth.signUp]");
  const su = await db.auth.signUp({ email: `test_${Date.now()}@bb.com`, password: "pass123" });
  check("returns {data,error}", su.data !== undefined && "error" in su, su);
  check("data.user has id", !!su.data?.user?.id, su.data);
  const email = su.data?.user?.email;
  console.log(`
[auth.signInWithPassword]`);
  const si = await db.auth.signInWithPassword({ email, password: "pass123" });
  check("returns {data,error}", si.data !== undefined && "error" in si, si);
  check("data.session.access_token exists", !!si.data?.session?.access_token, si.data);
  check("data.user.email matches", si.data?.user?.email === email, si.data?.user);
  console.log(`
[auth.signInWithPassword - bad creds]`);
  const bad = await db.auth.signInWithPassword({ email, password: "wrong" });
  check("error on bad creds", !!bad.error, bad);
  console.log(`
[auth.getUser]`);
  const gu = await db.auth.getUser();
  check("returns {data,error}", gu.data !== undefined && "error" in gu, gu);
  check("data.user.email matches", gu.data?.user?.email === email, gu.data);
  console.log(`
[auth.getSession]`);
  const gs = await db.auth.getSession();
  check("returns {data,error}", gs.data !== undefined && "error" in gs, gs);
  check("data.session has token", !!gs.data?.session?.access_token, gs.data);
  console.log(`
[auth.updateUser]`);
  const uu = await db.auth.updateUser({ data: { name: "Alice" } });
  check("returns {data,error}", uu.data !== undefined && "error" in uu, uu);
  console.log(`
[auth.onAuthStateChange]`);
  let fired = false;
  const { data: { subscription } } = db.auth.onAuthStateChange((event, sess) => {
    fired = true;
  });
  await Bun.sleep(10);
  check("INITIAL_SESSION fires", fired);
  subscription.unsubscribe();
  const tbl = `test_${Date.now()}`;
  console.log(`
[from.insert \u2014 table: ${tbl}]`);
  const ins1 = await db.from(tbl).insert({ name: "Alice", score: "10" });
  check("returns {data,error}", ins1.data !== undefined && "error" in ins1, ins1);
  check("data[0].name = Alice", ins1.data?.[0]?.name === "Alice", ins1.data);
  const ins2 = await db.from(tbl).insert([{ name: "Bob", score: "20" }, { name: "Carol", score: "30" }]);
  check("batch insert data.length=2", ins2.data?.length === 2, ins2.data);
  console.log(`
[from.select]`);
  const all = await db.from(tbl).select("*");
  check("returns {data,error}", all.data !== undefined && "error" in all, all);
  check("data.length=3", all.data?.length === 3, all.data);
  console.log(`
[filters]`);
  const feq = await db.from(tbl).select("*").eq("name", "Alice");
  check(".eq \u2014 1 row", feq.data?.length === 1, feq.data);
  const fneq = await db.from(tbl).select("*").neq("name", "Alice");
  check(".neq \u2014 2 rows", fneq.data?.length === 2, fneq.data);
  const fin = await db.from(tbl).select("*").in("name", ["Alice", "Bob"]);
  check(".in \u2014 2 rows", fin.data?.length === 2, fin.data);
  const flike = await db.from(tbl).select("*").like("name", "Ali");
  check(".like \u2014 1 row", flike.data?.length === 1, flike.data);
  const for_ = await db.from(tbl).select("*").or("name.eq.Alice,name.eq.Bob");
  check(".or \u2014 2 rows", for_.data?.length === 2, for_.data);
  const fnot = await db.from(tbl).select("*").not("name", "eq", "Alice");
  check(".not \u2014 2 rows", fnot.data?.length === 2, fnot.data);
  console.log(`
[modifiers]`);
  const ord = await db.from(tbl).select("*").order("name", { ascending: true });
  check(".order asc \u2014 first=Alice", ord.data?.[0]?.name === "Alice", ord.data);
  const lim = await db.from(tbl).select("*").limit(2);
  check(".limit(2) \u2014 2 rows", lim.data?.length === 2, lim.data);
  const off = await db.from(tbl).select("*").order("name", { ascending: true }).offset(1).limit(1);
  check(".offset(1) \u2014 Bob", off.data?.[0]?.name === "Bob", off.data);
  const rng = await db.from(tbl).select("*").order("name", { ascending: true }).range(0, 1);
  check(".range(0,1) \u2014 2 rows", rng.data?.length === 2, rng.data);
  const cnt = await db.from(tbl).select("*").count("exact");
  check(".count \u2014 count=3", cnt.count === 3, cnt);
  const sng = await db.from(tbl).select("*").eq("name", "Alice").single();
  check(".single() \u2014 returns object", !Array.isArray(sng.data) && sng.data?.name === "Alice", sng.data);
  const ms = await db.from(tbl).select("*").eq("name", "Nobody").maybeSingle();
  check(".maybeSingle() \u2014 null if no rows", ms.data === null && !ms.error, ms);
  const sel = await db.from(tbl).select("name");
  check(".select(cols) \u2014 only name key", sel.data?.[0] && Object.keys(sel.data[0]).length === 1, sel.data?.[0]);
  console.log(`
[update + delete]`);
  const upd = await db.from(tbl).update({ score: "99" }).eq("name", "Alice");
  check(".update.eq \u2014 score=99", upd.data?.[0]?.score === "99", upd.data);
  const del = await db.from(tbl).delete().eq("name", "Carol");
  check(".delete.eq \u2014 ok", !del.error, del);
  const afterDel = await db.from(tbl).select("*");
  check("2 rows remain after delete", afterDel.data?.length === 2, afterDel.data);
  console.log(`
[vector search]`);
  const vtbl = `vec_${Date.now()}`;
  await db.from(vtbl).insert([
    { label: "cat", vector: [1, 0, 0, 0] },
    { label: "dog", vector: [0, 1, 0, 0] },
    { label: "fish", vector: [0, 0, 1, 0] }
  ]);
  const vs = await db.from(vtbl).select("*").vec([1, 0, 0, 0], 2);
  check("vec top result = cat", vs.data?.[0]?.label === "cat", vs.data);
  check("vec has _distance", typeof vs.data?.[0]?._distance === "number", vs.data?.[0]);
  check("vec limit=2", vs.data?.length === 2, vs.data);
  console.log(`
[auth.signOut]`);
  await db.auth.signOut();
  const afterOut = await db.auth.getUser();
  check("getUser after signOut = error", !!afterOut.error, afterOut);
  console.log(`
${"=".repeat(40)}`);
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0)
    process.exit(1);
} else {
  console.log(`BusyBase CLI

Commands:
  serve                            Start the server
  test                             Run full SDK test suite
  signup <email> <pass>            Register user
  signin <email> <pass>            Sign in
  user                             Get current user
  insert <table> <json>            Insert row(s)
  query <table> [col=val ...]      Query with filters
  update <table> <json> [col=val]  Update rows
  delete <table> <col=val> ...     Delete rows
  vec <table> <[...vec]> [limit]   Vector search

Environment:
  BUSYBASE_URL   Server URL (default: http://localhost:54321)
  BUSYBASE_KEY   API key (default: local)
  BUSYBASE_DIR   Data dir for 'serve' (default: busybase_data)
  BUSYBASE_PORT  Port for 'serve' (default: 54321)
`);
}
