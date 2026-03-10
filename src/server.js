// @bun
// src/server.ts
import { Database } from "bun:sqlite";
var DB = process.env.BUSYBASE_DB || "busybase.db";
var PORT = process.env.BUSYBASE_PORT || 54321;
var AUTH = "_bb_";
var db = new Database(DB);
db.run("PRAGMA journal_mode=WAL");
db.run(`CREATE TABLE IF NOT EXISTS ${AUTH}users (id TEXT PRIMARY KEY, email TEXT UNIQUE, pw TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP)`);
db.run(`CREATE TABLE IF NOT EXISTS ${AUTH}sessions (token TEXT PRIMARY KEY, uid TEXT, exp TEXT)`);
var validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && !s.startsWith(AUTH);
var G = (s, v = []) => db.query(s).get(...v);
var R = (s, v = []) => db.run(s, v);
var getUserByEmail = (e) => G(`SELECT * FROM ${AUTH}users WHERE email = ?`, [e]);
var getSession = (t) => G(`SELECT * FROM ${AUTH}sessions WHERE token = ? AND exp > datetime('now')`, [t]);
var auth = (r) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token)
    return null;
  const s = getSession(token);
  return s ? G(`SELECT id,email FROM ${AUTH}users WHERE id = ?`, [s.uid]) : null;
};
var cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey" };
var json = (data, status = 200) => Response.json(data, { status, headers: cors });
Bun.serve({ port: PORT, fetch: async (req) => {
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  const { pathname, searchParams } = new URL(req.url);
  const P = Object.fromEntries(searchParams);
  const B = await req.json().catch(() => ({}));
  if (pathname.startsWith("/rest/v1/")) {
    const table = pathname.slice(9).split("/").map(decodeURIComponent).filter(Boolean)[0];
    if (!table)
      return json({ error: "Table required" }, 400);
    if (!validId(table))
      return json({ error: "Invalid table name" }, 400);
    const cols = () => db.query(`PRAGMA table_info("${table}")`).all();
    const sql = (s, v = []) => db.query(s).all(...v);
    const run = (s, v = []) => {
      R(s, v);
      return sql(`SELECT * FROM "${table}" WHERE rowid = last_insert_rowid()`);
    };
    const where = (p) => {
      const w = [], v = [];
      for (const [k, val] of Object.entries(p)) {
        if (["select", "order", "limit", "offset", "range"].includes(k))
          continue;
        const op = k.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is)\./)?.[1];
        if (!op)
          continue;
        const col = k.slice(op.length + 1);
        if (!validId(col))
          continue;
        const sqlOp = op === "eq" || op === "is" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : op === "lte" ? "<=" : op === "like" ? "LIKE" : op === "ilike" ? "LIKE" : "=";
        w.push(`"${col}" ${sqlOp} ?`);
        v.push(op === "like" || op === "ilike" ? `%${val}%` : val);
      }
      return [w.join(" AND "), v];
    };
    if (req.method === "GET") {
      const [w, v] = where(P);
      if (!cols().length)
        return json([]);
      const select = P.select && P.select !== "*" ? P.select.split(",").filter((c) => validId(c)).map((c) => `"${c}"`).join(",") : "*";
      let q = `SELECT ${select} FROM "${table}"${w ? ` WHERE ${w}` : ""}`;
      if (P.order) {
        const [col, dir] = P.order.split(".");
        if (validId(col))
          q += ` ORDER BY "${col}" ${dir === "desc" ? "DESC" : "ASC"}`;
      }
      const limit = P.limit ? parseInt(P.limit) : 1000;
      const offset = P.offset ? parseInt(P.offset) : 0;
      q += ` LIMIT ${limit} OFFSET ${offset}`;
      return json(sql(q, v));
    }
    if (req.method === "POST") {
      const rows = Array.isArray(B) ? B : [B];
      if (!rows.length || !Object.keys(rows[0]).length)
        return json({ error: "Empty body" }, 400);
      const keys = Object.keys(rows[0]);
      if (keys.some((k) => !validId(k)))
        return json({ error: "Invalid column name" }, 400);
      if (!cols().length)
        db.run(`CREATE TABLE IF NOT EXISTS "${table}" (${keys.map((k) => `"${k}" TEXT`).join(",")})`);
      const colSql = keys.map((k) => `"${k}"`).join(",");
      const placeholders = keys.map(() => "?").join(",");
      const inserted = [];
      for (const row of rows)
        inserted.push(...run(`INSERT INTO "${table}" (${colSql}) VALUES (${placeholders})`, keys.map((k) => row[k])));
      return json(inserted, 201);
    }
    if (req.method === "PUT" || req.method === "PATCH") {
      const [w, v] = where(P);
      if (!w)
        return json({ error: "No filter provided" }, 400);
      if (!cols().length)
        return json({ error: "Table not found" }, 404);
      const data = Array.isArray(B) ? B[0] : B;
      const keys = Object.keys(data);
      if (!keys.length)
        return json({ error: "Empty body" }, 400);
      if (keys.some((k) => !validId(k)))
        return json({ error: "Invalid column name" }, 400);
      R(`UPDATE "${table}" SET ${keys.map((k) => `"${k}"=?`).join(",")} WHERE ${w}`, [...keys.map((k) => data[k]), ...v]);
      return json(sql(`SELECT * FROM "${table}" WHERE ${w}`, v));
    }
    if (req.method === "DELETE") {
      const [w, v] = where(P);
      if (!w)
        return json({ error: "No filter provided" }, 400);
      if (!cols().length)
        return json({ error: "Table not found" }, 404);
      R(`DELETE FROM "${table}" WHERE ${w}`, v);
      return json({ deleted: true });
    }
  }
  if (pathname.startsWith("/auth/v1/")) {
    const action = pathname.split("/")[3];
    if (action === "signup") {
      if (!B.email || !B.password)
        return json({ error: "Email & password required" }, 400);
      try {
        const id = crypto.randomUUID();
        const hash = await Bun.password.hash(B.password);
        R(`INSERT INTO ${AUTH}users (id,email,pw) VALUES (?,?,?)`, [id, B.email, hash]);
        return json({ id, email: B.email }, 201);
      } catch {
        return json({ error: "Email already registered" }, 409);
      }
    }
    if (action === "token") {
      const u = B.email && getUserByEmail(B.email);
      if (!u)
        return json({ error: "Invalid credentials" }, 401);
      const ok = await Bun.password.verify(B.password || "", u.pw);
      if (!ok)
        return json({ error: "Invalid credentials" }, 401);
      const token = crypto.randomUUID();
      const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
      R(`INSERT INTO ${AUTH}sessions (token,uid,exp) VALUES (?,?,?)`, [token, u.id, exp]);
      return json({ access_token: token, token_type: "bearer", expires_in: 604800, user: { id: u.id, email: u.email } });
    }
    if (action === "user") {
      const user = auth(req);
      return json(user ? { id: user.id, email: user.email } : { error: "Unauthorized" }, user ? 200 : 401);
    }
    if (action === "logout") {
      const token = req.headers.get("Authorization")?.split(" ")[1];
      if (token)
        R(`DELETE FROM ${AUTH}sessions WHERE token = ?`, [token]);
      return json({});
    }
  }
  return json({ error: "Not found" }, 404);
} });
console.log(`\uD83D\uDE80 BusyBase: http://localhost:${PORT}`);
