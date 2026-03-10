// @bun
// src/server.ts
import { connect } from "vectordb";
var DIR = process.env.BUSYBASE_DIR || "busybase_data";
var PORT = process.env.BUSYBASE_PORT || 54321;
var Z = [0];
var SENTINEL = "_sentinel_";
var vdb = await connect(DIR);
var tableCache = new Map;
var openTbl = async (name) => {
  if (tableCache.has(name))
    return tableCache.get(name);
  const names = await vdb.tableNames();
  if (!names.includes(name))
    return null;
  const t = await vdb.openTable(name);
  tableCache.set(name, t);
  return t;
};
var mkTbl = async (name, schema) => {
  const t = await vdb.createTable(name, schema);
  tableCache.set(name, t);
  return t;
};
if (!await openTbl("_users"))
  await mkTbl("_users", [{ id: SENTINEL, email: SENTINEL, pw: "", created: "", meta: "{}", vector: Z }]);
if (!await openTbl("_sessions"))
  await mkTbl("_sessions", [{ token: SENTINEL, uid: "", exp: 0, vector: Z }]);
var real = (col = "id") => `${col} != '${SENTINEL}'`;
var execFilter = async (t, filter) => {
  try {
    return await t.filter(filter).execute();
  } catch {
    return [];
  }
};
var getRows = async (tblName, filter) => {
  const t = await openTbl(tblName);
  if (!t)
    return [];
  const pk = tblName === "_sessions" ? "token" : "id";
  return execFilter(t, `(${real(pk)}) AND (${filter})`);
};
var getAllRows = async (tblName) => {
  const t = await openTbl(tblName);
  if (!t)
    return [];
  return execFilter(t, real("id"));
};
var validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && !s.startsWith("_");
var cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer"
};
var json = (data, status = 200) => Response.json(data, { status, headers: cors });
var ok = (data, status = 200) => json({ data, error: null }, status);
var err = (msg, code = 400, details = null) => json({ data: null, error: { message: msg, details, code } }, code);
var toFilter = (p) => {
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
};
var clean = (rows) => rows.map(({ vector, _distance, pw, ...r }) => _distance !== undefined ? { ...r, _distance } : r);
var getUser = async (r) => {
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
