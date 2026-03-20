import { fireHook, sendEmail, hooks } from "./hooks.ts";
import { db, esc, getRows, dbInsert, dbUpdate, dbDelete, makeUser, makeSession, issueSession, ok, err, getUser } from "./db.ts";

const nonces = new Map<string, number>();
const resetTokens = new Map<string, { uid: string; exp: number }>();

const importPubKey = (b64: string) =>
  crypto.subtle.importKey("raw", Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);

export const initAuthTables = async () => {
  await db.execute(`CREATE TABLE IF NOT EXISTS _users (
    id TEXT, email TEXT, pw TEXT, pubkey TEXT, role TEXT,
    meta TEXT, app_meta TEXT, created TEXT, updated TEXT, last_sign_in TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS _sessions (token TEXT, refresh TEXT, uid TEXT, exp INTEGER)`);
};

export const sweepExpired = async () => {
  const now = Date.now();
  for (const [k, exp] of nonces) if (exp < now) nonces.delete(k);
  for (const [k, v] of resetTokens) if (v.exp < now) resetTokens.delete(k);
  await db.execute({ sql: "DELETE FROM _sessions WHERE exp < ?", args: [now] }).catch(() => {});
};

export const handleAuth = async (action: string, req: Request, B: any): Promise<Response | null> => {
  if (action === "keypair" && req.method === "GET") {
    const nonce = crypto.randomUUID();
    nonces.set(nonce, Date.now() + 60_000);
    return ok({ nonce });
  }

  if (action === "keypair" && req.method === "POST") {
    const { pubkey, nonce, signature } = B;
    if (!pubkey || !nonce || !signature) return err("pubkey, nonce and signature required");
    const exp = nonces.get(nonce);
    if (!exp || exp < Date.now()) return err("Invalid or expired nonce", 401);
    nonces.delete(nonce);
    let valid = false;
    try {
      const key = await importPubKey(pubkey);
      const sig = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
      valid = await crypto.subtle.verify("Ed25519", key, sig, new TextEncoder().encode(nonce));
    } catch { return err("Invalid signature", 401); }
    if (!valid) return err("Signature verification failed", 401);
    const now = new Date().toISOString();
    let users = await getRows("_users", `pubkey = '${esc(pubkey)}'`);
    let u = users[0];
    if (!u) {
      u = { id: crypto.randomUUID(), email: "", pw: "", pubkey, role: "authenticated", meta: "{}", app_meta: "{}", created: now, updated: now, last_sign_in: now };
      await dbInsert("_users", u);
      const hookErr = await fireHook("onSignup", makeUser(u));
      if (hookErr) return err(hookErr, 400);
    } else {
      await dbUpdate("_users", { last_sign_in: now, updated: now }, `id = '${esc(u.id)}'`);
      u = { ...u, last_sign_in: now, updated: now };
    }
    const { token, refresh, exp: sExp } = await issueSession(u.id);
    const user = makeUser(u);
    await fireHook("onSignin", user);
    return ok({ user, session: makeSession(token, refresh, sExp, user) });
  }

  if (action === "signup") {
    if (!B.email || !B.password) return err("Email & password required");
    const emailLower = B.email.toLowerCase();
    if ((await getRows("_users", `email = '${esc(emailLower)}'`)).length) return err("User already registered", 400, "Check if user already exists");
    const now = new Date().toISOString();
    const u = { id: crypto.randomUUID(), email: emailLower, pw: await Bun.password.hash(B.password), pubkey: "", role: "authenticated", meta: JSON.stringify(B.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now };
    await dbInsert("_users", u);
    const signupHookErr = await fireHook("onSignup", makeUser(u));
    if (signupHookErr) return err(signupHookErr, 400);
    return ok({ user: makeUser(u), session: null });
  }

  if (action === "token") {
    const emailLower = (B.email || "").toLowerCase();
    const users = await getRows("_users", `email = '${esc(emailLower)}'`);
    const u = users[0];
    if (!u || !await Bun.password.verify(B.password || "", u.pw)) return err("Invalid login credentials", 400);
    const now = new Date().toISOString();
    await dbUpdate("_users", { last_sign_in: now, updated: now }, `id = '${esc(u.id)}'`);
    const { token, refresh, exp } = await issueSession(u.id);
    const user = makeUser({ ...u, last_sign_in: now, updated: now });
    await fireHook("onSignin", user);
    return ok({ user, session: makeSession(token, refresh, exp, user) });
  }

  if (action === "user") {
    const user = await getUser(req);
    if (!user) return err("Not authenticated", 401);
    return ok({ user });
  }

  if (action === "update") {
    const user = await getUser(req);
    if (!user) return err("Not authenticated", 401);
    const existing = await getRows("_users", `id = '${esc(user.id)}'`);
    const u = existing[0];
    if (!u) return err("User not found", 404);
    const now = new Date().toISOString();
    const newEmail = B.email ? B.email.toLowerCase() : u.email;
    if (B.email && newEmail !== u.email) {
      const taken = await getRows("_users", `email = '${esc(newEmail)}'`);
      if (taken.length) return err("Email already in use", 400);
      const emailHookErr = await fireHook("onEmailChange", makeUser(u), newEmail);
      if (emailHookErr) return err(emailHookErr, 400);
    }
    const merged = { email: newEmail, pw: B.password ? await Bun.password.hash(B.password) : u.pw, meta: JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...(B.data || {}) }), app_meta: JSON.stringify({ ...JSON.parse(u.app_meta || "{}"), ...(B.app_metadata || {}) }), updated: now };
    await dbUpdate("_users", merged, `id = '${esc(u.id)}'`);
    return ok({ user: makeUser({ ...u, ...merged }) });
  }

  if (action === "logout") {
    const token = req.headers.get("Authorization")?.split(" ")[1];
    if (token) await dbDelete("_sessions", `token = '${esc(token)}'`).catch(() => {});
    return ok({});
  }

  if (action === "recover") {
    const email = (B.email || "").toLowerCase();
    if (!email) return err("Email required");
    const users = await getRows("_users", `email = '${esc(email)}'`);
    if (users[0]) {
      const resetToken = crypto.randomUUID();
      resetTokens.set(resetToken, { uid: users[0].id, exp: Date.now() + 60 * 60_000 });
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
      if (!entry || entry.exp < Date.now()) return err("Invalid or expired token", 401);
      if (!password) return err("New password required");
      resetTokens.delete(token);
      const users = await getRows("_users", `id = '${esc(entry.uid)}'`);
      const u = users[0];
      if (!u) return err("User not found", 404);
      const now = new Date().toISOString();
      await dbUpdate("_users", { pw: await Bun.password.hash(password), updated: now }, `id = '${esc(u.id)}'`);
      const { token: access, refresh, exp } = await issueSession(u.id);
      return ok({ user: makeUser({ ...u, updated: now }), session: makeSession(access, refresh, exp, makeUser({ ...u, updated: now })) });
    }
    return err("Invalid verification type", 400);
  }

  return null;
};
