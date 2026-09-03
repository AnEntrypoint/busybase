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
  const lines = [];
  let notify = null;
  const conn = await Bun.connect({
    hostname: smtpHost,
    port: smtpPort,
    socket: {
      open() {},
      data(_s, d) {
        lines.push(...d.toString().split(`\r
`).filter(Boolean));
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
  const wait = () => new Promise((r) => {
    notify = r;
    setTimeout(r, 3000);
  });
  try {
    await wait();
    send("EHLO busybase");
    await wait();
    send("AUTH LOGIN");
    await wait();
    send(b64e(smtpUser));
    await wait();
    send(b64e(smtpPass));
    await wait();
    send(`MAIL FROM:<${smtpFrom}>`);
    await wait();
    send(`RCPT TO:<${to}>`);
    await wait();
    send("DATA");
    await wait();
    send(`From: ${smtpFrom}\r
To: ${to}\r
Subject: ${subject}\r
MIME-Version: 1.0\r
Content-Type: text/html; charset=utf-8\r
\r
${html}\r
.`);
    await wait();
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
var fireHook = async (name, ...args) => {
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
var pipeHook = async (name, value, ...args) => {
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
var sendEmail = async (to, subject, html, text = "") => {
  if (hooks.sendEmail) {
    await hooks.sendEmail({ to, subject, html, text });
    return;
  }
  const sent = await smtpSend(to, subject, html);
  if (!sent)
    console.log(`[BusyBase] No email transport configured. Would send to ${to}: ${subject}`);
};

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
  registry.get(table)?.delete(ws);
};
var broadcastChange = (table, eventType, newRow, oldRow) => {
  const subs = registry.get(table);
  if (!subs?.size)
    return;
  const msg = JSON.stringify({ event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null });
  for (const ws of subs) {
    try {
      ws.send(msg);
    } catch {}
  }
};
var wsHandlers = {
  open(ws) {
    ws.data = { tables: new Set };
  },
  message(ws, raw) {
    try {
      const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      if (msg.type === "subscribe" && msg.table)
        sub(ws, msg.table);
      else if (msg.type === "unsubscribe" && msg.table)
        unsub(ws, msg.table);
    } catch {}
  },
  close(ws) {
    for (const table of ws.data?.tables ?? [])
      registry.get(table)?.delete(ws);
  }
};

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
var esc = (s) => String(s).replace(/\0/g, "").replace(/'/g, "''");
var validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions";
mkdirSync(DIR, { recursive: true });
var db = createClient({ url: `file:${DIR}/db.sqlite` });
var tableExists = async (name) => {
  const r = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [name] });
  return r.rows.length > 0;
};
var openTbl = async (name) => await tableExists(name) ? name : null;
var mkTbl = async (name, row) => {
  const cols = Object.keys(row).map((k) => `${k} TEXT`).join(", ");
  await db.execute(`CREATE TABLE IF NOT EXISTS ${name} (${cols})`);
  return name;
};
var ensureCols = async (name, row) => {
  const info = await db.execute(`PRAGMA table_info(${name})`);
  const existing = new Set(info.rows.map((r) => r.name));
  for (const k of Object.keys(row)) {
    if (!existing.has(k))
      await db.execute(`ALTER TABLE ${name} ADD COLUMN ${k} TEXT`);
  }
};
var dbInsert = async (name, row) => {
  const keys = Object.keys(row);
  const ph = keys.map(() => "?").join(", ");
  const vals = keys.map((k) => row[k] == null ? null : String(row[k]));
  await db.execute({ sql: `INSERT INTO ${name} (${keys.join(", ")}) VALUES (${ph})`, args: vals });
};
var getRows = async (name, where) => {
  if (!await tableExists(name))
    return [];
  const r = await db.execute(`SELECT * FROM ${name} WHERE ${where}`);
  return r.rows.map((row) => ({ ...row }));
};
var getAllRows = async (name) => {
  if (!await tableExists(name))
    return [];
  const r = await db.execute(`SELECT * FROM ${name}`);
  return r.rows.map((row) => ({ ...row }));
};
var dbUpdate = async (name, data, where) => {
  const keys = Object.keys(data).filter((k) => k !== "id");
  if (!keys.length)
    return;
  const sets = keys.map((k) => `${k}=?`).join(", ");
  const vals = keys.map((k) => data[k] == null ? null : String(data[k]));
  await db.execute({ sql: `UPDATE ${name} SET ${sets} WHERE ${where}`, args: vals });
};
var dbDelete = async (name, where) => {
  await db.execute(`DELETE FROM ${name} WHERE ${where}`);
};
var tableNames = async () => {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return r.rows.map((row) => row.name);
};
var clean = (rows) => rows.map(({ pw, pubkey: _pk, ...r }) => r);
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
var issueSession = async (uid) => {
  const token = crypto.randomUUID(), refresh = crypto.randomUUID();
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await db.execute({ sql: "INSERT INTO _sessions (token, refresh, uid, exp) VALUES (?, ?, ?, ?)", args: [token, refresh, uid, exp] });
  return { token, refresh, exp };
};
var getUser = async (r) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token)
    return null;
  const sessions = await db.execute({ sql: "SELECT * FROM _sessions WHERE token=? AND exp>?", args: [token, Date.now()] });
  const s = sessions.rows[0];
  if (!s)
    return null;
  const users = await getRows("_users", `id = '${esc(s.uid)}'`);
  return users[0] ? makeUser(users[0]) : null;
};
var NUM_LIT = /^-?\d+(\.\d+)?$/;
var cmp = (col, s, val) => NUM_LIT.test(val) ? `(${col} ${s} '${esc(val)}' OR ${col} ${s} CAST('${esc(val)}' AS NUMERIC))` : `${col} ${s} '${esc(val)}'`;
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
      const list = val.split(",").flatMap((v) => NUM_LIT.test(v) ? [`'${esc(v)}'`, v] : [`'${esc(v)}'`]).join(",");
      parts.push(`${col2} IN (${list})`);
      continue;
    }
    if (k === "or") {
      const orParts = decodeURIComponent(val).split(",").map((clause) => {
        const d1 = clause.indexOf("."), d2 = clause.indexOf(".", d1 + 1);
        if (d1 < 0 || d2 < 0)
          return null;
        const col2 = clause.slice(0, d1), op2 = clause.slice(d1 + 1, d2), v = clause.slice(d2 + 1);
        if (!validId(col2))
          return null;
        const s = op2 === "eq" ? "=" : op2 === "neq" ? "!=" : op2 === "gt" ? ">" : op2 === "gte" ? ">=" : op2 === "lt" ? "<" : op2 === "lte" ? "<=" : null;
        return s ? cmp(col2, s, v) : null;
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
      parts.push(`NOT (${col2} ${s} '${esc(val)}')`);
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
      parts.push(cmp(col, s, val));
    }
  }
  return parts.join(" AND ");
};

// src/auth.ts
var nonces = new Map;
var resetTokens = new Map;
var importPubKey = (b64) => crypto.subtle.importKey("raw", Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);
var initAuthTables = async () => {
  await db.execute(`CREATE TABLE IF NOT EXISTS _users (
    id TEXT, email TEXT, pw TEXT, pubkey TEXT, role TEXT,
    meta TEXT, app_meta TEXT, created TEXT, updated TEXT, last_sign_in TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS _sessions (token TEXT, refresh TEXT, uid TEXT, exp INTEGER)`);
};
var sweepExpired = async () => {
  const now = Date.now();
  for (const [k, exp] of nonces)
    if (exp < now)
      nonces.delete(k);
  for (const [k, v] of resetTokens)
    if (v.exp < now)
      resetTokens.delete(k);
  await db.execute({ sql: "DELETE FROM _sessions WHERE exp < ?", args: [now] }).catch(() => {});
};
var handleAuth = async (action, req, B) => {
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
    let users = await getRows("_users", `pubkey = '${esc(pubkey)}'`);
    let u = users[0];
    if (!u) {
      u = { id: crypto.randomUUID(), email: "", pw: "", pubkey, role: "authenticated", meta: "{}", app_meta: "{}", created: now, updated: now, last_sign_in: now };
      await dbInsert("_users", u);
      const hookErr = await fireHook("onSignup", makeUser(u));
      if (hookErr)
        return err(hookErr, 400);
    } else {
      await dbUpdate("_users", { last_sign_in: now, updated: now }, `id = '${esc(u.id)}'`);
      u = { ...u, last_sign_in: now, updated: now };
    }
    const { token, refresh, exp: sExp } = await issueSession(u.id);
    const user = makeUser(u);
    await fireHook("onIssueSession", user);
    await fireHook("onSignin", user);
    return ok({ user, session: makeSession(token, refresh, sExp, user) });
  }
  if (action === "signup") {
    if (!B.email || !B.password)
      return err("Email & password required");
    const emailLower = B.email.toLowerCase();
    if ((await getRows("_users", `email = '${esc(emailLower)}'`)).length)
      return err("User already registered", 400, "Check if user already exists");
    const now = new Date().toISOString();
    const u = { id: crypto.randomUUID(), email: emailLower, pw: await Bun.password.hash(B.password), pubkey: "", role: "authenticated", meta: JSON.stringify(B.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now };
    await dbInsert("_users", u);
    const signupHookErr = await fireHook("onSignup", makeUser(u));
    if (signupHookErr)
      return err(signupHookErr, 400);
    return ok({ user: makeUser(u), session: null });
  }
  if (action === "token") {
    const emailLower = (B.email || "").toLowerCase();
    const users = await getRows("_users", `email = '${esc(emailLower)}'`);
    const u = users[0];
    if (!u || !await Bun.password.verify(B.password || "", u.pw))
      return err("Invalid login credentials", 400);
    const now = new Date().toISOString();
    await dbUpdate("_users", { last_sign_in: now, updated: now }, `id = '${esc(u.id)}'`);
    const { token, refresh, exp } = await issueSession(u.id);
    const user = makeUser({ ...u, last_sign_in: now, updated: now });
    await fireHook("onIssueSession", user);
    await fireHook("onSignin", user);
    return ok({ user, session: makeSession(token, refresh, exp, user) });
  }
  if (action === "user") {
    const user = await getUser(req);
    if (!user)
      return err("Not authenticated", 401);
    return ok({ user });
  }
  if (action === "update") {
    const user = await getUser(req);
    if (!user)
      return err("Not authenticated", 401);
    const existing = await getRows("_users", `id = '${esc(user.id)}'`);
    const u = existing[0];
    if (!u)
      return err("User not found", 404);
    const now = new Date().toISOString();
    const newEmail = B.email ? B.email.toLowerCase() : u.email;
    if (B.email && newEmail !== u.email) {
      const taken = await getRows("_users", `email = '${esc(newEmail)}'`);
      if (taken.length)
        return err("Email already in use", 400);
      const emailHookErr = await fireHook("onEmailChange", makeUser(u), newEmail);
      if (emailHookErr)
        return err(emailHookErr, 400);
    }
    const merged = { email: newEmail, pw: B.password ? await Bun.password.hash(B.password) : u.pw, meta: JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...B.data || {} }), app_meta: JSON.stringify({ ...JSON.parse(u.app_meta || "{}"), ...B.app_metadata || {} }), updated: now };
    await dbUpdate("_users", merged, `id = '${esc(u.id)}'`);
    await fireHook("onUserUpdate", makeUser({ ...u, ...merged }), { email: B.email, password: !!B.password, data: B.data, app_metadata: B.app_metadata });
    return ok({ user: makeUser({ ...u, ...merged }) });
  }
  if (action === "logout") {
    const user = await getUser(req);
    const token = req.headers.get("Authorization")?.split(" ")[1];
    if (token)
      await dbDelete("_sessions", `token = '${esc(token)}'`).catch(() => {});
    if (user)
      await fireHook("onSignout", user);
    return ok({});
  }
  if (action === "recover") {
    const email = (B.email || "").toLowerCase();
    if (!email)
      return err("Email required");
    const users = await getRows("_users", `email = '${esc(email)}'`);
    if (users[0]) {
      const resetToken = crypto.randomUUID();
      resetTokens.set(resetToken, { uid: users[0].id, exp: Date.now() + 60 * 60000 });
      await fireHook("onPasswordReset", email, resetToken);
      if (!hooks.onPasswordReset) {
        const siteUrl = process.env.BUSYBASE_URL || `http://localhost:${process.env.BUSYBASE_PORT || 54321}`;
        await sendEmail(email, "Reset your password", `<p>Click <a href="${siteUrl}/auth/v1/verify?token=${resetToken}&type=recovery">here</a> to reset your password. This link expires in 1 hour.</p>`);
      }
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
      const users = await getRows("_users", `id = '${esc(entry.uid)}'`);
      const u = users[0];
      if (!u)
        return err("User not found", 404);
      const now = new Date().toISOString();
      await dbUpdate("_users", { pw: await Bun.password.hash(password), updated: now }, `id = '${esc(u.id)}'`);
      const { token: access, refresh, exp } = await issueSession(u.id);
      return ok({ user: makeUser({ ...u, updated: now }), session: makeSession(access, refresh, exp, makeUser({ ...u, updated: now })) });
    }
    return err("Invalid verification type", 400);
  }
  return null;
};

// src/rest.ts
var handleRest = async (table, req, P, B) => {
  if (!validId(table))
    return err("Invalid table name");
  if (hooks.canAccess) {
    const reqUser = await getUser(req).catch(() => null);
    const denied = await fireHook("canAccess", { user: reqUser, table, method: req.method });
    if (denied)
      return err(denied, 403);
  }
  const prefer = req.headers.get("Prefer") || "";
  const returnMinimal = prefer.includes("return=minimal");
  if (req.method === "GET") {
    const paramsHooked = await pipeHook("beforeSelect", P, table);
    const filter = toFilter(paramsHooked);
    let rows = filter ? await getRows(table, filter) : await getAllRows(table);
    rows = await pipeHook("afterSelect", rows, table);
    if (P.select && P.select !== "*") {
      const cols = P.select.split(",").filter((c) => validId(c));
      rows = rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    }
    if (P.order) {
      const [col, dir] = P.order.split(".");
      if (validId(col))
        rows.sort((a, b) => dir === "desc" ? b[col] > a[col] ? 1 : -1 : a[col] > b[col] ? 1 : -1);
    }
    const limit = Math.max(0, parseInt(P.limit) || 1000);
    const offset = Math.max(0, parseInt(P.offset) || 0);
    const page = clean(rows).slice(offset, offset + limit);
    const rangeEnd = page.length ? offset + page.length - 1 : 0;
    const extra = {};
    if (P.count === "exact" || prefer.includes("count=exact")) {
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
    const tExists = await openTbl(table);
    if (!tExists)
      await mkTbl(table, rows[0]);
    else
      await ensureCols(table, rows[0]);
    for (const row of rows)
      await dbInsert(table, row);
    for (const row of clean(rows))
      broadcastChange(table, "INSERT", row, null);
    if (returnMinimal)
      return new Response(null, { status: 204, headers: cors });
    return ok(clean(rows), 201);
  }
  if (req.method === "PUT" || req.method === "PATCH") {
    const filter = toFilter(P);
    if (!filter)
      return err("No filter provided");
    if (!await openTbl(table))
      return err("Table not found", 404);
    const data = Array.isArray(B) ? B[0] : B;
    if (Object.keys(data).some((k) => !validId(k)))
      return err("Invalid column name");
    let existing = await getRows(table, filter);
    if (!existing.length)
      return ok([]);
    const preErr = await fireHook("beforeUpdate", table, existing, data);
    if (preErr)
      return err(preErr, 400);
    await dbUpdate(table, data, filter);
    let updated = existing.map((r) => ({ ...r, ...data }));
    updated = await pipeHook("afterUpdate", updated, table);
    for (let i = 0;i < updated.length; i++)
      broadcastChange(table, "UPDATE", clean([updated[i]])[0], clean([existing[i]])[0]);
    if (returnMinimal)
      return new Response(null, { status: 204, headers: cors });
    return ok(clean(updated));
  }
  if (req.method === "DELETE") {
    const filter = toFilter(P);
    if (!filter)
      return err("No filter provided");
    if (!await openTbl(table))
      return err("Table not found", 404);
    const toDelete = await getRows(table, filter);
    const preErr = await fireHook("beforeDelete", table, toDelete);
    if (preErr)
      return err(preErr, 400);
    await dbDelete(table, filter);
    await fireHook("afterDelete", table, toDelete);
    for (const row of clean(toDelete))
      broadcastChange(table, "DELETE", null, row);
    if (returnMinimal)
      return new Response(null, { status: 204, headers: cors });
    return ok([]);
  }
  return err("Method not allowed", 405);
};

// src/server.ts
var PORT = process.env.BUSYBASE_PORT || 54321;
var UNIX_SOCKET = process.env.BUSYBASE_UNIX_SOCKET || null;
await initAuthTables();
setInterval(sweepExpired, 5 * 60000).unref();
var mime = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
var ext = (p) => p.slice(p.lastIndexOf(".")) || "";
var server = Bun.serve({ ...UNIX_SOCKET ? { unix: UNIX_SOCKET } : { port: PORT }, websocket: wsHandlers, fetch: async (req) => {
  if (req.headers.get("upgrade") === "websocket" && new URL(req.url).pathname === "/realtime/v1/websocket") {
    const upgraded = server.upgrade(req, { data: { tables: new Set } });
    return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
  }
  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (hooks.onRequest) {
    const r = await hooks.onRequest(req);
    if (r)
      return r;
  }
  const { pathname, searchParams } = new URL(req.url);
  const P = Object.fromEntries(searchParams);
  const hasBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  const B = hasBody ? await req.json().catch(() => ({})) : {};
  if (pathname.startsWith("/auth/v1/")) {
    const action = pathname.split("/")[3];
    const result = await handleAuth(action, req, B);
    return result ?? err("Not found", 404);
  }
  if (pathname.startsWith("/rest/v1/")) {
    const table = pathname.slice(9).split("/").map(decodeURIComponent).filter(Boolean)[0];
    if (!table)
      return err("Table required");
    return handleRest(table, req, P, B);
  }
  if (pathname === "/studio/config") {
    const data = { BUSYBASE_DIR: process.env.BUSYBASE_DIR || "busybase_data", BUSYBASE_PORT: String(PORT), BUSYBASE_CORS_ORIGIN: process.env.BUSYBASE_CORS_ORIGIN || "*" };
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
  if (pathname === "/studio" || pathname === "/studio/") {
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
        return new Response(file, { headers: { "Content-Type": mime[ext(name)] || "application/octet-stream", ...cors } });
    }
    return err("Not found", 404);
  }
  const staticRoutes = { "/": "./gui.html", "/gui": "./gui.html", "/docs": "../docs/docs.html", "/site": "../docs/index.html" };
  if (pathname in staticRoutes) {
    const file = Bun.file(new URL(staticRoutes[pathname], import.meta.url));
    if (await file.exists())
      return new Response(file, { headers: { "Content-Type": "text/html", ...cors } });
    return err("Not found", 404);
  }
  return err("Not found", 404);
} });
console.log(UNIX_SOCKET ? `BusyBase: unix socket ${UNIX_SOCKET}` : `BusyBase: http://localhost:${PORT}  |  Studio: http://localhost:${PORT}/studio`);
