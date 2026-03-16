import { fireHook, sendEmail, hooks } from "./hooks.ts";
import { Z, SENTINEL, esc, openTbl, mkTbl, getRows, makeUser, makeSession, issueSession, ok, err, getUser } from "./db.ts";

const nonces = new Map<string, number>();
const resetTokens = new Map<string, { uid: string; exp: number }>();

const importPubKey = (b64: string) =>
  crypto.subtle.importKey("raw", Uint8Array.from(atob(b64), c => c.charCodeAt(0)), { name: "Ed25519" }, false, ["verify"]);

export const initAuthTables = async () => {
  if (!(await openTbl("_users")))
    await mkTbl("_users", [{ id: SENTINEL, email: SENTINEL, pw: "", pubkey: "", role: "authenticated", meta: "{}", app_meta: "{}", created: "", updated: "", last_sign_in: "", vector: Z }]);
  if (!(await openTbl("_sessions")))
    await mkTbl("_sessions", [{ token: SENTINEL, refresh: SENTINEL, uid: "", exp: 0, vector: Z }]);
};

export const sweepExpired = async () => {
  const now = Date.now();
  for (const [k, exp] of nonces) if (exp < now) nonces.delete(k);
  for (const [k, v] of resetTokens) if (v.exp < now) resetTokens.delete(k);
  const st = await openTbl("_sessions");
  if (st) {
    const expired = (await st.filter(`exp < ${now} AND token != '${SENTINEL}'`).execute() as any[]).catch?.(() => []) ?? await st.filter(`exp < ${now} AND token != '${SENTINEL}'`).execute().catch(() => []);
    for (const s of (expired as any[])) { try { await st.delete(`token = '${esc(s.token)}'`); } catch {} }
  }
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
    const ut = (await openTbl("_users"))!;
    if (!u) {
      u = { id: crypto.randomUUID(), email: "", pw: "", pubkey, role: "authenticated", meta: "{}", app_meta: "{}", created: now, updated: now, last_sign_in: now, vector: Z };
      await ut.add([u]);
      const hookErr = await fireHook("onSignup", makeUser(u));
      if (hookErr) return err(hookErr, 400);
    } else {
      await ut.delete(`id = '${esc(u.id)}'`);
      u = { ...u, last_sign_in: now, updated: now };
      await ut.add([u]);
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
    const u = { id: crypto.randomUUID(), email: emailLower, pw: await Bun.password.hash(B.password), pubkey: "", role: "authenticated", meta: JSON.stringify(B.data || {}), app_meta: "{}", created: now, updated: now, last_sign_in: now, vector: Z };
    await (await openTbl("_users"))!.add([u]);
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
    const ut = (await openTbl("_users"))!;
    await ut.delete(`id = '${esc(u.id)}'`);
    await ut.add([{ ...u, last_sign_in: now, updated: now }]);
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
    const merged = { ...u, email: newEmail, pw: B.password ? await Bun.password.hash(B.password) : u.pw, meta: JSON.stringify({ ...JSON.parse(u.meta || "{}"), ...(B.data || {}) }), app_meta: JSON.stringify({ ...JSON.parse(u.app_meta || "{}"), ...(B.app_metadata || {}) }), updated: now };
    const ut = (await openTbl("_users"))!;
    await ut.delete(`id = '${esc(u.id)}'`);
    await ut.add([merged]);
    return ok({ user: makeUser(merged) });
  }

  if (action === "logout") {
    const token = req.headers.get("Authorization")?.split(" ")[1];
    if (token) { const st = await openTbl("_sessions"); if (st) await st.delete(`token = '${esc(token)}'`); }
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
      const ut = (await openTbl("_users"))!;
      const users = await getRows("_users", `id = '${esc(entry.uid)}'`);
      const u = users[0];
      if (!u) return err("User not found", 404);
      const now = new Date().toISOString();
      await ut.delete(`id = '${esc(u.id)}'`);
      await ut.add([{ ...u, pw: await Bun.password.hash(password), updated: now }]);
      const { token: access, refresh, exp } = await issueSession(u.id);
      return ok({ user: makeUser({ ...u, updated: now }), session: makeSession(access, refresh, exp, makeUser({ ...u, updated: now })) });
    }
    return err("Invalid verification type", 400);
  }

  return null;
};
