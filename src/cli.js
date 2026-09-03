#!/usr/bin/env bun
// @bun
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __promiseAll = (args) => Promise.all(args);

// src/hooks.ts
var smtpHost, smtpPort, smtpUser, smtpPass, smtpFrom, b64e = (s) => Buffer.from(s).toString("base64"), smtpSend = async (to, subject, html) => {
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
}, hooksFile, userHooks, hooks, fireHook = async (name, ...args) => {
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
}, pipeHook = async (name, value, ...args) => {
  const fn = hooks[name];
  if (!fn)
    return value;
  try {
    const r = await fn(value, ...args);
    if (r && typeof r === "object" && !r.error)
      return r;
  } catch {}
  return value;
}, sendEmail = async (to, subject, html, text = "") => {
  if (hooks.sendEmail) {
    await hooks.sendEmail({ to, subject, html, text });
    return;
  }
  const sent = await smtpSend(to, subject, html);
  if (!sent)
    console.log(`[BusyBase] No email transport configured. Would send to ${to}: ${subject}`);
};
var init_hooks = __esm(async () => {
  smtpHost = process.env.BUSYBASE_SMTP_HOST;
  smtpPort = parseInt(process.env.BUSYBASE_SMTP_PORT || "587");
  smtpUser = process.env.BUSYBASE_SMTP_USER || "";
  smtpPass = process.env.BUSYBASE_SMTP_PASS || "";
  smtpFrom = process.env.BUSYBASE_SMTP_FROM || smtpUser;
  hooksFile = process.env.BUSYBASE_HOOKS;
  userHooks = {};
  if (hooksFile) {
    try {
      userHooks = await (hooksFile.startsWith(".") ? import(Bun.resolveSync(hooksFile, process.cwd())) : import(hooksFile));
      console.log(`[BusyBase] Hooks loaded: ${hooksFile}`);
    } catch (e) {
      console.warn(`[BusyBase] Could not load hooks file: ${hooksFile}`, e);
    }
  }
  hooks = userHooks;
});

// src/realtime.ts
var registry, sub = (ws, table) => {
  ws.data.tables.add(table);
  if (!registry.has(table))
    registry.set(table, new Set);
  registry.get(table).add(ws);
}, unsub = (ws, table) => {
  ws.data.tables.delete(table);
  registry.get(table)?.delete(ws);
}, broadcastChange = (table, eventType, newRow, oldRow) => {
  const subs = registry.get(table);
  if (!subs?.size)
    return;
  const msg = JSON.stringify({ event: eventType, table, eventType, new: newRow ?? null, old: oldRow ?? null });
  for (const ws of subs) {
    try {
      ws.send(msg);
    } catch {}
  }
}, wsHandlers;
var init_realtime = __esm(() => {
  registry = new Map;
  wsHandlers = {
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
});

// src/db.ts
import { createClient } from "@libsql/client";
import { mkdirSync } from "fs";
var DIR, CORS_ORIGIN, cors, json = (data, status = 200, extra = {}) => Response.json(data, { status, headers: { ...cors, ...extra } }), ok = (data, status = 200, extra = {}) => json({ data, error: null }, status, extra), err = (msg, code = 400, hint = "") => json({ data: null, error: { message: msg, hint, code } }, code), esc = (s) => String(s).replace(/\0/g, "").replace(/'/g, "''"), validId = (s) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s) && s !== "_users" && s !== "_sessions", db, tableExists = async (name) => {
  const r = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?", args: [name] });
  return r.rows.length > 0;
}, openTbl = async (name) => await tableExists(name) ? name : null, mkTbl = async (name, row) => {
  const cols = Object.keys(row).map((k) => `${k} TEXT`).join(", ");
  await db.execute(`CREATE TABLE IF NOT EXISTS ${name} (${cols})`);
  return name;
}, ensureCols = async (name, row) => {
  const info = await db.execute(`PRAGMA table_info(${name})`);
  const existing = new Set(info.rows.map((r) => r.name));
  for (const k of Object.keys(row)) {
    if (!existing.has(k))
      await db.execute(`ALTER TABLE ${name} ADD COLUMN ${k} TEXT`);
  }
}, dbInsert = async (name, row) => {
  const keys = Object.keys(row);
  const ph = keys.map(() => "?").join(", ");
  const vals = keys.map((k) => row[k] == null ? null : String(row[k]));
  await db.execute({ sql: `INSERT INTO ${name} (${keys.join(", ")}) VALUES (${ph})`, args: vals });
}, getRows = async (name, where) => {
  if (!await tableExists(name))
    return [];
  const r = await db.execute(`SELECT * FROM ${name} WHERE ${where}`);
  return r.rows.map((row) => ({ ...row }));
}, getAllRows = async (name) => {
  if (!await tableExists(name))
    return [];
  const r = await db.execute(`SELECT * FROM ${name}`);
  return r.rows.map((row) => ({ ...row }));
}, dbUpdate = async (name, data, where) => {
  const keys = Object.keys(data).filter((k) => k !== "id");
  if (!keys.length)
    return;
  const sets = keys.map((k) => `${k}=?`).join(", ");
  const vals = keys.map((k) => data[k] == null ? null : String(data[k]));
  await db.execute({ sql: `UPDATE ${name} SET ${sets} WHERE ${where}`, args: vals });
}, dbDelete = async (name, where) => {
  await db.execute(`DELETE FROM ${name} WHERE ${where}`);
}, tableNames = async () => {
  const r = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  return r.rows.map((row) => row.name);
}, clean = (rows) => rows.map(({ pw, pubkey: _pk, ...r }) => r), makeUser = (u) => ({
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
}), makeSession = (token, refresh, exp, user) => ({
  access_token: token,
  refresh_token: refresh,
  token_type: "bearer",
  expires_in: 604800,
  expires_at: Math.floor(exp / 1000),
  user
}), issueSession = async (uid) => {
  const token = crypto.randomUUID(), refresh = crypto.randomUUID();
  const exp = Date.now() + 7 * 24 * 60 * 60 * 1000;
  await db.execute({ sql: "INSERT INTO _sessions (token, refresh, uid, exp) VALUES (?, ?, ?, ?)", args: [token, refresh, uid, exp] });
  return { token, refresh, exp };
}, getUser = async (r) => {
  const token = r.headers.get("Authorization")?.split(" ")[1];
  if (!token)
    return null;
  const sessions = await db.execute({ sql: "SELECT * FROM _sessions WHERE token=? AND exp>?", args: [token, Date.now()] });
  const s = sessions.rows[0];
  if (!s)
    return null;
  const users = await getRows("_users", `id = '${esc(s.uid)}'`);
  return users[0] ? makeUser(users[0]) : null;
}, NUM_LIT, cmp = (col, s, val) => NUM_LIT.test(val) ? `(${col} ${s} '${esc(val)}' OR ${col} ${s} CAST('${esc(val)}' AS NUMERIC))` : `${col} ${s} '${esc(val)}'`, toFilter = (p) => {
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
var init_db = __esm(() => {
  DIR = process.env.BUSYBASE_DIR || "busybase_data";
  CORS_ORIGIN = process.env.BUSYBASE_CORS_ORIGIN || "*";
  cors = {
    "Access-Control-Allow-Origin": CORS_ORIGIN,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,apikey,Prefer"
  };
  mkdirSync(DIR, { recursive: true });
  db = createClient({ url: `file:${DIR}/db.sqlite` });
  NUM_LIT = /^-?\d+(\.\d+)?$/;
});

// src/auth.ts
var nonces, resetTokens, importPubKey = (b642) => crypto.subtle.importKey("raw", Uint8Array.from(atob(b642), (c) => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]), initAuthTables = async () => {
  await db.execute(`CREATE TABLE IF NOT EXISTS _users (
    id TEXT, email TEXT, pw TEXT, pubkey TEXT, role TEXT,
    meta TEXT, app_meta TEXT, created TEXT, updated TEXT, last_sign_in TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS _sessions (token TEXT, refresh TEXT, uid TEXT, exp INTEGER)`);
}, sweepExpired = async () => {
  const now = Date.now();
  for (const [k, exp] of nonces)
    if (exp < now)
      nonces.delete(k);
  for (const [k, v] of resetTokens)
    if (v.exp < now)
      resetTokens.delete(k);
  await db.execute({ sql: "DELETE FROM _sessions WHERE exp < ?", args: [now] }).catch(() => {});
}, handleAuth = async (action, req, B) => {
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
var init_auth = __esm(async () => {
  init_db();
  await init_hooks();
  nonces = new Map;
  resetTokens = new Map;
});

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
var init_rest = __esm(async () => {
  init_realtime();
  init_db();
  await init_hooks();
});

// src/server.ts
var exports_server = {};
var PORT, UNIX_SOCKET, mime, ext = (p) => p.slice(p.lastIndexOf(".")) || "", server;
var init_server = __esm(async () => {
  init_realtime();
  init_db();
  await __promiseAll([
    init_hooks(),
    init_auth(),
    init_rest()
  ]);
  PORT = process.env.BUSYBASE_PORT || 54321;
  UNIX_SOCKET = process.env.BUSYBASE_UNIX_SOCKET || null;
  await initAuthTables();
  setInterval(sweepExpired, 5 * 60000).unref();
  mime = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css" };
  server = Bun.serve({ ...UNIX_SOCKET ? { unix: UNIX_SOCKET } : { port: PORT }, websocket: wsHandlers, fetch: async (req) => {
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
});

// src/sdk.ts
var b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
var unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
var genKeypair = async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const [pub, priv] = await Promise.all([
    crypto.subtle.exportKey("raw", kp.publicKey),
    crypto.subtle.exportKey("pkcs8", kp.privateKey)
  ]);
  return { pubkey: b64(pub), privkey: b64(priv) };
};
var sign = async (privkeyB64, message) => {
  const key = await crypto.subtle.importKey("pkcs8", unb64(privkeyB64), { name: "Ed25519" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message)));
};
var makeStore = () => {
  try {
    localStorage.setItem("_bb_", "1");
    localStorage.removeItem("_bb_");
    return localStorage;
  } catch {
    const m = new Map;
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  }
};
var BB = (url, key) => {
  let token = null;
  let session = null;
  const authListeners = [];
  const base = url.replace(/\/$/, "");
  const store = makeStore();
  const emit = (event, s) => authListeners.forEach((cb) => cb(event, s));
  const setSession_ = (s) => {
    session = s;
    token = s?.access_token ?? null;
  };
  const req = async (path, opts = {}) => {
    const r = await globalThis.fetch(`${base}/${path}`, {
      ...opts,
      headers: { apikey: key, Authorization: `Bearer ${token || key}`, "Content-Type": "application/json", ...opts.headers }
    });
    return r.json();
  };
  const keypair = {
    generate: genKeypair,
    signIn: async (privkeyB64) => {
      try {
        let privkey = privkeyB64 ?? store.getItem("_bb_privkey");
        let pubkey = store.getItem("_bb_pubkey");
        if (!privkey) {
          const kp = await genKeypair();
          privkey = kp.privkey;
          pubkey = kp.pubkey;
          store.setItem("_bb_privkey", privkey);
          store.setItem("_bb_pubkey", pubkey);
        } else if (!pubkey) {
          const privCrypto = await crypto.subtle.importKey("pkcs8", unb64(privkey), { name: "Ed25519" }, true, ["sign"]);
          return { data: null, error: { message: "Pubkey missing \u2014 call keypair.restore(privkey, pubkey)" } };
        }
        const nonceRes = await req("auth/v1/keypair");
        if (nonceRes.error)
          return nonceRes;
        const nonce = nonceRes.data.nonce;
        const signature = await sign(privkey, nonce);
        const r = await req("auth/v1/keypair", { method: "POST", body: JSON.stringify({ pubkey, nonce, signature }) });
        if (r.data?.session) {
          setSession_(r.data.session);
          store.setItem("_bb_privkey", privkey);
          store.setItem("_bb_pubkey", pubkey);
          emit("SIGNED_IN", session);
        }
        return r;
      } catch (e) {
        return { data: null, error: { message: e?.message || "Keypair sign-in failed" } };
      }
    },
    restore: async (privkey, pubkey) => {
      store.setItem("_bb_privkey", privkey);
      store.setItem("_bb_pubkey", pubkey);
      return keypair.signIn(privkey);
    },
    export: () => ({
      privkey: store.getItem("_bb_privkey"),
      pubkey: store.getItem("_bb_pubkey")
    }),
    forget: () => {
      store.removeItem("_bb_privkey");
      store.removeItem("_bb_pubkey");
    }
  };
  const Q = (table, method, body) => {
    const q = { filters: [], order: "", limit: 0, offset: 0, select: "*", count: "" };
    let _single = false, _maybeSingle = false;
    const qs = () => {
      const p = [`select=${q.select}`, ...q.filters];
      if (q.order)
        p.push(`order=${q.order}`);
      if (q.limit)
        p.push(`limit=${q.limit}`);
      if (q.offset)
        p.push(`offset=${q.offset}`);
      if (q.count)
        p.push(`count=${q.count}`);
      return p.join("&");
    };
    const run = () => method && body !== undefined ? req(`rest/v1/${table}?${qs()}`, { method, body: JSON.stringify(body) }) : req(`rest/v1/${table}?${qs()}`);
    const resolve = async () => {
      const res = await run();
      if (res.error)
        return res;
      const data = res.data ?? res;
      if (_single) {
        if (!Array.isArray(data) || !data.length)
          return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: 406 } };
        return { data: data[0], error: null };
      }
      if (_maybeSingle)
        return { data: Array.isArray(data) ? data[0] ?? null : data, error: null };
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
      not: (col, op, val) => (q.filters.push(`not.${col}.${op}=${val}`), b),
      or: (clause) => (q.filters.push(`or=${clause}`), b),
      filter: (col, op, val) => (q.filters.push(`${op}.${col}=${val}`), b),
      order: (col, { ascending = true } = {}) => (q.order = `${col}.${ascending ? "asc" : "desc"}`, b),
      limit: (n) => (q.limit = n, b),
      offset: (n) => (q.offset = n, b),
      range: (from2, to) => (q.offset = from2, q.limit = to - from2 + 1, b),
      count: (type = "exact") => (q.count = type, b),
      single: () => (_single = true, b),
      maybeSingle: () => (_maybeSingle = true, b),
      then: (res, rej) => resolve().then(res, rej)
    };
    return b;
  };
  const wrap = (p) => p.then((r) => r?.error !== undefined ? r : { data: r, error: null });
  const from = (table) => ({
    select: (cols = "*") => Q(table).select(cols),
    insert: (data) => wrap(req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify(Array.isArray(data) ? data : [data]) })),
    upsert: (data) => {
      const rows = Array.isArray(data) ? data : [data];
      const withIds = rows.map((r) => ({ ...r, id: r.id ?? crypto.randomUUID() }));
      const doRow = async (r) => {
        const existing = await req(`rest/v1/${table}?eq.id=${encodeURIComponent(r.id)}`);
        if (existing?.data?.length) {
          return req(`rest/v1/${table}?eq.id=${encodeURIComponent(r.id)}`, { method: "PATCH", body: JSON.stringify(r) });
        }
        return req(`rest/v1/${table}`, { method: "POST", body: JSON.stringify([r]) });
      };
      return wrap(Promise.all(withIds.map(doRow)).then((results) => ({ data: results.flatMap((r) => r?.data ?? []), error: null })));
    },
    update: (data) => Q(table, "PATCH", data),
    delete: () => Q(table, "DELETE", null)
  });
  const auth = {
    signIn: () => keypair.signIn(),
    signUp: ({ email, password, options }) => req("auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password, data: options?.data }) }).then((r) => {
      if (r.data?.session) {
        setSession_(r.data.session);
        emit("SIGNED_IN", session);
      }
      return r;
    }),
    signInWithPassword: ({ email, password }) => req("auth/v1/token", { method: "POST", body: JSON.stringify({ email, password }) }).then((r) => {
      if (r.data?.session) {
        setSession_(r.data.session);
        emit("SIGNED_IN", session);
      }
      return r;
    }),
    signOut: () => req("auth/v1/logout", { method: "POST" }).then((r) => {
      setSession_(null);
      emit("SIGNED_OUT", null);
      return r;
    }),
    getUser: () => req("auth/v1/user"),
    getSession: () => Promise.resolve({ data: { session }, error: null }),
    updateUser: (attrs) => req("auth/v1/update", { method: "PATCH", body: JSON.stringify(attrs) }).then((r) => {
      if (r.data?.user)
        emit("USER_UPDATED", session);
      return r;
    }),
    setSession: (s) => {
      setSession_(s);
      return Promise.resolve({ data: { session: s }, error: null });
    },
    resetPasswordForEmail: (_email) => Promise.resolve({ data: {}, error: null }),
    onAuthStateChange: (cb) => {
      authListeners.push(cb);
      cb("INITIAL_SESSION", session);
      return { data: { subscription: { unsubscribe: () => {
        const i = authListeners.indexOf(cb);
        if (i > -1)
          authListeners.splice(i, 1);
      } } } };
    },
    keypair
  };
  const channels = new Map;
  const channel = (name) => {
    const handlers = [];
    let ws = null;
    const wsUrl = base.replace(/^http/, "ws") + "/realtime/v1/websocket";
    const ch = {
      on: (type, opts, cb) => {
        handlers.push({ event: opts.event, table: opts.table, cb });
        return ch;
      },
      subscribe: (statusCb) => {
        ws = new globalThis.WebSocket(wsUrl);
        ws.onopen = () => {
          const tables = [...new Set(handlers.map((h) => h.table))];
          for (const t of tables)
            ws.send(JSON.stringify({ type: "subscribe", table: t }));
          statusCb?.("SUBSCRIBED");
        };
        ws.onmessage = (e) => {
          try {
            const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
            for (const h of handlers) {
              if (h.table === msg.table && (h.event === "*" || h.event === msg.eventType))
                h.cb(msg);
            }
          } catch {}
        };
        ws.onerror = () => statusCb?.("CHANNEL_ERROR");
        ws.onclose = () => statusCb?.("CLOSED");
        channels.set(name, ch);
        return ch;
      },
      unsubscribe: () => {
        ws?.close();
        channels.delete(name);
      }
    };
    return ch;
  };
  const removeAllChannels = () => {
    for (const ch of channels.values())
      ch.unsubscribe();
  };
  return { from, auth, channel, removeAllChannels };
};
var sdk_default = BB;

// src/cli.ts
var URL2 = process.env.BUSYBASE_URL || `http://localhost:${process.env.BUSYBASE_PORT || 54321}`;
var KEY = process.env.BUSYBASE_KEY || "local";
var [cmd, ...args] = process.argv.slice(2);
var db2 = sdk_default(URL2, KEY);
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
  const r = await db2.auth.signUp({ email, password });
  print(r);
} else if (cmd === "signin") {
  const [email, password] = args;
  if (!email || !password)
    die("Usage: busybase signin <email> <password>");
  const r = await db2.auth.signInWithPassword({ email, password });
  print(r);
} else if (cmd === "user") {
  const r = await db2.auth.getUser();
  print(r);
} else if (cmd === "insert") {
  const [table, jsonStr] = args;
  if (!table || !jsonStr)
    die("Usage: busybase insert <table> <json>");
  const data = JSON.parse(jsonStr);
  const r = await db2.from(table).insert(data);
  print(r);
} else if (cmd === "query") {
  const [table, ...filters] = args;
  if (!table)
    die("Usage: busybase query <table> [col=val ...]");
  let q = db2.from(table).select("*");
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
} else if (cmd === "update") {
  const [table, jsonStr, ...filters] = args;
  if (!table || !jsonStr)
    die("Usage: busybase update <table> <json> [col=val ...]");
  const data = JSON.parse(jsonStr);
  let q = db2.from(table).update(data);
  q = parseFilter(q, filters);
  const r = await q;
  print(r);
} else if (cmd === "delete") {
  const [table, ...filters] = args;
  if (!table || !filters.length)
    die("Usage: busybase delete <table> <col=val> ...");
  let q = db2.from(table).delete();
  q = parseFilter(q, filters);
  const r = await q;
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
  console.log("[auth.keypair \u2014 anonymous sign-in]");
  const kp1 = await db2.auth.keypair.signIn();
  check("keypair signIn returns {data,error}", kp1.data !== undefined && "error" in kp1, kp1);
  check("keypair user.id exists", !!kp1.data?.user?.id, kp1.data?.user);
  check("keypair session.access_token", !!kp1.data?.session?.access_token, kp1.data?.session);
  check("keypair session.refresh_token", !!kp1.data?.session?.refresh_token, kp1.data?.session);
  check("keypair session.expires_at is number", typeof kp1.data?.session?.expires_at === "number", kp1.data?.session);
  console.log(`
[auth.keypair \u2014 same key = same user]`);
  const exported = db2.auth.keypair.export();
  const db22 = sdk_default(URL2, "local");
  const kp2 = await db22.auth.keypair.restore(exported.privkey, exported.pubkey);
  check("restore returns same user.id", kp2.data?.user?.id === kp1.data?.user?.id, { kp1: kp1.data?.user?.id, kp2: kp2.data?.user?.id });
  console.log(`
[auth.keypair \u2014 new keypair = new user]`);
  const db3 = sdk_default(URL2, "local");
  const kp3 = await db3.auth.keypair.signIn();
  check("different keypair = different user", kp3.data?.user?.id !== kp1.data?.user?.id, { id1: kp1.data?.user?.id, id3: kp3.data?.user?.id });
  console.log(`
[keypair user \u2014 progressively add email]`);
  const dbKp = sdk_default(URL2, "local");
  await dbKp.auth.keypair.restore(exported.privkey, exported.pubkey);
  const upgr = await dbKp.auth.updateUser({ email: `keypair_${Date.now()}@test.com`, data: { name: "Anon" } });
  check("updateUser on keypair account works", !!upgr.data?.user?.email, upgr.data);
  check("metadata stored", upgr.data?.user?.user_metadata?.name === "Anon", upgr.data?.user);
  console.log(`
[auth.signUp]`);
  const rawEmail = `Test_${Date.now()}@BB.com`;
  const su = await db2.auth.signUp({ email: rawEmail, password: "pass123" });
  check("returns {data,error}", su.data !== undefined && "error" in su, su);
  check("data.user has id", !!su.data?.user?.id, su.data);
  check("email lowercased", su.data?.user?.email === rawEmail.toLowerCase(), su.data?.user);
  check("user has role=authenticated", su.data?.user?.role === "authenticated", su.data?.user);
  check("user has user_metadata", typeof su.data?.user?.user_metadata === "object", su.data?.user);
  check("user has app_metadata", typeof su.data?.user?.app_metadata === "object", su.data?.user);
  check("user has created_at", !!su.data?.user?.created_at, su.data?.user);
  const email = su.data?.user?.email;
  console.log(`
[auth.signInWithPassword]`);
  const si = await db2.auth.signInWithPassword({ email, password: "pass123" });
  check("returns {data,error}", si.data !== undefined && "error" in si, si);
  check("data.session.access_token", !!si.data?.session?.access_token, si.data);
  check("data.session.refresh_token", !!si.data?.session?.refresh_token, si.data?.session);
  check("data.session.expires_at is number", typeof si.data?.session?.expires_at === "number", si.data?.session);
  check("data.session.expires_in = 604800", si.data?.session?.expires_in === 604800, si.data?.session);
  check("data.user.email matches", si.data?.user?.email === email, si.data?.user);
  check("data.user.last_sign_in_at", !!si.data?.user?.last_sign_in_at, si.data?.user);
  console.log(`
[auth.signInWithPassword - bad creds]`);
  const bad = await db2.auth.signInWithPassword({ email, password: "wrong" });
  check("error on bad creds", !!bad.error, bad);
  console.log(`
[auth.getUser]`);
  const gu = await db2.auth.getUser();
  check("returns {data,error}", gu.data !== undefined && "error" in gu, gu);
  check("data.user.email matches", gu.data?.user?.email === email, gu.data);
  console.log(`
[auth.getSession]`);
  const gs = await db2.auth.getSession();
  check("returns {data,error}", gs.data !== undefined && "error" in gs, gs);
  check("data.session.access_token", !!gs.data?.session?.access_token, gs.data);
  check("data.session.refresh_token", !!gs.data?.session?.refresh_token, gs.data?.session);
  console.log(`
[auth.updateUser]`);
  const uu = await db2.auth.updateUser({ data: { name: "Alice" } });
  check("returns {data,error}", uu.data !== undefined && "error" in uu, uu);
  check("user_metadata updated", uu.data?.user?.user_metadata?.name === "Alice", uu.data?.user);
  console.log(`
[auth.onAuthStateChange]`);
  let fired = false;
  const { data: { subscription } } = db2.auth.onAuthStateChange((event, sess) => {
    fired = true;
  });
  await Bun.sleep(10);
  check("INITIAL_SESSION fires", fired);
  subscription.unsubscribe();
  const tbl = `test_${Date.now()}`;
  console.log(`
[from.insert \u2014 table: ${tbl}]`);
  const ins1 = await db2.from(tbl).insert({ name: "Alice", score: "10" });
  check("returns {data,error}", ins1.data !== undefined && "error" in ins1, ins1);
  check("data[0].name = Alice", ins1.data?.[0]?.name === "Alice", ins1.data);
  const ins2 = await db2.from(tbl).insert([{ name: "Bob", score: "20" }, { name: "Carol", score: "30" }]);
  check("batch insert data.length=2", ins2.data?.length === 2, ins2.data);
  console.log(`
[from.select]`);
  const all = await db2.from(tbl).select("*");
  check("returns {data,error}", all.data !== undefined && "error" in all, all);
  check("data.length=3", all.data?.length === 3, all.data);
  console.log(`
[filters]`);
  const feq = await db2.from(tbl).select("*").eq("name", "Alice");
  check(".eq \u2014 1 row", feq.data?.length === 1, feq.data);
  const fneq = await db2.from(tbl).select("*").neq("name", "Alice");
  check(".neq \u2014 2 rows", fneq.data?.length === 2, fneq.data);
  const fin = await db2.from(tbl).select("*").in("name", ["Alice", "Bob"]);
  check(".in \u2014 2 rows", fin.data?.length === 2, fin.data);
  const flike = await db2.from(tbl).select("*").like("name", "Ali%");
  check(".like \u2014 1 row", flike.data?.length === 1, flike.data);
  const for_ = await db2.from(tbl).select("*").or("name.eq.Alice,name.eq.Bob");
  check(".or \u2014 2 rows", for_.data?.length === 2, for_.data);
  const fnot = await db2.from(tbl).select("*").not("name", "eq", "Alice");
  check(".not \u2014 2 rows", fnot.data?.length === 2, fnot.data);
  console.log(`
[modifiers]`);
  const ord = await db2.from(tbl).select("*").order("name", { ascending: true });
  check(".order asc \u2014 first=Alice", ord.data?.[0]?.name === "Alice", ord.data);
  const lim = await db2.from(tbl).select("*").limit(2);
  check(".limit(2) \u2014 2 rows", lim.data?.length === 2, lim.data);
  const off = await db2.from(tbl).select("*").order("name", { ascending: true }).offset(1).limit(1);
  check(".offset(1) \u2014 Bob", off.data?.[0]?.name === "Bob", off.data);
  const rng = await db2.from(tbl).select("*").order("name", { ascending: true }).range(0, 1);
  check(".range(0,1) \u2014 2 rows", rng.data?.length === 2, rng.data);
  const cnt = await db2.from(tbl).select("*").count("exact");
  check(".count \u2014 count=3", cnt.count === 3, cnt);
  const sng = await db2.from(tbl).select("*").eq("name", "Alice").single();
  check(".single() \u2014 returns object", !Array.isArray(sng.data) && sng.data?.name === "Alice", sng.data);
  const ms = await db2.from(tbl).select("*").eq("name", "Nobody").maybeSingle();
  check(".maybeSingle() \u2014 null if no rows", ms.data === null && !ms.error, ms);
  const sel = await db2.from(tbl).select("name");
  check(".select(cols) \u2014 only name key", sel.data?.[0] && Object.keys(sel.data[0]).length === 1, sel.data?.[0]);
  console.log(`
[update + delete]`);
  const upd = await db2.from(tbl).update({ score: "99" }).eq("name", "Alice");
  check(".update.eq \u2014 score=99", upd.data?.[0]?.score === "99", upd.data);
  const del = await db2.from(tbl).delete().eq("name", "Carol");
  check(".delete.eq \u2014 ok", !del.error, del);
  const afterDel = await db2.from(tbl).select("*");
  check("2 rows remain after delete", afterDel.data?.length === 2, afterDel.data);
  console.log(`
[Prefer: return=minimal]`);
  const minRes = await globalThis.fetch(`${URL2}/rest/v1/${tbl}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ name: "Dave", score: "5" })
  });
  check("POST return=minimal \u2192 204", minRes.status === 204, minRes.status);
  console.log(`
[Content-Range header]`);
  const crRes = await globalThis.fetch(`${URL2}/rest/v1/${tbl}?count=exact`);
  check("Content-Range header present", crRes.headers.has("content-range"), crRes.headers.get("content-range"));
  console.log(`
[auth.signOut]`);
  await db2.auth.signOut();
  const afterOut = await db2.auth.getUser();
  check("getUser after signOut = error", !!afterOut.error, afterOut);
  console.log(`
[auth.setSession]`);
  const ss = await db2.auth.setSession({ access_token: "fake", refresh_token: "fake" });
  check("setSession returns {data,error}", ss.data !== undefined && "error" in ss, ss);
  const rpf = await db2.auth.resetPasswordForEmail("anyone@example.com");
  check("resetPasswordForEmail stub ok", !rpf.error, rpf);
  const rtTbl = `rt_${Date.now()}`;
  console.log(`
[realtime \u2014 table: ${rtTbl}]`);
  const wsUrl = URL2.replace(/^http/, "ws") + "/realtime/v1/websocket";
  const wsWait = (ws, eventName) => new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${eventName}`)), 3000);
    ws[`on${eventName}`] = (e) => {
      clearTimeout(t);
      res(e);
    };
  });
  const ws1 = new globalThis.WebSocket(wsUrl);
  await wsWait(ws1, "open");
  ws1.send(JSON.stringify({ type: "subscribe", table: rtTbl }));
  const recv1 = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout INSERT event")), 3000);
    ws1.onmessage = (e) => {
      clearTimeout(t);
      res(JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()));
    };
  });
  await db2.from(rtTbl).insert({ name: "rt_alice", score: "1" });
  let rtMsg;
  try {
    rtMsg = await recv1;
  } catch {
    rtMsg = null;
  }
  check("realtime INSERT event received", rtMsg?.eventType === "INSERT", rtMsg);
  check("realtime INSERT event.table correct", rtMsg?.table === rtTbl, rtMsg);
  check("realtime INSERT event.new has name", rtMsg?.new?.name === "rt_alice", rtMsg);
  check("realtime INSERT event.old is null", rtMsg?.old === null, rtMsg);
  const recv2 = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout UPDATE event")), 3000);
    ws1.onmessage = (e) => {
      clearTimeout(t);
      res(JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()));
    };
  });
  await db2.from(rtTbl).update({ score: "99" }).eq("name", "rt_alice");
  let rtUpd;
  try {
    rtUpd = await recv2;
  } catch {
    rtUpd = null;
  }
  check("realtime UPDATE event received", rtUpd?.eventType === "UPDATE", rtUpd);
  check("realtime UPDATE new.score=99", rtUpd?.new?.score === "99", rtUpd);
  check("realtime UPDATE old.score=1", rtUpd?.old?.score === "1", rtUpd);
  const recv3 = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("timeout DELETE event")), 3000);
    ws1.onmessage = (e) => {
      clearTimeout(t);
      res(JSON.parse(typeof e.data === "string" ? e.data : e.data.toString()));
    };
  });
  await db2.from(rtTbl).delete().eq("name", "rt_alice");
  let rtDel;
  try {
    rtDel = await recv3;
  } catch {
    rtDel = null;
  }
  check("realtime DELETE event received", rtDel?.eventType === "DELETE", rtDel);
  check("realtime DELETE event.new is null", rtDel?.new === null, rtDel);
  check("realtime DELETE old.name=rt_alice", rtDel?.old?.name === "rt_alice", rtDel);
  ws1.close();
  const rtTbl2 = `rt2_${Date.now()}`;
  const chEvents = [];
  const ch = db2.channel("test-ch").on("postgres_changes", { event: "*", schema: "public", table: rtTbl2 }, (payload) => chEvents.push(payload)).subscribe();
  await Bun.sleep(200);
  await db2.from(rtTbl2).insert({ label: "sdk_test" });
  await Bun.sleep(300);
  check("SDK channel INSERT event received", chEvents.some((e) => e.eventType === "INSERT" && e.new?.label === "sdk_test"), chEvents);
  ch.unsubscribe();
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

Environment:
  BUSYBASE_URL   Server URL (default: http://localhost:54321)
  BUSYBASE_KEY   API key (default: local)
  BUSYBASE_DIR   Data dir for 'serve' (default: busybase_data)
  BUSYBASE_PORT  Port for 'serve' (default: 54321)
`);
}
