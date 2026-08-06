// BusyBase hooks — set BUSYBASE_HOOKS=./my-hooks.ts to load your file
// Every hook is optional. Return { error: string } from any hook to abort the operation.

export interface HookUser {
  id: string; email: string | null; role: string;
  user_metadata: Record<string, any>; app_metadata: Record<string, any>;
  created_at: string;
}

export interface Hooks {
  // --- Auth lifecycle ---
  onSignup?:        (user: HookUser) => any;
  onSignin?:        (user: HookUser) => any;
  onSignout?:       (user: HookUser) => any;
  onEmailChange?:   (user: HookUser, newEmail: string) => any;
  onPasswordReset?: (email: string, token: string) => any;
  onUserUpdate?:    (user: HookUser, changes: Record<string, any>) => any;

  // --- Request middleware: runs before every request ---
  // Return a Response to short-circuit, or void to continue
  onRequest?: (req: Request) => Response | void | Promise<Response | void>;

  // --- Row-level middleware ---
  // fireHook: return { error } string to abort, or void to pass through
  // pipeHook: return modified value (rows/params) or void to pass through unchanged
  // Calling convention: pipeHook(name, value, table) → fn(value, table)
  beforeInsert?: (table: string, rows: any[]) => any;
  afterInsert?:  (rows: any[], table: string) => any;
  beforeUpdate?: (table: string, rows: any[], changes: any) => any;
  afterUpdate?:  (rows: any[], table: string) => any;
  beforeDelete?: (table: string, rows: any[]) => any;
  afterDelete?:  (table: string, rows: any[]) => any;
  beforeSelect?: (params: Record<string, string>, table: string) => any;
  afterSelect?:  (rows: any[], table: string) => any;

  // --- Email: override built-in SMTP entirely ---
  sendEmail?: (opts: { to: string; subject: string; html: string; text?: string }) => any;

  // --- Token/session customization ---
  // Return custom payload to merge into session
  onIssueSession?: (user: HookUser) => Record<string, any> | void | Promise<Record<string, any> | void>;

  // --- Role/permission check: return false or { error } to deny ---
  canAccess?: (opts: { user: HookUser | null; table: string; method: string }) => any;
}

// --- Built-in SMTP (Bun TCP, zero deps) ---
// Env: BUSYBASE_SMTP_HOST, BUSYBASE_SMTP_PORT (587), BUSYBASE_SMTP_USER, BUSYBASE_SMTP_PASS, BUSYBASE_SMTP_FROM
const smtpHost = process.env.BUSYBASE_SMTP_HOST;
const smtpPort = parseInt(process.env.BUSYBASE_SMTP_PORT || "587");
const smtpUser = process.env.BUSYBASE_SMTP_USER || "";
const smtpPass = process.env.BUSYBASE_SMTP_PASS || "";
const smtpFrom = process.env.BUSYBASE_SMTP_FROM || smtpUser;
const b64e = (s: string) => Buffer.from(s).toString("base64");

const smtpSend = async (to: string, subject: string, html: string) => {
  if (!smtpHost) return false;
  let buffer = "";
  let notify: (() => void) | null = null;
  const useTls = smtpPort === 465;
  const isTerminalReplyLine = (line: string | undefined): boolean => !!line && /^\d{3} /.test(line);
  const isMultiLineReplyComplete = (buf: string): boolean => {
    const lines = buf.split("\r\n").filter(Boolean);
    return isTerminalReplyLine(lines[lines.length - 1]);
  };
  const conn = await Bun.connect({
    hostname: smtpHost, port: smtpPort, tls: useTls,
    socket: {
      open() {},
      data(_s, d) { buffer += d.toString(); if (isMultiLineReplyComplete(buffer)) notify?.(); },
      error(_s, e) { console.error("[SMTP]", e); },
      close() {},
    },
  });
  const send = (l: string) => conn.write(l + "\r\n");
  const wait = (label: string): Promise<string[]> => new Promise((resolve, reject) => {
    buffer = "";
    notify = () => resolve(buffer.split("\r\n").filter(Boolean));
    setTimeout(() => reject(new Error(`SMTP ${label} timed out waiting for a complete reply: ${JSON.stringify(buffer)}`)), 15000);
  });
  const expectOk = async (label: string) => {
    const lines = await wait(label);
    const code = parseInt(lines[lines.length - 1]?.slice(0, 3) || "0");
    if (code >= 400 || code === 0) throw new Error(`SMTP ${label} failed: ${lines.join(" ") || "no response"}`);
  };
  try {
    await expectOk("connect");
    send("EHLO busybase"); await expectOk("EHLO");
    send("AUTH LOGIN"); await expectOk("AUTH LOGIN");
    send(b64e(smtpUser)); await expectOk("AUTH username");
    send(b64e(smtpPass)); await expectOk("AUTH password");
    send(`MAIL FROM:<${smtpFrom}>`); await expectOk("MAIL FROM");
    send(`RCPT TO:<${to}>`); await expectOk("RCPT TO");
    send("DATA"); await expectOk("DATA");
    send(`From: ${smtpFrom}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n.`);
    await expectOk("message body");
    send("QUIT");
  } finally { conn.end(); }
  return true;
};

// --- Load user hooks file ---
const hooksFile = process.env.BUSYBASE_HOOKS;
let userHooks: Hooks = {};
if (hooksFile) {
  try {
    userHooks = await import(hooksFile.startsWith(".") ? Bun.resolveSync(hooksFile, process.cwd()) : hooksFile);
    console.log(`[BusyBase] Hooks loaded: ${hooksFile}`);
  } catch (e) { console.warn(`[BusyBase] Could not load hooks file: ${hooksFile}`, e); }
}

export const hooks: Hooks = userHooks;

// Fire a hook against an explicit Hooks object -- returns error string if aborted, null otherwise.
export const fireHookOn = async <K extends keyof Hooks>(h: Hooks, name: K, ...args: Parameters<NonNullable<Hooks[K]>>): Promise<string | null> => {
  const fn = h[name] as ((...a: any[]) => any) | undefined;
  if (!fn) return null;
  try {
    const r = await fn(...args);
    if (r === false) return "Access denied";
    if (r && typeof r === "object" && typeof r.error === "string") return r.error;
  } catch (e: any) {
    console.error(`[BusyBase] Hook "${String(name)}" threw:`, e);
    return "Internal error";
  }
  return null;
};

// Fire a hook against an explicit Hooks object, transforming its input -- returns (possibly modified) value.
export const pipeHookOn = async <K extends keyof Hooks>(h: Hooks, name: K, value: any, ...args: any[]): Promise<any> => {
  const fn = h[name] as ((...a: any[]) => any) | undefined;
  if (!fn) return value;
  try {
    const r = await fn(value, ...args);
    if (r && typeof r === "object" && !r.error) return r;
  } catch {}
  return value;
};

// Convenience wrappers bound to the module-level singleton (HTTP server path).
export const fireHook = <K extends keyof Hooks>(name: K, ...args: Parameters<NonNullable<Hooks[K]>>) => fireHookOn(hooks, name, ...args);
export const pipeHook = <K extends keyof Hooks>(name: K, value: any, ...args: any[]) => pipeHookOn(hooks, name, value, ...args);

// Email: try user hook first, fall back to SMTP
export const sendEmailOn = async (h: Hooks, to: string, subject: string, html: string, text = "") => {
  if (h.sendEmail) { await h.sendEmail({ to, subject, html, text }); return; }
  try {
    const sent = await smtpSend(to, subject, html);
    if (!sent) console.log(`[BusyBase] No email transport configured. Would send to ${to}: ${subject}`);
  } catch (e) {
    console.error(`[BusyBase] Failed to send email to ${to}:`, e);
  }
};

export const sendEmail = (to: string, subject: string, html: string, text = "") => sendEmailOn(hooks, to, subject, html, text);
