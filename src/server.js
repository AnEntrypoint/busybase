// @bun
// src/hooks.ts
var smtpHost = process.env.BUSYBASE_SMTP_HOST;
var smtpPort = parseInt(process.env.BUSYBASE_SMTP_PORT || "587");
var smtpUser = process.env.BUSYBASE_SMTP_USER || "";
var smtpPass = process.env.BUSYBASE_SMTP_PASS || "";
var smtpFrom = process.env.BUSYBASE_SMTP_FROM || smtpUser;
var b64e = (s) => Buffer.from(s).toString("base64");
var smtpSend = async (to, subject, html) => {
  if (!smtpHost)
    return false;
  let buffer = "";
  let notify = null;
  const useTls = smtpPort === 465;
  const isTerminalReplyLine = (line) => !!line && /^\d{3} /.test(line);
  const isMultiLineReplyComplete = (buf) => {
    const lines = buf.split(`\r
`).filter(Boolean);
    return isTerminalReplyLine(lines[lines.length - 1]);
  };
  const conn = await Bun.connect({
    hostname: smtpHost,
    port: smtpPort,
    tls: useTls,
    socket: {
      open() {},
      data(_s, d) {
        buffer += d.toString();
        if (isMultiLineReplyComplete(buffer))
          notify?.();
      },
      error(_s, e) {
        console.error("[SMTP]", e);
      },
      close() {}
    }
  });
  const send = (l) => conn.write(l + `\r
`);
  const wait = (label) => new Promise((resolve, reject) => {
    buffer = "";
    notify = () => resolve(buffer.split(`\r
`).filter(Boolean));
    setTimeout(() => reject(new Error(`SMTP ${label} timed out waiting for a complete reply: ${JSON.stringify(buffer)}`)), 15000);
  });
  const expectOk = async (label) => {
    const lines = await wait(label);
    const code = parseInt(lines[lines.length - 1]?.slice(0, 3) || "0");
    if (code >= 400 || code === 0)
      throw new Error(`SMTP ${label} failed: ${lines.join(" ") || "no response"}`);
  };
  try {
    await expectOk("connect");
    send("EHLO busybase");
    await expectOk("EHLO");
    send("AUTH LOGIN");
    await expectOk("AUTH LOGIN");
    send(b64e(smtpUser));
    await expectOk("AUTH username");
    send(b64e(smtpPass));
    await expectOk("AUTH password");
    send(`MAIL FROM:<${smtpFrom}>`);
    await expectOk("MAIL FROM");
    send(`RCPT TO:<${to}>`);
    await expectOk("RCPT TO");
    send("DATA");
    await expectOk("DATA");
    send(`From: ${smtpFrom}\r
To: ${to}\r
Subject: ${subject}\r
MIME-Version: 1.0\r
Content-Type: text/html; charset=utf-8\r
\r
${html}\r
.`);
    await expectOk("message body");
    send("QUIT");
  } finally {
    conn.end();
  }
  return true;
};
var hooksFile = process.env.BUSYBASE_HOOKS;
var userHooks = {};
if (hooksFile) {
  try {
    userHooks = await (hooksFile.startsWith(".") ? import(Bun.resolveSync(hooksFile, process.cwd())) : import(hooksFile));
    console.log(`[BusyBase] Hooks loaded: ${hooksFile}`);
  } catch (e) {
    console.warn(`[BusyBase] Could not load hooks file: ${hooksFile}`, e);
  }
}
var hooks = userHooks;
var fireHookOn = async (h, name, ...args) => {
  const fn = h[name];
  if (!fn)
    return null;
  try {
    const r = await fn(...args);
    if (r === false)
      return "Access denied";
    if (r && typeof r === "object" && typeof r.error === "string")
      return r.error;
  } catch (e) {
    console.error(`[BusyBase] Hook "${String(name)}" threw:`, e);
    return "Internal error";
  }
  return null;
};
var pipeHookOn = async (h, name, value, ...args) => {
  const fn = h[name];
  if (!fn)
    return value;
  try {
    const r = await fn(value, ...args);
    if (r && typeof r === "object" && !r.error)
      return r;
  } catch {}
  return value;
};
var fireHook = (name, ...args) => fireHookOn(hooks, name, ...args);
var pipeHook = (name, value, ...args) => pipeHookOn(hooks, name, value, ...args);
var sendEmailOn = async (h, to, subject, html, text = "") => {
  if (h.sendEmail) {
    await h.sendEmail({ to, subject, html, text });
    return;
  }
  try {
    const sent = await smtpSend(to, subject, html);
    if (!sent)
      console.log(`[BusyBase] No email transport configured. Would send to ${to}: ${subject}`);
  } catch (e) {
    console.error(`[BusyBase] Failed to send email to ${to}:`, e);
  }
};
var sendEmail = (to, subject, html, text = "") => sendEmailOn(hooks, to, subject, html, text);

// src/db.ts
import { createClient } from "@libsql/client";
import { mkdirSync } from "fs";
var DIR = process.env.BUSYBASE_DIR || "busybase_data";
var CORS_ORIGIN = process.env.BUSYBASE_CORS_ORIGIN || "*";
var cors = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer"
};
var json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...cors, ...extra } });
var ok = (data, status = 200, extra = {}) => json({ data, error: null }, status, extra);
var err = (msg, code = 400, hint = "") => json({ data: null, error: { message: msg, hint, code } }, code);
var esc = (s) => String(s).replace(/'/g, "''");
var validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";
var openClient = (dir) => {
  mkdirSync(dir, { recursive: true });
  return createClient({ url: `file:${dir}/db.sqlite` });
};
var initAuthTablesFor = async (client) => {
  await client.execute(`CREATE TABLE IF NOT EXISTS _users (
    id TEXT, email TEXT, pw TEXT, pubkey TEXT, role TEXT,
    meta TEXT, app_meta TEXT, created TEXT, updated TEXT, last_sign_in TEXT
  )`);
  await client.execute(`CREATE TABLE IF NOT EXISTS _sessions (token TEXT, refresh TEXT, uid TEXT, exp INTEGER)`);
};
var tableExistsIn = async (client, name) => {
  const r = await client.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [name] });
  return r.rows.length > 0;
};
var openTblIn = async (client, name) => await tableExistsIn(client, name) ? name : null;
var mkTblIn = async (client, name, row) => {
  const cols = Object.keys(row).map((k) => `${k} TEXT`).join(", ");
  await client.execute(`CREATE TABLE IF NOT EXISTS ${name} (${cols})`);
  return name;
};
var getTableColumnsIn = async (client, name) => {
  const info = await client.execute(`PRAGMA table_info(${name})`);
  return new Set(info.rows.map((r) => r.name));
};
var ensureColsIn = async (client, name, row) => {
  const existing = await getTableColumnsIn(client, name);
  for (const k of Object.keys(row)) {
    if (!existing.has(k))
      await client.execute(`ALTER TABLE ${name} ADD COLUMN ${k} TEXT`).catch(() => {});
  }
};
var tableLocksByClient = new WeakMap;
var ensureTableIn = async (client, name, row) => {
  let locks = tableLocksByClient.get(client);
  if (!locks) {
    locks = new Map;
    tableLocksByClient.set(client, locks);
  }
  const prior = locks.get(name) || Promise.resolve();
  const next = prior.then(async () => {
    if (!await tableExistsIn(client, name))
      await mkTblIn(client, name, row);
    else
      await ensureColsIn(client, name, row);
  });
  locks.set(name, next.catch(() => {}));
  await next;
};
var toCell = (v) => v == null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
var dbInsertIn = async (client, name, row) => {
  const keys = Object.keys(row);
  const ph = keys.map(() => "?").join(", ");
  const vals = keys.map((k) => toCell(row[k]));
  await client.execute({ sql: `INSERT INTO ${name} (${keys.join(", ")}) VALUES (${ph})`, args: vals });
};
var MAX_ROWS_FETCHED = 50000;
var getRowsIn = async (client, name, where) => {
  if (!await tableExistsIn(client, name))
    return [];
  const r = await client.execute(`SELECT * FROM ${name} WHERE ${where} LIMIT ${MAX_ROWS_FETCHED}`);
  return r.rows.map((row) => ({ ...row }));
};
var getAllRowsIn = async (client, name) => {
  if (!await tableExistsIn(client, name))
    return [];
  const r = await client.execute(`SELECT * FROM ${name} LIMIT ${MAX_ROWS_FETCHED}`);
  return r.rows.map((row) => ({ ...row }));
};
var dbUpdateIn = async (client, name, data, where) => {
  const keys = Object.keys(data).filter((k) => k !== "id");
  if (!keys.length)
    return;
  const sets = keys.map((k) => `${k}=?`).join(", ");
  const vals = keys.map((k) => toCell(data[k]));
  await client.execute({ sql: `UPDATE ${name} SET ${sets} WHERE ${where}`, args: vals });
};
var dbDeleteIn = async (client, name, where) => {
  await client.execute(`DELETE FROM ${name} WHERE ${where}`);
};
var tableNamesIn = async (client) => {
  const r = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return r.rows.map((row) => row.name);
};
var clean = (rows) => rows.map(({ pw, pubkey: _pk, ...r }) => r);
var makeRateLimiter = (windowMs, max) => {
  const buckets = new Map;
  const limited = (key) => {
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    hits.push(now);
    buckets.set(key, hits);
    return hits.length > max;
  };
  const sweep = () => {
    const now = Date.now();
    for (const [k, hits] of buckets) {
      const fresh = hits.filter((t) => now - t < windowMs);
      if (fresh.length)
        buckets.set(k, fresh);
      else
        buckets.delete(k);
    }
  };
  return { limited, sweep };
};
var cosineDistance = (a, b) => {
  if (a.length !== b.length || !a.length)
    return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0;i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0)
    return null;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
};
var parseVector = (v) => {
  if (typeof v !== "string" || !v)
    return null;
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) && arr.every((n) => typeof n === "number") ? arr : null;
  } catch {
    return null;
  }
};
var vecSearch = (rows, embedding, limit) => {
  const scored = [];
  for (const row of rows) {
    const rowVec = parseVector(row.vector);
    if (!rowVec)
      continue;
    const dist = cosineDistance(embedding, rowVec);
    if (dist === null)
      continue;
    scored.push({ row: { ...row, _distance: dist }, dist });
  }
  scored.sort((x, y) => x.dist - y.dist);
  return scored.slice(0, limit).map((s) => s.row);
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
var hashToken = async (token) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
};
var timingSafeEqual = (a, b) => {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0;i < a.length; i++)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
var issueSessionIn = async (client, uid) => {
  const token = crypto.randomUUID(), refresh = crypto.randomUUID();
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const tokenHash = await hashToken(token), refreshHash = await hashToken(refresh);
  await client.execute({ sql: "INSERT INTO _sessions (token, refresh, uid, exp) VALUES (?, ?, ?, ?)", args: [tokenHash, refreshHash, uid, exp] });
  return { token, refresh, exp };
};
var findSessionByTokenIn = async (client, token) => {
  const tokenHash = await hashToken(token);
  const sessions = await client.execute({ sql: "SELECT * FROM _sessions WHERE token=? AND exp>?", args: [tokenHash, Date.now()] });
  const s = sessions.rows[0];
  if (!s || !timingSafeEqual(String(s.token), tokenHash))
    return null;
  return s;
};
var deleteSessionByTokenIn = async (client, token) => {
  const tokenHash = await hashToken(token);
  await client.execute({ sql: "DELETE FROM _sessions WHERE token=?", args: [tokenHash] });
};
var getUserFromRequestIn = async (client, r) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token)
    return null;
  const s = await findSessionByTokenIn(client, token);
  if (!s)
    return null;
  const users = await getRowsIn(client, "_users", `id = '${esc(s.uid)}'`);
  return users[0] ? makeUser(users[0]) : null;
};
var sweepExpiredIn = async (client) => {
  await client.execute({ sql: "DELETE FROM _sessions WHERE exp < ?", args: [Date.now()] }).catch(() => {});
};
var cmpExpr = (col, s, v) => {
  if ((s === ">" || s === ">=" || s === "<" || s === "<=") && v !== "" && Number.isFinite(Number(v))) {
    return `CAST(${col} AS REAL) ${s} ${Number(v)}`;
  }
  return `${col} ${s} '${v}'`;
};
var toFilter = (p) => {
  const skip = new Set(["select", "order", "limit", "offset", "vec", "count"]);
  const parts = [];
  for (const [k, val] of Object.entries(p)) {
    if (skip.has(k))
      continue;
    if (k.startsWith("in.")) {
      const col2 = k.slice(3);
      if (!validId(col2))
        continue;
      const list = val.split(",").map((v) => `'${esc(v)}'`).join(",");
      parts.push(`${col2} IN (${list})`);
      continue;
    }
    if (k === "or") {
      const orParts = decodeURIComponent(val).split(",").map((clause) => {
        const d1 = clause.indexOf("."), d2 = clause.indexOf(".", d1 + 1);
        if (d1 < 0 || d2 < 0)
          return null;
        const col2 = clause.slice(0, d1), op2 = clause.slice(d1 + 1, d2), v = esc(clause.slice(d2 + 1));
        if (!validId(col2))
          return null;
        const s = op2 === "eq" ? "=" : op2 === "neq" ? "!=" : op2 === "gt" ? ">" : op2 === "gte" ? ">=" : op2 === "lt" ? "<" : op2 === "lte" ? "<=" : null;
        return s ? cmpExpr(col2, s, v) : null;
      }).filter(Boolean);
      if (orParts.length)
        parts.push(`(${orParts.join(" OR ")})`);
      continue;
    }
    if (k.startsWith("not.")) {
      const rest = k.slice(4), dot = rest.indexOf(".");
      const col2 = dot >= 0 ? rest.slice(0, dot) : rest, op2 = dot >= 0 ? rest.slice(dot + 1) : "eq";
      if (!validId(col2))
        continue;
      const s = op2 === "eq" ? "=" : op2 === "neq" ? "!=" : op2 === "gt" ? ">" : op2 === "gte" ? ">=" : op2 === "lt" ? "<" : op2 === "lte" ? "<=" : "=";
      parts.push(`NOT (${cmpExpr(col2, s, esc(val))})`);
      continue;
    }
    const op = k.match(/^(eq|neq|gt|gte|lt|lte|like|ilike|is)\./)?.[1];
    if (!op)
      continue;
    const col = k.slice(op.length + 1);
    if (!validId(col))
      continue;
    const safe = esc(val);
    if (op === "like")
      parts.push(`${col} LIKE '${safe}'`);
    else if (op === "ilike")
      parts.push(`LOWER(${col}) LIKE LOWER('${safe}')`);
    else if (op === "is") {
      const upper = val.trim().toUpperCase();
      if (!["NULL", "TRUE", "FALSE"].includes(upper))
        continue;
      parts.push(`${col} IS ${upper}`);
    } else {
      const s = op === "eq" ? "=" : op === "neq" ? "!=" : op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
      parts.push(cmpExpr(col, s, safe));
    }
  }
  return parts.join(" AND ");
};
var db = openClient(DIR);
var getAllRows = (name) => getAllRowsIn(db, name);
var tableNames = () => tableNamesIn(db);

// src/realtime.ts
var registry = new Map;
var sub = (ws, table) => {
  ws.data.tables.add(table);
  if (!registry.has(table))
    registry.set(table, new Set);
  registry.get(table).add(ws);
};
var unsub = (ws, table) => {
  ws.data.tables.delete(table);
  const subs = registry.get(table);
  if (!subs)
    return;
  subs.delete(ws);
  if (subs.size === 0)
    registry.delete(table);
};
var broadcastChange = (table, eventType, newRow, oldRow) => {
  const subs = registry.get(table);
  if (!subs?.size)
    return;
  const msg = JSON.stringify({ event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null });
  for (const ws of subs) {
    try {
      ws.send(msg);
    } catch (e) {
      console.error(`[BusyBase] Realtime send failed for table "${table}":`, e);
    }
  }
};
var wsHandlers = {
  open(ws) {
    ws.data.tables = new Set;
  },
  message(ws, raw) {
    (async () => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
        if (msg.type === "subscribe" && msg.table) {
          if (!validId(msg.table))
            return;
          if (hooks.canAccess) {
            const denied = await fireHook("canAccess", { user: ws.data.user ?? null, table: msg.table, method: "GET" });
            if (denied)
              return;
          }
          sub(ws, msg.table);
        } else if (msg.type === "unsubscribe" && msg.table)
          unsub(ws, msg.table);
      } catch {}
    })();
  },
  close(ws) {
    for (const table of [...ws.data?.tables ?? []])
      unsub(ws, table);
  }
};

// src/auth.ts
var nonces = new Map;
var resetTokens = new Map;
var authRateLimiter = makeRateLimiter(60000, 10);
var rateLimited = authRateLimiter.limited;
var importPubKey = (b64) => crypto.subtle.importKey("raw", Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);
var initAuthTables = (client = db) => initAuthTablesFor(client);
var sweepExpired = async (client = db) => {
  const now = Date.now();
  for (const [k, exp] of nonces)
    if (exp < now)
      nonces.delete(k);
  for (const [k, v] of resetTokens)
    if (v.exp < now)
      resetTokens.delete(k);
  authRateLimiter.sweep();
  await sweepExpiredIn(client);
};
var RATE_LIMITED_ACTIONS = new Set(["signup", "token", "recover", "keypair"]);
var handleAuth = async (client, action, req, B, ip = "unknown") => {
  if (RATE_LIMITED_ACTIONS.has(action) && rateLimited(`${ip}:${action}`)) {
    return err("Too many requests, please try again later", 429);
  }
  if (action === "keypair" && req.method === "GET") {
    const nonce = crypto.randomUUID();
    nonces.set(nonce, Date.now() + 60000);
    return ok({ nonce });
  }
  if (action === "keypair" && req.method === "POST") {
    const { pubkey, nonce, signature } = B;
    if (!pubkey || !nonce || !signature)
      return err("pubkey, nonce and signature required");
    const exp = nonces.get(nonce);
    if (!exp || exp < Date.now())
      return err("Invalid or expired nonce", 401);
    nonces.delete(nonce);
    let valid = false;
    try {
      const key = await importPubKey(pubkey);
      const sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
      valid = await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(nonce));
    } catch {
      return err("Invalid signature", 401);
    }
    if (!valid)
      return err("Signature verification failed", 401);
    const now = new Date().toISOString();
    let users = await getRowsIn(client, "_users", `pubkey = '${esc(pubkey)}'`);
    let u = users[0];
    if (!u) {
      u = { id: crypto.randomUUID(), email: "", pw: "", pubkey, role: "authenticated", meta: "{}", app_meta: "{}", created: now, updated: now, last_sign_in: now };
      await dbInsertIn(client, "_users", u);
      const hookErr = await fireHook("onSignup", makeUser(u));
      if (hookErr)
        return err(hookErr, 400);
    } else {
      await dbUpdateIn(client, "_users", { last_sign_in: now, updated: now }, `id = '${esc(u.id)}'`);
      u = { ...u, last_sign_in: now, updated: now };
    }
    const { token, refresh, exp: sExp } = await issueSessionIn(client, u.id);
    const user = makeUser(u);
    await fireHook("onSignin", user);
    return ok({ user, session: makeSession(token, refresh, sExp, user) });
  }
  if (action === "signup") {
    if (!B.email || !B.password)
      return err("Email & password required");
    const emailLower = B.email.toLowerCase();
    if ((await getRowsIn(client, "_users", `email = '${esc(emailLower)}'`)).length)
      return err("User already registered", 400, "Check if user already exists");
    const now = new Date().toISOString();
    const u = { id: crypto.randomUUID(), email: emailLower, pw: await Bun.password.hash(B.password), pubkey: "", role: "authenticated", meta: JSON.stringify(B.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now };
    await dbInsertIn(client, "_users", u);
    const signupHookErr = await fireHook("onSignup", makeUser(u));
    if (signupHookErr)
      return err(signupHookErr, 400);
    return ok({ user: makeUser(u), session: null });
  }
  if (action === "token") {
    const emailLower = (B.email || "").toLowerCase();
    const users = await getRowsIn(client, "_users", `email = '${esc(emailLower)}'`);
    const u = users[0];
    if (!u || !await Bun.password.verify(B.password || "", u.pw))
      return err("Invalid login credentials", 400);
    const now = new Date().toISOString();
    await dbUpdateIn(client, "_users", { last_sign_in: now, updated: now }, `id = '${esc(u.id)}'`);
    const { token, refresh, exp } = await issueSessionIn(client, u.id);
    const user = makeUser({ ...u, last_sign_in: now, updated: now });
    await fireHook("onSignin", user);
    return ok({ user, session: makeSession(token, refresh, exp, user) });
  }
  if (action === "user") {
    const user = await getUserFromRequestIn(client, req);
    if (!user)
      return err("Not authenticated", 401);
    return ok({ user });
  }
  if (action === "update") {
    const user = await getUserFromRequestIn(client, req);
    if (!user)
      return err("Not authenticated", 401);
    const existing = await getRowsIn(client, "_users", `id = '${esc(user.id)}'`);
    const u = existing[0];
    if (!u)
      return err("User not found", 404);
    const now = new Date().toISOString();
    const newEmail = B.email ? B.email.toLowerCase() : u.email;
    if (B.email && newEmail !== u.email) {
      const taken = await getRowsIn(client, "_users", `email = '${esc(newEmail)}'`);
      if (taken.length)
        return err("Email already in use", 400);
      const emailHookErr = await fireHook("onEmailChange", makeUser(u), newEmail);
      if (emailHookErr)
        return err(emailHookErr, 400);
    }
    const merged = { email: newEmail, pw: B.password ? await Bun.password.hash(B.password) : u.pw, meta: JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...B.data || {} }), app_meta: JSON.stringify({ ...JSON.parse(u.app_meta || "{}"), ...B.app_metadata || {} }), updated: now };
    await dbUpdateIn(client, "_users", merged, `id = '${esc(u.id)}'`);
    return ok({ user: makeUser({ ...u, ...merged }) });
  }
  if (action === "logout") {
    const token = req.headers.get("Authorization")?.split(" ")[1];
    if (token)
      await deleteSessionByTokenIn(client, token).catch(() => {});
    return ok({});
  }
  if (action === "recover") {
    const email = (B.email || "").toLowerCase();
    if (!email)
      return err("Email required");
    const users = await getRowsIn(client, "_users", `email = '${esc(email)}'`);
    if (users[0]) {
      const resetToken = crypto.randomUUID();
      resetTokens.set(resetToken, { uid: users[0].id, exp: Date.now() + 60 * 60000 });
      await fireHook("onPasswordReset", email, resetToken);
      if (!hooks.onPasswordReset) {
        const siteUrl = process.env.BUSYBASE_URL || `http://localhost:${process.env.BUSYBASE_PORT || 54321}`;
        await sendEmail(email, "Reset your password", `<p>Click <a href="${siteUrl}/auth/v1/verify?token=${resetToken}&type=recovery">here</a> to reset your password. This link expires in 1 hour.</p>`);
      }
    } else {
      await hashToken(crypto.randomUUID());
    }
    return ok({});
  }
  if (action === "verify") {
    const token = B.token ?? new URL(req.url).searchParams.get("token");
    const type = B.type ?? new URL(req.url).searchParams.get("type");
    const password = B.password;
    if (type === "recovery" && token) {
      const entry = resetTokens.get(token);
      if (!entry || entry.exp < Date.now())
        return err("Invalid or expired token", 401);
      if (!password)
        return err("New password required");
      resetTokens.delete(token);
      const users = await getRowsIn(client, "_users", `id = '${esc(entry.uid)}'`);
      const u = users[0];
      if (!u)
        return err("User not found", 404);
      const now = new Date().toISOString();
      await dbUpdateIn(client, "_users", { pw: await Bun.password.hash(password), updated: now }, `id = '${esc(u.id)}'`);
      const { token: access, refresh, exp } = await issueSessionIn(client, u.id);
      return ok({ user: makeUser({ ...u, updated: now }), session: makeSession(access, refresh, exp, makeUser({ ...u, updated: now })) });
    }
    return err("Invalid verification type", 400);
  }
  return null;
};
var handleAuthDefault = (action, req, B, ip = "unknown") => handleAuth(db, action, req, B, ip);

// src/rest.ts
var restRateLimiter = makeRateLimiter(60000, 300);
var handleRest = async (client, table, req, P, B, broadcast = broadcastChange, ip = "unknown") => {
  if (!validId(table))
    return err("Invalid table name");
  const isMutating = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  if (isMutating && restRateLimiter.limited(ip))
    return err("Too many requests, please try again later", 429);
  if (hooks.canAccess) {
    const reqUser = await getUserFromRequestIn(client, req).catch(() => null);
    const denied = await fireHook("canAccess", { user: reqUser, table, method: req.method });
    if (denied)
      return err(denied, 403);
  }
  const prefer = req.headers.get("Prefer") || "";
  const returnMinimal = prefer.includes("return=minimal");
  if (req.method === "GET") {
    const paramsHooked = await pipeHook("beforeSelect", P, table);
    const filter = toFilter(paramsHooked);
    let rows = filter ? await getRowsIn(client, table, filter) : await getAllRowsIn(client, table);
    rows = await pipeHook("afterSelect", rows, table);
    let isVecSearch = false;
    if (paramsHooked.vec) {
      let embedding;
      try {
        embedding = JSON.parse(paramsHooked.vec);
      } catch {
        return err("Invalid vec: must be a JSON array of numbers");
      }
      if (!Array.isArray(embedding) || !embedding.every((n) => typeof n === "number"))
        return err("Invalid vec: must be a JSON array of numbers");
      isVecSearch = true;
      rows = vecSearch(rows, embedding, Math.max(0, parseInt(paramsHooked.limit) || 10));
    }
    let knownCols = rows.length ? new Set(Object.keys(rows[0])) : null;
    if (!knownCols && (paramsHooked.select && paramsHooked.select !== "*" || paramsHooked.order) && await tableExistsIn(client, table)) {
      knownCols = await getTableColumnsIn(client, table);
    }
    if (paramsHooked.select && paramsHooked.select !== "*") {
      const requested = paramsHooked.select.split(",");
      const invalidSyntax = requested.filter((c) => !validId(c) && c !== "_distance");
      if (invalidSyntax.length)
        return err(`Invalid column name in select: ${invalidSyntax.join(", ")}`);
      const unknown = knownCols ? requested.filter((c) => !knownCols.has(c) && c !== "_distance") : [];
      if (unknown.length)
        return err(`Unknown column in select: ${unknown.join(", ")}`);
      rows = rows.map((r) => Object.fromEntries(requested.map((c) => [c, r[c]])));
    }
    if (paramsHooked.order) {
      const [col, dir] = paramsHooked.order.split(".");
      if (!validId(col) && col !== "_distance")
        return err(`Invalid column name in order: ${col}`);
      if (knownCols && !knownCols.has(col) && col !== "_distance")
        return err(`Unknown column in order: ${col}`);
      const numCmp = (x, y) => {
        const nx = Number(x), ny = Number(y);
        if (x !== "" && x != null && y !== "" && y != null && Number.isFinite(nx) && Number.isFinite(ny))
          return nx - ny;
        return x > y ? 1 : x < y ? -1 : 0;
      };
      rows.sort((a, b) => dir === "desc" ? numCmp(b[col], a[col]) : numCmp(a[col], b[col]));
    }
    const limit = isVecSearch ? rows.length : Math.max(0, parseInt(paramsHooked.limit) || 1000);
    const offset = isVecSearch ? 0 : Math.max(0, parseInt(paramsHooked.offset) || 0);
    const page = clean(rows).slice(offset, offset + limit);
    const rangeEnd = page.length ? offset + page.length - 1 : 0;
    const extra = {};
    if (paramsHooked.count === "exact" || prefer.includes("count=exact")) {
      extra["Content-Range"] = page.length ? `${offset}-${rangeEnd}/${rows.length}` : `*`;
      return Response.json({ data: page, error: null, count: rows.length }, { status: 200, headers: { ...cors, ...extra } });
    }
    extra["Content-Range"] = page.length ? `${offset}-${rangeEnd}/*` : `*`;
    return ok(page, 200, extra);
  }
  if (req.method === "POST") {
    let rows = Array.isArray(B) ? B : [B];
    if (!rows.length || !Object.keys(rows[0]).length)
      return err("Empty body");
    if (Object.keys(rows[0]).some((k) => !validId(k)))
      return err("Invalid column name");
    const preErr = await fireHook("beforeInsert", table, rows);
    if (preErr)
      return err(preErr, 400);
    rows = await pipeHook("afterInsert", rows.map((r) => ({ id: r.id ?? crypto.randomUUID(), ...r })), table);
    await ensureTableIn(client, table, rows[0]);
    for (const row of rows)
      await dbInsertIn(client, table, row);
    for (const row of clean(rows))
      broadcast(table, "INSERT", row, null);
    if (returnMinimal)
      return new Response(null, { status: 204, headers: cors });
    return ok(clean(rows), 201);
  }
  if (req.method === "PUT" || req.method === "PATCH") {
    const filter = toFilter(P);
    if (!filter)
      return err("No filter provided");
    if (!await openTblIn(client, table))
      return err("Table not found", 404);
    if (Array.isArray(B))
      return err("Array body not supported for PUT/PATCH; update rows individually or by id");
    const data = B;
    let existing = await getRowsIn(client, table, filter);
    if (!existing.length)
      return ok([]);
    const preErr = await fireHook("beforeUpdate", table, existing, data);
    if (preErr)
      return err(preErr, 400);
    await dbUpdateIn(client, table, data, filter);
    let updated = existing.map((r) => ({ ...r, ...data }));
    updated = await pipeHook("afterUpdate", updated, table);
    for (let i = 0;i < updated.length; i++)
      broadcast(table, "UPDATE", clean([updated[i]])[0], clean([existing[i]])[0]);
    if (returnMinimal)
      return new Response(null, { status: 204, headers: cors });
    return ok(clean(updated));
  }
  if (req.method === "DELETE") {
    const filter = toFilter(P);
    if (!filter)
      return err("No filter provided");
    if (!await openTblIn(client, table))
      return err("Table not found", 404);
    const toDelete = await getRowsIn(client, table, filter);
    const preErr = await fireHook("beforeDelete", table, toDelete);
    if (preErr)
      return err(preErr, 400);
    await dbDeleteIn(client, table, filter);
    await fireHook("afterDelete", table, toDelete);
    for (const row of clean(toDelete))
      broadcast(table, "DELETE", null, row);
    if (returnMinimal)
      return new Response(null, { status: 204, headers: cors });
    return ok([]);
  }
  return err("Method not allowed", 405);
};
var handleRestDefault = (table, req, P, B, ip = "unknown") => handleRest(db, table, req, P, B, broadcastChange, ip);

// src/server.ts
var PORT = process.env.BUSYBASE_PORT || 54321;
var HOST = process.env.BUSYBASE_HOST || "127.0.0.1";
var UNIX_SOCKET = process.env.BUSYBASE_UNIX_SOCKET || null;
var STUDIO_TOKEN = process.env.BUSYBASE_STUDIO_TOKEN;
var MAX_REQUEST_BODY_SIZE = parseInt(process.env.BUSYBASE_MAX_BODY_SIZE || "") || 10 * 1024 * 1024;
if (!process.env.BUSYBASE_CORS_ORIGIN && false) {}
await initAuthTables();
setInterval(() => sweepExpired(), 5 * 60000).unref();
setInterval(() => restRateLimiter.sweep(), 5 * 60000).unref();
var mime = {
  ".js": "text/javascript",
  ".html": "text/html",
  ".css": "text/css"
};
var ext = (p) => p.slice(p.lastIndexOf(".")) || "";
var studioAuthorized = (req, searchParams) => {
  if (!STUDIO_TOKEN)
    return true;
  const bearer = req.headers.get("Authorization")?.split(" ")[1];
  const qtoken = searchParams.get("token");
  return bearer === STUDIO_TOKEN || qtoken === STUDIO_TOKEN;
};
var server = Bun.serve({
  ...UNIX_SOCKET ? { unix: UNIX_SOCKET } : { hostname: HOST, port: PORT },
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
  websocket: wsHandlers,
  fetch: async (req) => {
    if (req.headers.get("upgrade") === "websocket" && new URL(req.url).pathname === "/realtime/v1/websocket") {
      const wsToken = req.headers.get("Authorization")?.split(" ")[1] || new URL(req.url).searchParams.get("token");
      const wsUser = wsToken ? await getUserFromRequestIn(db, new Request(req.url, { headers: { Authorization: `Bearer ${wsToken}` } })).catch(() => null) : null;
      const upgraded = server.upgrade(req, { data: { tables: new Set, user: wsUser } });
      return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors });
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/healthz")
      return Response.json({ status: "ok" }, { headers: cors });
    if (hooks.onRequest) {
      const r = await hooks.onRequest(req);
      if (r)
        return r;
    }
    const P = Object.fromEntries(searchParams);
    const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
    const B = hasBody ? await req.json().catch(() => ({})) : {};
    if (pathname.startsWith("/auth/v1/")) {
      const action = pathname.split("/")[3];
      const ip = server.requestIP(req)?.address || "unknown";
      const result = await handleAuthDefault(action, req, B, ip);
      return result ?? err("Not found", 404);
    }
    if (pathname.startsWith("/rest/v1/")) {
      const table = pathname.slice(9).split("/").map(decodeURIComponent).filter(Boolean)[0];
      if (!table)
        return err("Table required");
      const ip = server.requestIP(req)?.address || "unknown";
      return handleRestDefault(table, req, P, B, ip);
    }
    if (pathname === "/studio" || pathname === "/studio/" || pathname.startsWith("/studio/")) {
      if (!studioAuthorized(req, searchParams))
        return err("Studio access requires a valid token", 401);
    }
    if (pathname === "/studio/config") {
      const data = {
        BUSYBASE_DIR: process.env.BUSYBASE_DIR || "busybase_data",
        BUSYBASE_PORT: String(PORT),
        BUSYBASE_CORS_ORIGIN: process.env.BUSYBASE_CORS_ORIGIN || "*"
      };
      return Response.json({ data, error: null }, { headers: cors });
    }
    if (pathname === "/studio/api/tables") {
      const data = await tableNames();
      return Response.json({ data, error: null }, { headers: cors });
    }
    if (pathname === "/studio/api/users") {
      const rows = await getAllRows("_users");
      return Response.json({ data: clean(rows), error: null }, { headers: cors });
    }
    if (pathname === "/studio") {
      const redirectUrl = new URL(req.url);
      redirectUrl.pathname = "/studio/";
      return new Response(null, {
        status: 301,
        headers: { Location: redirectUrl.pathname + redirectUrl.search, ...cors }
      });
    }
    if (pathname === "/studio/") {
      const file = Bun.file(new URL("../studio/index.html", import.meta.url));
      if (await file.exists())
        return new Response(file, { headers: { "Content-Type": "text/html", ...cors } });
      return err("Studio not found", 404);
    }
    if (pathname.startsWith("/studio/")) {
      const name = pathname.slice(8);
      if (name && !name.includes("..")) {
        const file = Bun.file(new URL(`../studio/${name}`, import.meta.url));
        if (await file.exists())
          return new Response(file, {
            headers: { "Content-Type": mime[ext(name)] || "application/octet-stream", ...cors }
          });
      }
      return err("Not found", 404);
    }
    const staticRoutes = {
      "/": "./gui.html",
      "/gui": "./gui.html",
      "/docs": "../docs/docs.html",
      "/site": "../docs/index.html"
    };
    if (pathname in staticRoutes) {
      const file = Bun.file(new URL(staticRoutes[pathname], import.meta.url));
      if (await file.exists())
        return new Response(file, { headers: { "Content-Type": "text/html", ...cors } });
      return err("Not found", 404);
    }
    return err("Not found", 404);
  }
});
console.log(`BusyBase: http://localhost:${PORT}  |  Studio: http://localhost:${PORT}/studio`);
var shuttingDown = false;
var shutdown = (signal) => {
  if (shuttingDown)
    return;
  shuttingDown = true;
  console.log(`[BusyBase] Received ${signal}, shutting down gracefully...`);
  server.stop();
  db.close();
  process.exit(0);
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
