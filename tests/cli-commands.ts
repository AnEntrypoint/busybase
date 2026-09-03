/**
 * CLI command tests.
 * Spawns `bun run src/cli.ts <command> <args>` as subprocesses and checks stdout/stderr/exitCode.
 * Starts a dedicated server on port 54510.
 */

const PORT = 54510;
const BASE = `http://localhost:${PORT}`;
const DIR = `/tmp/bb_cli_test_${Date.now()}`;
let passed = 0;
let failed = 0;

function assert(ok: boolean, name: string, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

async function startServer() {
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: "/home/user/busybase",
    env: { ...process.env, BUSYBASE_DIR: DIR, BUSYBASE_PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`${BASE}/studio/config`);
      return proc;
    } catch {
      await Bun.sleep(150);
    }
  }
  throw new Error("Server did not start");
}

async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: "/home/user/busybase",
    env: {
      ...process.env,
      BUSYBASE_URL: BASE,
      BUSYBASE_PORT: String(PORT),
      BUSYBASE_KEY: "local",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function run() {
  const serverProc = await startServer();
  console.log("Server ready. Running CLI command tests...\n");

  // 1. signup
  console.log("[signup]");
  {
    const r = await runCli("signup", "test@test.com", "pass123");
    assert(r.exitCode === 0, "signup exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("id"), "signup stdout contains user id", r.stdout.slice(0, 200));
  }

  // 2. signin
  console.log("\n[signin]");
  {
    const r = await runCli("signin", "test@test.com", "pass123");
    assert(r.exitCode === 0, "signin exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("access_token"), "signin stdout contains access_token", r.stdout.slice(0, 200));
  }

  // 3. user (no persisted session between CLI invocations)
  console.log("\n[user]");
  {
    const r = await runCli("user");
    assert(r.exitCode === 0, "user exits 0 (handles gracefully)", `exitCode=${r.exitCode}, stderr=${r.stderr.slice(0, 200)}`);
  }

  // 4. insert
  console.log("\n[insert]");
  {
    const r = await runCli("insert", "mytable", '{"name":"alice","score":"10"}');
    assert(r.exitCode === 0, "insert exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("alice"), "insert stdout contains alice", r.stdout.slice(0, 200));
  }

  // 5. query mytable
  console.log("\n[query mytable]");
  {
    const r = await runCli("query", "mytable");
    assert(r.exitCode === 0, "query exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("alice"), "query stdout contains alice", r.stdout.slice(0, 200));
  }

  // 6. query mytable with filter
  console.log("\n[query mytable name=alice]");
  {
    const r = await runCli("query", "mytable", "name=alice");
    assert(r.exitCode === 0, "query with filter exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("alice"), "query with filter stdout contains alice", r.stdout.slice(0, 200));
  }

  // 7. update
  console.log("\n[update]");
  {
    const r = await runCli("update", "mytable", '{"score":"99"}', "name=alice");
    assert(r.exitCode === 0, "update exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("99"), "update stdout contains 99", r.stdout.slice(0, 200));
  }

  // 8. delete
  console.log("\n[delete]");
  {
    const r = await runCli("delete", "mytable", "name=alice");
    assert(r.exitCode === 0, "delete exits 0", `exitCode=${r.exitCode}`);
  }

  // 9. query after delete — alice is gone
  console.log("\n[query after delete]");
  {
    const r = await runCli("query", "mytable");
    assert(r.exitCode === 0, "query after delete exits 0", `exitCode=${r.exitCode}`);
    assert(!r.stdout.includes("alice"), "query after delete alice is gone", r.stdout.slice(0, 200));
  }

  // 10. insert no args — exits 1, stderr contains Usage
  console.log("\n[insert no args]");
  {
    const r = await runCli("insert");
    assert(r.exitCode === 1, "insert no args exits 1", `exitCode=${r.exitCode}`);
    assert(r.stderr.includes("Usage"), "insert no args stderr contains Usage", r.stderr.slice(0, 200));
  }

  // 11. signup no args — exits 1, stderr contains Usage
  console.log("\n[signup no args]");
  {
    const r = await runCli("signup");
    assert(r.exitCode === 1, "signup no args exits 1", `exitCode=${r.exitCode}`);
    assert(r.stderr.includes("Usage"), "signup no args stderr contains Usage", r.stderr.slice(0, 200));
  }

  // 12. nonexistent command — exits 0, shows help text
  console.log("\n[nonexistent command]");
  {
    const r = await runCli("nonexistent");
    assert(r.exitCode === 0, "nonexistent command exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("Commands:"), "nonexistent command shows help text", r.stdout.slice(0, 200));
  }

  // 13. no command — exits 0, shows help text
  console.log("\n[no command]");
  {
    const r = await runCli();
    assert(r.exitCode === 0, "no command exits 0", `exitCode=${r.exitCode}`);
    assert(r.stdout.includes("Commands:"), "no command shows help text", r.stdout.slice(0, 200));
  }

  // Cleanup
  serverProc.kill();
  await serverProc.exited;

  console.log(`\n${"=".repeat(40)}`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
