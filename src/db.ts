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

// --- Core, transport-agnostic data layer -----------------------------------
// Every function below takes the libSQL Client explicitly so both the HTTP
// server (server.ts, using the module-level `db` singleton) and embedded mode
// (embedded.ts, one Client per createEmbedded() call) share one implementation.

export const openClient = (dir: string): Client => {
  mkdirSync(dir, { recursive: true });
  return createClient({ url: `file:${dir}/db.sqlite` });
};

export const initAuthTablesFor = async (client: Client) => {
  await client.execute(`CREATE TABLE IF NOT EXISTS _users (
    id TEXT, email TEXT, pw TEXT, pubkey TEXT, role TEXT,
    meta TEXT, app_meta TEXT, created TEXT, updated TEXT, last_sign_in TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS _sessions (token TEXT, refresh TEXT, uid TEXT, exp INTEGER)`);
};

export const tableExistsIn = async (client: Client, name: string): Promise<boolean> => {
  const r = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [name] });
  return r.rows.length > 0;
};

export const openTblIn = async (client: Client, name: string): Promise<string | null> =>
  (await tableExistsIn(client, name)) ? name : null;

export const mkTblIn = async (client: Client, name: string, row: Record<string, any>): Promise<string> => {
  const cols = Object.keys(row).map(k => `${k} TEXT`).join(", ");
  await client.execute(`CREATE TABLE IF NOT EXISTS ${name} (${cols})`);
  return name;
};

export const getTableColumnsIn = async (client: Client, name: string): Promise<Set<string>> => {
  const info = await client.execute(`PRAGMA table_info(${name})`);
  return new Set(info.rows.map((r: any) => r.name as string));
};

export const ensureColsIn = async (client: Client, name: string, row: Record<string, any>): Promise<void> => {
  const existing = await getTableColumnsIn(client, name);
  for (const k of Object.keys(row)) {
    if (!existing.has(k)) await client.execute(`ALTER TABLE ${name} ADD COLUMN ${k} TEXT`).catch(() => {});
  }
};

const tableLocksByClient = new WeakMap<Client, Map<string, Promise<any>>>();

// Serializes create-or-add-columns per (client, table name) so concurrent
// first-inserts with differing row shapes can't race CREATE TABLE / ALTER TABLE ADD COLUMN.
export const ensureTableIn = async (client: Client, name: string, row: Record<string, any>): Promise<void> => {
  let locks = tableLocksByClient.get(client);
  if (!locks) { locks = new Map(); tableLocksByClient.set(client, locks); }
  const prior = locks.get(name) || Promise.resolve();
  const next = prior.then(async () => {
    if (!(await tableExistsIn(client, name))) await mkTblIn(client, name, row);
    else await ensureColsIn(client, name, row);
  });
  locks.set(name, next.catch(() => {}));
  await next;
};

const toCell = (v: any): string | null =>
  v == null ? null : (typeof v === "object" ? JSON.stringify(v) : String(v));

export const dbInsertIn = async (client: Client, name: string, row: Record<string, any>): Promise<void> => {
  const keys = Object.keys(row);
  const ph = keys.map(() => "?").join(", ");
  const vals = keys.map(k => toCell(row[k]));
  await client.execute({ sql: `INSERT INTO ${name} (${keys.join(", ")}) VALUES (${ph})`, args: vals });
};

// Hard safety ceiling independent of client-requested limit/offset -- prevents
// a single unfiltered GET on a huge table from loading it entirely into memory.
export const MAX_ROWS_FETCHED = 50_000;

export const getRowsIn = async (client: Client, name: string, where: string): Promise<any[]> => {
  if (!(await tableExistsIn(client, name))) return [];
  const r = await client.execute(`SELECT * FROM ${name} WHERE ${where} LIMIT ${MAX_ROWS_FETCHED}`);
  return r.rows.map((row: any) => ({ ...row }));
};

export const getAllRowsIn = async (client: Client, name: string): Promise<any[]> => {
  if (!(await tableExistsIn(client, name))) return [];
  const r = await client.execute(`SELECT * FROM ${name} LIMIT ${MAX_ROWS_FETCHED}`);
  return r.rows.map((row: any) => ({ ...row }));
};

export const dbUpdateIn = async (client: Client, name: string, data: Record<string, any>, where: string): Promise<void> => {
  const keys = Object.keys(data).filter(k => k !== "id");
  if (!keys.length) return;
  const sets = keys.map(k => `${k}=?`).join(", ");
  const vals = keys.map(k => toCell(data[k]));
  await client.execute({ sql: `UPDATE ${name} SET ${sets} WHERE ${where}`, args: vals });
};

export const dbDeleteIn = async (client: Client, name: string, where: string): Promise<void> => {
  await client.execute(`DELETE FROM ${name} WHERE ${where}`);
};

export const tableNamesIn = async (client: Client): Promise<string[]> => {
  const r = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return r.rows.map((row: any) => row.name as string);
};

export const clean = (rows: any[]) => rows.map(({ pw, pubkey: _pk, ...r }) => r);

export const makeRateLimiter = (windowMs: number, max: number) => {
  const buckets = new Map<string, number[]>();
  const limited = (key: string): boolean => {
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
    hits.push(now);
    buckets.set(key, hits);
    return hits.length > max;
  };
  const sweep = () => {
    const now = Date.now();
    for (const [k, hits] of buckets) {
      const fresh = hits.filter(t => now - t < windowMs);
      if (fresh.length) buckets.set(k, fresh); else buckets.delete(k);
    }
  };
  return { limited, sweep };
};

export const cosineDistance = (a: number[], b: number[]): number | null => {
  if (a.length !== b.length || !a.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return null;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
};

export const parseVector = (v: unknown): number[] | null => {
  if (typeof v !== "string" || !v) return null;
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) && arr.every(n => typeof n === "number") ? arr : null;
  } catch { return null; }
};

export const vecSearch = (rows: any[], embedding: number[], limit: number): any[] => {
  const scored: Array<{ row: any; dist: number }> = [];
  for (const row of rows) {
    const rowVec = parseVector(row.vector);
    if (!rowVec) continue;
    const dist = cosineDistance(embedding, rowVec);
    if (dist === null) continue;
    scored.push({ row: { ...row, _distance: dist }, dist });
  }
  scored.sort((x, y) => x.dist - y.dist);
  return scored.slice(0, limit).map(s => s.row);
};

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

export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
};

export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const issueSessionIn = async (client: Client, uid: string) => {
  const token = crypto.randomUUID(), refresh = crypto.randomUUID();
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const tokenHash = await hashToken(token), refreshHash = await hashToken(refresh);
  await client.execute({ sql: "INSERT INTO _sessions (token, refresh, uid, exp) VALUES (?, ?, ?, ?)", args: [tokenHash, refreshHash, uid, exp] });
  return { token, refresh, exp };
};

export const findSessionByTokenIn = async (client: Client, token: string) => {
  const tokenHash = await hashToken(token);
  const sessions = await client.execute({ sql: "SELECT * FROM _sessions WHERE token=? AND exp>?", args: [tokenHash, Date.now()] });
  const s = sessions.rows[0] as any;
  if (!s || !timingSafeEqual(String(s.token), tokenHash)) return null;
  return s;
};

export const deleteSessionByTokenIn = async (client: Client, token: string) => {
  const tokenHash = await hashToken(token);
  await client.execute({ sql: "DELETE FROM _sessions WHERE token=?", args: [tokenHash] });
};

export const getUserFromRequestIn = async (client: Client, r: Request) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token) return null;
  const s = await findSessionByTokenIn(client, token);
  if (!s) return null;
  const users = await getRowsIn(client, "_users", `id = '${esc(s.uid)}'`);
  return users[0] ? makeUser(users[0]) : null;
};

export const sweepExpiredIn = async (client: Client) => {
  await client.execute({ sql: "DELETE FROM _sessions WHERE exp < ?", args: [Date.now()] }).catch(() => {});
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

// --- Module-level singleton client for the HTTP server (server.ts et al) ---

export const db: Client = openClient(DIR);

export const tableExists = (name: string) => tableExistsIn(db, name);
export const openTbl = (name: string) => openTblIn(db, name);
export const mkTbl = (name: string, row: Record<string, any>) => mkTblIn(db, name, row);
export const ensureCols = (name: string, row: Record<string, any>) => ensureColsIn(db, name, row);
export const ensureTable = (name: string, row: Record<string, any>) => ensureTableIn(db, name, row);
export const dbInsert = (name: string, row: Record<string, any>) => dbInsertIn(db, name, row);
export const getRows = (name: string, where: string) => getRowsIn(db, name, where);
export const getAllRows = (name: string) => getAllRowsIn(db, name);
export const dbUpdate = (name: string, data: Record<string, any>, where: string) => dbUpdateIn(db, name, data, where);
export const dbDelete = (name: string, where: string) => dbDeleteIn(db, name, where);
export const tableNames = () => tableNamesIn(db);
export const issueSession = (uid: string) => issueSessionIn(db, uid);
export const findSessionByToken = (token: string) => findSessionByTokenIn(db, token);
export const deleteSessionByToken = (token: string) => deleteSessionByTokenIn(db, token);
export const getUser = (r: Request) => getUserFromRequestIn(db, r);
