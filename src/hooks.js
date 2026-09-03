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
export {
  fireHook,
  hooks,
  pipeHook,
  sendEmail
};
