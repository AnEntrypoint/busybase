import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";

export const DIR = process.env.BUSYBASE_DIR || "busybase_data";
export const CORS_ORIGIN = process.env.BUSYBASE_CORS_ORIGIN || "*";

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

export const esc = (s: string) => String(s).replace(/'/g, "''");
export const validId = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";

mkdirSync(DIR, { recursive: true });
export const db: Client = createClient({ url: `file:${DIR}/db.sqlite` });

export const tableExists = async (name: string): Promise<boolean> => {
  const r = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [name] });
  return r.rows.length > 0;
};

export const openTbl = async (name: string): Promise<string | null> =>
  (await tableExists(name)) ? name : null;

export const mkTbl = async (name: string, row: Record<string, any>): Promise<string> => {
  const cols = Object.keys(row).map(k => `${k} TEXT`).join(", ");
  await db.execute(`CREATE TABLE IF NOT EXISTS ${name} (${cols})`);
  return name;
};

export const ensureCols = async (name: string, row: Record<string, any>): Promise<void> => {
  const info = await db.execute(`PRAGMA table_info(${name})`);
  const existing = new Set(info.rows.map((r: any) => r.name as string));
  for (const k of Object.keys(row)) {
    if (!existing.has(k)) await db.execute(`ALTER TABLE ${name} ADD COLUMN ${k} TEXT`);
  }
};

export const dbInsert = async (name: string, row: Record<string, any>): Promise<void> => {
  const keys = Object.keys(row);
  const ph = keys.map(() => "?").join(", ");
  const vals = keys.map(k => row[k] == null ? null : String(row[k]));
  await db.execute({ sql: `INSERT INTO ${name} (${keys.join(", ")}) VALUES (${ph})`, args: vals });
};

export const getRows = async (name: string, where: string): Promise<any[]> => {
  if (!(await tableExists(name))) return [];
  const r = await db.execute(`SELECT * FROM ${name} WHERE ${where}`);
  return r.rows.map((row: any) => ({ ...row }));
};

export const getAllRows = async (name: string): Promise<any[]> => {
  if (!(await tableExists(name))) return [];
  const r = await db.execute(`SELECT * FROM ${name}`);
  return r.rows.map((row: any) => ({ ...row }));
};

export const dbUpdate = async (name: string, data: Record<string, any>, where: string): Promise<void> => {
  const keys = Object.keys(data).filter(k => k !== "id");
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(", ");
  const vals = keys.map(k => data[k] == null ? null : String(data[k]));
  await db.execute({ sql: `UPDATE ${name} SET ${sets} WHERE ${where}`, args: vals });
};

export const dbDelete = async (name: string, where: string): Promise<void> => {
  await db.execute(`DELETE FROM ${name} WHERE ${where}`);
};

export const tableNames = async (): Promise<string[]> => {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return r.rows.map((row: any) => row.name as string);
};

export const clean = (rows: any[]) => rows.map(({ pw, pubkey: _pk, ...r }) => r);

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
  await db.execute({ sql: "INSERT INTO _sessions (token, refresh, uid, exp) VALUES (?, ?, ?, ?)", args: [token, refresh, uid, exp] });
  return { token, refresh, exp };
};

export const getUser = async (r: Request) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token) return null;
  const sessions = await db.execute({ sql: "SELECT * FROM _sessions WHERE token=? AND exp>?", args: [token, Date.now()] });
  const s = sessions.rows[0] as any;
  if (!s) return null;
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
