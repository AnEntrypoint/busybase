// Optional text-embedding generation via gm's shared `bert` WASM plugin
// (BAAI/bge-small-en-v1.5, 384-dim, L2-normalized), dispatched through the
// same exec-spool file protocol gm's own tooling uses
// (.gm/exec-spool/in/bert/<task>.txt -> .gm/exec-spool/out/bert-<task>.json).
//
// This never hard-fails: if gm isn't installed, or this project isn't
// registered with the shared daemon yet, or the daemon doesn't answer in
// time, embedText/embedBatch resolve to null rather than throwing or
// hanging. That keeps it safe to call from a hook without risking the
// request it's attached to. Callers who want embeddings to be mandatory
// should check for null themselves and return { error } from their hook.
//
// Registering with the daemon (so its `bert` plugin pool actually serves
// this project) also buys cross-project rate limiting for free: `bert` is
// one of gm's STATELESS_SHARED_PLUGIN_NAMES, so every registered project's
// embed calls queue through the same machine-wide, concurrency-capped pool
// instead of each project spinning up its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, watch, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const RUNNER_PATH = join(homedir(), ".gm-tools", platform() === "win32" ? "agentplug-runner.exe" : "agentplug-runner");
const SESSION_ID = `busybase-${process.pid}-${Date.now()}`;
let taskCounter = 0;
let lastEnsuredAt = 0;
const ENSURE_INTERVAL_MS = 15_000;

const spoolPaths = (root: string) => {
  const spoolDir = join(root, ".gm", "exec-spool");
  return { inDir: join(spoolDir, "in", "bert"), outDir: join(spoolDir, "out"), spoolDir };
};

const ensureRunnerRunning = (root: string) => {
  if (!existsSync(RUNNER_PATH)) return false;
  const now = Date.now();
  if (now - lastEnsuredAt < ENSURE_INTERVAL_MS) return true;
  lastEnsuredAt = now;
  try {
    const child = spawn(RUNNER_PATH, ["spool"], {
      cwd: root,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root },
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
  return true;
};

const writeAtomic = (inDir: string, inPath: string, body: string) => {
  mkdirSync(inDir, { recursive: true });
  const tmpPath = join(inDir, `.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmpPath, body, "utf8");
  renameSync(tmpPath, inPath);
};

const waitForOut = (outDir: string, outPath: string, timeoutMs: number): Promise<boolean> =>
  new Promise(resolve => {
    if (existsSync(outPath)) return resolve(true);
    let settled = false;
    let watcher: ReturnType<typeof watch> | undefined;
    const finish = (found: boolean) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      clearTimeout(deadline);
      clearInterval(fallback);
      resolve(found);
    };
    try {
      watcher = watch(outDir, { persistent: false }, (_e, filename) => {
        if (!filename || filename.toString() === outPath.slice(outDir.length + 1)) finish(existsSync(outPath));
      });
    } catch {}
    const fallback = setInterval(() => { if (existsSync(outPath)) finish(true); }, 200);
    const deadline = setTimeout(() => finish(existsSync(outPath)), timeoutMs);
  });

type BertResponse = { ok: true; embedding?: number[]; embeddings?: number[][]; dim?: number } | { ok: false; error?: string };

const dispatchBert = async (body: Record<string, unknown>, root: string, timeoutMs: number): Promise<BertResponse | null> => {
  if (!ensureRunnerRunning(root)) return null; // gm not installed -- silent no-op, never a hard failure
  taskCounter += 1;
  const task = `${SESSION_ID}-${taskCounter}`;
  const { inDir, outDir } = spoolPaths(root);
  const inPath = join(inDir, `${task}.txt`);
  const outPath = join(outDir, `bert-${task}.json`);
  mkdirSync(outDir, { recursive: true });
  writeAtomic(inDir, inPath, JSON.stringify({ ...body, session_id: SESSION_ID }));
  const landed = await waitForOut(outDir, outPath, timeoutMs);
  if (!landed) return null;
  try {
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    return (parsed?.data ?? parsed) as BertResponse;
  } catch {
    return null;
  } finally {
    try { unlinkSync(outPath); } catch {}
  }
};

export interface EmbedOptions {
  /** Project root registered with the daemon; defaults to process.cwd(). */
  root?: string;
  /** "query" applies the BGE query prefix; anything else embeds as plain text. */
  kind?: "query" | "passage";
  /** Give up and return null after this long (ms). Default 30000. */
  timeoutMs?: number;
}

/** Embeds one string. Resolves to null if gm/the daemon is unavailable, the request times out, or the plugin reports failure -- never throws. */
export const embedText = async (text: string, opts: EmbedOptions = {}): Promise<number[] | null> => {
  if (!text || !text.trim()) return null;
  const res = await dispatchBert({ verb: "embed", text, kind: opts.kind }, opts.root || process.cwd(), opts.timeoutMs ?? 30_000);
  return res && res.ok && Array.isArray(res.embedding) ? res.embedding : null;
};

/** Batched form of embedText. Resolves to null (not an array of nulls) if the whole dispatch fails. */
export const embedBatch = async (texts: string[], opts: EmbedOptions = {}): Promise<number[][] | null> => {
  const nonEmpty = texts.filter(t => t && t.trim());
  if (!nonEmpty.length) return null;
  const res = await dispatchBert({ verb: "embed_batch", texts: nonEmpty }, opts.root || process.cwd(), opts.timeoutMs ?? 60_000);
  return res && res.ok && Array.isArray(res.embeddings) ? res.embeddings : null;
};
