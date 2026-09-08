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
export {
  fireHook,
  fireHookOn,
  hooks,
  pipeHook,
  pipeHookOn,
  sendEmail,
  sendEmailOn
};
