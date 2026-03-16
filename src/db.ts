import { connect, type Table } from "vectordb";

export const DIR = process.env.BUSYBASE_DIR || "busybase_data";
export const CORS_ORIGIN = process.env.BUSYBASE_CORS_ORIGIN || "*";
export const Z = [0];
export const SENTINEL = "_sentinel_";
export const esc = (s: string) => s.replace(/'/g, "''");
export const real = (col = "id") => `${col} != '${SENTINEL}'`;
export const validId = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";

export const cors = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer",
};

export const json = (data: any, status = 200, extra: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { ...cors, ...extra } });
export const ok = (data: any, status = 200, extra: Record<string, string> = {}) =>
  json({ data, error: null }, status, extra);
export const err = (msg: string, code = 400, hint = "") =>
  json({ data: null, error: { message: msg, hint, code } }, code);

const vdb = await connect(DIR);
const tableCache = new Map<string, Table>();

export const openTbl = async (name: string): Promise<Table | null> => {
  if (tableCache.has(name)) return tableCache.get(name)!;
  const names = await vdb.tableNames();
  if (!names.includes(name)) return null;
  const t = await vdb.openTable(name);
  tableCache.set(name, t);
  return t;
};

export const mkTbl = async (name: string, schema: any[]): Promise<Table> => {
  const t = await vdb.createTable(name, schema);
  tableCache.set(name, t);
  return t;
};

export const execFilter = async (t: Table, filter: string): Promise<any[]> => {
  try { return await t.filter(filter).execute() as any[]; }
  catch { return []; }
};

export const getRows = async (name: string, filter: string): Promise<any[]> => {
  const t = await openTbl(name);
  if (!t) return [];
  return execFilter(t, `(${real(name === "_sessions" ? "token" : "id")}) AND (${filter})`);
};

export const getAllRows = async (name: string): Promise<any[]> => {
  const t = await openTbl(name);
  if (!t) return [];
  return execFilter(t, real("id"));
};

export const clean = (rows: any[]) => rows.map(({ vector, pw, pubkey: _pk, ...r }) => r);

export const makeUser = (u: any) => ({
  id: u.id, email: u.email || null, role: u.role || "authenticated",
  user_metadata: JSON.parse(u.meta || "{}"),
  app_metadata: JSON.parse(u.app_meta || "{}"),
  identities: [], aud: "authenticated",
  created_at: u.created, updated_at: u.updated || u.created,
  last_sign_in_at: u.last_sign_in || u.created,
  email_confirmed_at: u.email ? u.created : null,
});

export const makeSession = (token: string, refresh: string, exp: number, user: any) => ({
  access_token: token, refresh_token: refresh,
  token_type: "bearer", expires_in: 604800,
  expires_at: Math.floor(exp / 1000), user,
});

export const issueSession = async (uid: string) => {
  const token = crypto.randomUUID(), refresh = crypto.randomUUID();
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await (await openTbl("_sessions"))!.add([{ token, refresh, uid, exp, vector: Z }]);
  return { token, refresh, exp };
};

export const getUser = async (r: Request) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token) return null;
  const sessions = await getRows("_sessions", `token = '${esc(token)}'`);
  const s = sessions[0];
  if (!s || s.exp < Date.now()) return null;
  const users = await getRows("_users", `id = '${esc(s.uid)}'`);
  return users[0] ? makeUser(users[0]) : null;
};

export const toFilter = (p: Record<string, string>): string => {
  const skip = new Set(["select", "order", "limit", "offset", "vec", "count"]);
  const parts: string[] = [];
  for (const [k, val] of Object.entries(p)) {
    if (skip.has(k)) continue;
    if (k.startsWith("in.")) {
      const col = k.slice(3);
      if (!validId(col)) continue;
      const list = val.split(",").map(v => `'${esc(v)}'`).join(",");
      parts.push(`${col} IN (${list})`); continue;
    }
    if (k === "or") {
      const orParts = decodeURIComponent(val).split(",").map(clause => {
        const d1 = clause.indexOf("."), d2 = clause.indexOf(".", d1 + 1);
        if (d1 < 0 || d2 < 0) return null;
        const col = clause.slice(0, d1), op = clause.slice(d1 + 1, d2), v = esc(clause.slice(d2 + 1));
        if (!validId(col)) return null;
        const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : op === "lte" ? "<=" : null;
        return s ? `${col} ${s} '${v}'` : null;
      }).filter(Boolean);
      if (orParts.length) parts.push(`(${orParts.join(" OR ")})`); continue;
    }
    if (k.startsWith("not.")) {
      const rest = k.slice(4), dot = rest.indexOf(".");
      const col = dot >= 0 ? rest.slice(0, dot) : rest, op = dot >= 0 ? rest.slice(dot + 1) : "eq";
      if (!validId(col)) continue;
      const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : op === "lte" ? "<=" : "=";
      parts.push(`NOT (${col} ${s} '${esc(val)}')`); continue;
    }
    const op = k.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is)\./)?.[1];
    if (!op) continue;
    const col = k.slice(op.length + 1);
    if (!validId(col)) continue;
    const safe = esc(val);
    if (op === "like") parts.push(`${col} LIKE '${safe}'`);
    else if (op === "ilike") parts.push(`LOWER(${col}) LIKE LOWER('${safe}')`);
    else if (op === "is") {
      const upper = val.trim().toUpperCase();
      if (!["NULL", "TRUE", "FALSE"].includes(upper)) continue;
      parts.push(`${col} IS ${upper}`);
    } else {
      const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      parts.push(`${col} ${s} '${safe}'`);
    }
  }
  return parts.join(" AND ");
};
