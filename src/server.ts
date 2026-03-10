import { connect, type Table } from "vectordb";

const DIR = process.env.BUSYBASE_DIR || "busybase_data";
const PORT = process.env.BUSYBASE_PORT || 54321;
const Z = [0]; // dummy vector for non-vector rows
const SENTINEL = "_sentinel_";

const vdb = await connect(DIR);
const tableCache = new Map<string, Table>();

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

// Bootstrap auth tables with sentinel row so schema/types are established
if (!(await openTbl("_users")))
  await mkTbl("_users", [{ id: SENTINEL, email: SENTINEL, pw: "", created: "", vector: Z }]);
if (!(await openTbl("_sessions")))
  await mkTbl("_sessions", [{ token: SENTINEL, uid: "", exp: 0, vector: Z }]);

// All queries exclude the sentinel row
const real = (name: string) => `${name} != '${SENTINEL}'`;
const execFilter = async (t: Table, filter: string): Promise<any[]> => {
  try { return await t.filter(filter).execute() as any[]; }
  catch { return []; } // apache-arrow crashes on empty result sets in Bun
};

const getRows = async (tblName: string, filter: string): Promise<any[]> => {
  const t = await openTbl(tblName);
  if (!t) return [];
  return execFilter(t, `(${real(tblName === "_sessions" ? "token" : "id")}) AND (${filter})`);
};
const getAllRows = async (tblName: string): Promise<any[]> => {
  const t = await openTbl(tblName);
  if (!t) return [];
  return execFilter(t, real("id"));
};

const validId = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && !s.startsWith("_");

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey" };
const json = (data: any, status = 200) => Response.json(data, { status, headers: cors });

const toFilter = (p: Record<string, string>): string => {
  const parts: string[] = [];
  for (const [k, val] of Object.entries(p)) {
    if (["select", "order", "limit", "offset", "vec"].includes(k)) continue;
    const op = k.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is)\./)?.[1];
    if (!op) continue;
    const col = k.slice(op.length + 1);
    if (!validId(col)) continue;
    const safe = val.replace(/'/g, "''");
    if (op === "like" || op === "ilike") parts.push(`${col} LIKE '%${safe}%'`);
    else if (op === "is") parts.push(`${col} IS ${val}`);
    else {
      const sqlOp = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      parts.push(`${col} ${sqlOp} '${safe}'`);
    }
  }
  return parts.join(" AND ");
};

const clean = (rows: any[]) => rows.map(({ vector, _distance, ...r }) => _distance !== undefined ? { ...r, _distance } : r);

Bun.serve({ port: PORT, fetch: async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const { pathname, searchParams } = new URL(req.url);
  const P = Object.fromEntries(searchParams);
  const B = await req.json().catch(() => ({}));

  // --- Auth ---
  const getUser = async (r: Request) => {
    const token = r.headers.get("Authorization")?.split(" ")[1];
    if (!token) return null;
    const sessions = await getRows("_sessions", `token = '${token}'`);
    const s = sessions[0];
    if (!s || s.exp < Date.now()) return null;
    const users = await getRows("_users", `id = '${s.uid}'`);
    return users[0] ? { id: users[0].id, email: users[0].email } : null;
  };

  if (pathname.startsWith("/auth/v1/")) {
    const action = pathname.split("/")[3];

    if (action === "signup") {
      if (!B.email || !B.password) return json({ error: "Email & password required" }, 400);
      const existing = await getRows("_users", `email = '${B.email.replace(/'/g, "''")}'`);
      if (existing.length) return json({ error: "Email already registered" }, 409);
      const id = crypto.randomUUID();
      const pw = await Bun.password.hash(B.password);
      await (await openTbl("_users"))!.add([{ id, email: B.email, pw, created: new Date().toISOString(), vector: Z }]);
      return json({ id, email: B.email }, 201);
    }

    if (action === "token") {
      const users = await getRows("_users", `email = '${(B.email || "").replace(/'/g, "''")}'`);
      const u = users[0];
      if (!u || !await Bun.password.verify(B.password || "", u.pw)) return json({ error: "Invalid credentials" }, 401);
      const token = crypto.randomUUID();
      const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
      await (await openTbl("_sessions"))!.add([{ token, uid: u.id, exp, vector: Z }]);
      return json({ access_token: token, token_type: "bearer", expires_in: 604800, user: { id: u.id, email: u.email } });
    }

    if (action === "user") {
      const user = await getUser(req);
      return json(user ?? { error: "Unauthorized" }, user ? 200 : 401);
    }

    if (action === "logout") {
      const token = req.headers.get("Authorization")?.split(" ")[1];
      if (token) { const st = await openTbl("_sessions"); if (st) await st.delete(`token = '${token}'`); }
      return json({});
    }
  }

  // --- REST ---
  if (pathname.startsWith("/rest/v1/")) {
    const table = pathname.slice(9).split("/").map(decodeURIComponent).filter(Boolean)[0];
    if (!table) return json({ error: "Table required" }, 400);
    if (!validId(table)) return json({ error: "Invalid table name" }, 400);

    if (req.method === "GET") {
      if (P.vec) {
        const t = await openTbl(table);
        if (!t) return json([]);
        const limit = P.limit ? parseInt(P.limit) : 10;
        const filter = toFilter(P);
        let q = t.search(JSON.parse(P.vec) as number[]).limit(limit);
        if (filter) q = q.filter(`(${real("id")}) AND (${filter})`);
        else q = q.filter(real("id"));
        return json(clean(await q.execute() as any[]));
      }
      const filter = toFilter(P);
      let rows = filter ? await getRows(table, filter) : await getAllRows(table);
      if (P.select && P.select !== "*") {
        const cols = P.select.split(",").filter(c => validId(c));
        rows = rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
      }
      if (P.order) {
        const [col, dir] = P.order.split(".");
        if (validId(col)) rows.sort((a, b) => dir === "desc" ? (b[col] > a[col] ? 1 : -1) : (a[col] > b[col] ? 1 : -1));
      }
      const limit = P.limit ? parseInt(P.limit) : 1000;
      const offset = P.offset ? parseInt(P.offset) : 0;
      return json(clean(rows).slice(offset, offset + limit));
    }

    if (req.method === "POST") {
      const rows = Array.isArray(B) ? B : [B];
      if (!rows.length || !Object.keys(rows[0]).length) return json({ error: "Empty body" }, 400);
      if (Object.keys(rows[0]).some(k => k !== "vector" && !validId(k))) return json({ error: "Invalid column name" }, 400);
      const prepared = rows.map(r => ({ id: r.id ?? crypto.randomUUID(), ...r, vector: r.vector ?? Z }));
      let t = await openTbl(table);
      if (!t) t = await mkTbl(table, prepared);
      else await t.add(prepared);
      return json(clean(prepared), 201);
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      const filter = toFilter(P);
      if (!filter) return json({ error: "No filter provided" }, 400);
      const t = await openTbl(table);
      if (!t) return json({ error: "Table not found" }, 404);
      const data = Array.isArray(B) ? B[0] : B;
      const existing = await getRows(table, filter);
      if (!existing.length) return json([]);
      await t.delete(`(${real("id")}) AND (${filter})`);
      const updated = existing.map(r => ({ ...r, ...data, vector: r.vector ?? Z }));
      await t.add(updated);
      return json(clean(updated));
    }

    if (req.method === "DELETE") {
      const filter = toFilter(P);
      if (!filter) return json({ error: "No filter provided" }, 400);
      const t = await openTbl(table);
      if (!t) return json({ error: "Table not found" }, 404);
      await t.delete(`(${real("id")}) AND (${filter})`);
      return json({ deleted: true });
    }
  }

  return json({ error: "Not found" }, 404);
}});

console.log(`🚀 BusyBase: http://localhost:${PORT}`);
