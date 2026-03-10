import { connect, type Table } from "vectordb";

const DIR = process.env.BUSYBASE_DIR || "busybase_data";
const PORT = process.env.BUSYBASE_PORT || 54321;
const Z = [0];
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

if (!(await openTbl("_users")))
  await mkTbl("_users", [{ id: SENTINEL, email: SENTINEL, pw: "", pubkey: "", role: "authenticated", meta: "{}", app_meta: "{}", created: "", updated: "", last_sign_in: "", vector: Z }]);
if (!(await openTbl("_sessions")))
  await mkTbl("_sessions", [{ token: SENTINEL, refresh: SENTINEL, uid: "", exp: 0, vector: Z }]);
// Nonces for keypair challenge (short-lived, in-memory is fine)
const nonces = new Map<string, number>(); // nonce -> expiry ms

const real = (col = "id") => `${col} != '${SENTINEL}'`;
const execFilter = async (t: Table, filter: string): Promise<any[]> => {
  try { return await t.filter(filter).execute() as any[]; }
  catch { return []; }
};
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

const validId = (s: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer",
};
const json = (data: any, status = 200, extra: Record<string, string> = {}) =>
  Response.json(data, { status, headers: { ...cors, ...extra } });
const ok = (data: any, status = 200, extra: Record<string, string> = {}) =>
  json({ data, error: null }, status, extra);
const err = (msg: string, code = 400, hint = "") =>
  json({ data: null, error: { message: msg, hint, code } }, code);

const toFilter = (p: Record<string, string>): string => {
  const skip = new Set(["select", "order", "limit", "offset", "vec", "count"]);
  const parts: string[] = [];
  for (const [k, val] of Object.entries(p)) {
    if (skip.has(k)) continue;
    if (k.startsWith("in.")) {
      const col = k.slice(3);
      if (!validId(col)) continue;
      const list = val.split(",").map(v => `'${v.replace(/'/g, "''")}'`).join(",");
      parts.push(`${col} IN (${list})`); continue;
    }
    if (k === "or") {
      const orParts = decodeURIComponent(val).split(",").map(clause => {
        const d1 = clause.indexOf("."), d2 = clause.indexOf(".", d1 + 1);
        if (d1 < 0 || d2 < 0) return null;
        const col = clause.slice(0, d1), op = clause.slice(d1 + 1, d2), v = clause.slice(d2 + 1).replace(/'/g, "''");
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
      const safe = val.replace(/'/g, "''");
      const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : op === "lte" ? "<=" : "=";
      parts.push(`NOT (${col} ${s} '${safe}')`); continue;
    }
    const op = k.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is)\./)?.[1];
    if (!op) continue;
    const col = k.slice(op.length + 1);
    if (!validId(col)) continue;
    const safe = val.replace(/'/g, "''");
    if (op === "like" || op === "ilike") parts.push(`${col} LIKE '%${safe}%'`);
    else if (op === "is") parts.push(`${col} IS ${val}`);
    else {
      const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      parts.push(`${col} ${s} '${safe}'`);
    }
  }
  return parts.join(" AND ");
};

const clean = (rows: any[]) => rows.map(({ vector, pw, pubkey: _pk, ...r }) => r);

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

const issueSession = async (uid: string) => {
  const token = crypto.randomUUID(), refresh = crypto.randomUUID();
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await (await openTbl("_sessions"))!.add([{ token, refresh, uid, exp, vector: Z }]);
  return { token, refresh, exp };
};

const getUser = async (r: Request) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token) return null;
  const sessions = await getRows("_sessions", `token = '${token}'`);
  const s = sessions[0];
  if (!s || s.exp < Date.now()) return null;
  const users = await getRows("_users", `id = '${s.uid}'`);
  return users[0] ? makeUser(users[0]) : null;
};

// Import key from base64 for Ed25519 verify
const importPubKey = (b64: string) =>
  crypto.subtle.importKey("raw", Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);

Bun.serve({ port: PORT, fetch: async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  const { pathname, searchParams } = new URL(req.url);
  const P = Object.fromEntries(searchParams);
  const B = await req.json().catch(() => ({}));
  const prefer = req.headers.get("Prefer") || "";
  const returnMinimal = prefer.includes("return=minimal");

  if (pathname.startsWith("/auth/v1/")) {
    const action = pathname.split("/")[3];

    // --- Keypair: step 1 — get a nonce to sign ---
    if (action === "keypair" && req.method === "GET") {
      const nonce = crypto.randomUUID();
      nonces.set(nonce, Date.now() + 60_000); // 60s TTL
      return ok({ nonce });
    }

    // --- Keypair: step 2 — verify signature, get/create user + session ---
    if (action === "keypair" && req.method === "POST") {
      const { pubkey, nonce, signature } = B;
      if (!pubkey || !nonce || !signature) return err("pubkey, nonce and signature required");

      // Validate nonce
      const exp = nonces.get(nonce);
      if (!exp || exp < Date.now()) return err("Invalid or expired nonce", 401);
      nonces.delete(nonce);

      // Verify Ed25519 signature over the nonce
      let valid = false;
      try {
        const key = await importPubKey(pubkey);
        const sig = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
        valid = await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(nonce));
      } catch { return err("Invalid signature", 401); }
      if (!valid) return err("Signature verification failed", 401);

      // Find or create user by pubkey
      const now = new Date().toISOString();
      let users = await getRows("_users", `pubkey = '${pubkey}'`);
      let u = users[0];
      const ut = (await openTbl("_users"))!;
      if (!u) {
        // New anonymous user — create instantly, no email/password needed
        u = { id: crypto.randomUUID(), email: "", pw: "", pubkey, role: "authenticated", meta: "{}", app_meta: "{}", created: now, updated: now, last_sign_in: now, vector: Z };
        await ut.add([u]);
      } else {
        // Update last_sign_in
        await ut.delete(`id = '${u.id}'`);
        u = { ...u, last_sign_in: now, updated: now };
        await ut.add([u]);
      }

      const { token, refresh, exp: sExp } = await issueSession(u.id);
      const user = makeUser(u);
      return ok({ user, session: makeSession(token, refresh, sExp, user) });
    }

    // --- Email signup ---
    if (action === "signup") {
      if (!B.email || !B.password) return err("Email & password required");
      const emailLower = B.email.toLowerCase();
      const existing = await getRows("_users", `email = '${emailLower.replace(/'/g, "''")}'`);
      if (existing.length) return err("User already registered", 400, "Check if user already exists");
      const now = new Date().toISOString();
      const u = { id: crypto.randomUUID(), email: emailLower, pw: await Bun.password.hash(B.password), pubkey: "", role: "authenticated", meta: JSON.stringify(B.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now, vector: Z };
      await (await openTbl("_users"))!.add([u]);
      return ok({ user: makeUser(u), session: null });
    }

    // --- Email sign-in ---
    if (action === "token") {
      const emailLower = (B.email || "").toLowerCase();
      const users = await getRows("_users", `email = '${emailLower.replace(/'/g, "''")}'`);
      const u = users[0];
      if (!u || !await Bun.password.verify(B.password || "", u.pw)) return err("Invalid login credentials", 400);
      const now = new Date().toISOString();
      const ut = (await openTbl("_users"))!;
      await ut.delete(`id = '${u.id}'`);
      await ut.add([{ ...u, last_sign_in: now, updated: now }]);
      const { token, refresh, exp } = await issueSession(u.id);
      const user = makeUser({ ...u, last_sign_in: now, updated: now });
      return ok({ user, session: makeSession(token, refresh, exp, user) });
    }

    if (action === "user") {
      const user = await getUser(req);
      if (!user) return err("Not authenticated", 401);
      return ok({ user });
    }

    if (action === "logout") {
      const token = req.headers.get("Authorization")?.split(" ")[1];
      if (token) { const st = await openTbl("_sessions"); if (st) await st.delete(`token = '${token}'`); }
      return ok({});
    }

    if (action === "update") {
      const user = await getUser(req);
      if (!user) return err("Not authenticated", 401);
      const existing = await getRows("_users", `id = '${user.id}'`);
      const u = existing[0];
      if (!u) return err("User not found", 404);
      const ut = (await openTbl("_users"))!;
      await ut.delete(`id = '${u.id}'`);
      const now = new Date().toISOString();
      const merged = {
        ...u,
        email: B.email ? B.email.toLowerCase() : u.email,
        pw: B.password ? await Bun.password.hash(B.password) : u.pw,
        meta: JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...(B.data || {}) }),
        app_meta: JSON.stringify({ ...JSON.parse(u.app_meta || "{}"), ...(B.app_metadata || {}) }),
        updated: now,
      };
      await ut.add([merged]);
      return ok({ user: makeUser(merged) });
    }
  }

  if (pathname.startsWith("/rest/v1/")) {
    const table = pathname.slice(9).split("/").map(decodeURIComponent).filter(Boolean)[0];
    if (!table) return err("Table required");
    if (!validId(table)) return err("Invalid table name");

    if (req.method === "GET") {
      if (P.vec) {
        const t = await openTbl(table);
        if (!t) return ok([]);
        const limit = P.limit ? parseInt(P.limit) : 10;
        const filter = toFilter(P);
        try {
          let q = t.search(JSON.parse(P.vec) as number[]).limit(limit);
          q = q.filter(filter ? `(${real()}) AND (${filter})` : real());
          return ok(clean(await q.execute() as any[]));
        } catch { return err("Invalid vector", 400); }
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
      const page = clean(rows).slice(offset, offset + limit);
      const extra: Record<string, string> = {};
      if (P.count === "exact" || prefer.includes("count=exact")) {
        extra["Content-Range"] = `${offset}-${offset + page.length - 1}/${rows.length}`;
        return json({ data: page, error: null, count: rows.length }, 200, extra);
      }
      extra["Content-Range"] = `${offset}-${offset + page.length - 1}/*`;
      return ok(page, 200, extra);
    }

    if (req.method === "POST") {
      const rows = Array.isArray(B) ? B : [B];
      if (!rows.length || !Object.keys(rows[0]).length) return err("Empty body");
      if (Object.keys(rows[0]).some(k => k !== "vector" && !validId(k))) return err("Invalid column name");
      const prepared = rows.map(r => ({ id: r.id ?? crypto.randomUUID(), ...r, vector: r.vector ?? Z }));
      let t = await openTbl(table);
      if (!t) t = await mkTbl(table, prepared);
      else await t.add(prepared);
      if (returnMinimal) return new Response(null, { status: 204, headers: cors });
      return ok(clean(prepared), 201);
    }

    if (req.method === "PUT" || req.method === "PATCH") {
      const filter = toFilter(P);
      if (!filter) return err("No filter provided");
      const t = await openTbl(table);
      if (!t) return err("Table not found", 404);
      const data = Array.isArray(B) ? B[0] : B;
      const existing = await getRows(table, filter);
      if (!existing.length) return ok([]);
      await t.delete(`(${real()}) AND (${filter})`);
      const updated = existing.map(r => ({ ...r, ...data, vector: r.vector ?? Z }));
      await t.add(updated);
      if (returnMinimal) return new Response(null, { status: 204, headers: cors });
      return ok(clean(updated));
    }

    if (req.method === "DELETE") {
      const filter = toFilter(P);
      if (!filter) return err("No filter provided");
      const t = await openTbl(table);
      if (!t) return err("Table not found", 404);
      await t.delete(`(${real()}) AND (${filter})`);
      if (returnMinimal) return new Response(null, { status: 204, headers: cors });
      return ok([]);
    }
  }

  if (pathname === "/" || pathname === "/gui") {
    const file = Bun.file(new URL("./gui.html", import.meta.url));
    if (await file.exists()) return new Response(file, { headers: { "Content-Type": "text/html", ...cors } });
    return err("GUI not found", 404);
  }

  return err("Not found", 404);
}});

console.log(`🚀 BusyBase: http://localhost:${PORT}`);
