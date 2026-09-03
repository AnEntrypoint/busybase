#!/usr/bin/env bun
const suites = [
  { name: "Embedded Mode", file: "tests/embedded.ts", env: {} },
  { name: "Hooks Integration", file: "tests/hooks.ts", env: {} },
  { name: "Security (SQL Injection)", file: "tests/security.ts", env: { BUSYBASE_PORT: "54601", BUSYBASE_DIR: `/tmp/bb_test_sec_${Date.now()}` } },
  { name: "Auth Edge Cases", file: "tests/auth-edge-cases.ts", env: {} },
  { name: "REST Edge Cases", file: "tests/rest-edge-cases.ts", env: {} },
  { name: "Realtime Edge Cases", file: "tests/realtime-edge-cases.ts", env: {} },
  { name: "Server Routes", file: "tests/server-routes.ts", env: {} },
  { name: "SDK Edge Cases", file: "tests/sdk-edge-cases.ts", env: {} },
];
let totalPass = 0, totalFail = 0, suiteResults: { name: string; pass: boolean; output: string }[] = [];
for (const suite of suites) {
  console.log(`\n${"=".repeat(60)}\n  Running: ${suite.name}\n${"=".repeat(60)}`);
  const proc = Bun.spawn(["bun", "run", suite.file], {
    cwd: "/home/user/busybase", env: { ...process.env, ...suite.env }, stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  console.log(out);
  if (err && exitCode !== 0) console.error(err);
  const passMatch = out.match(/(\d+)\s*passed/);
  const failMatch = out.match(/(\d+)\s*failed/);
  const p = passMatch ? parseInt(passMatch[1]) : 0;
  const f = failMatch ? parseInt(failMatch[1]) : 0;
  totalPass += p; totalFail += f;
  suiteResults.push({ name: suite.name, pass: exitCode === 0, output: `${p} passed, ${f} failed` });
}
console.log(`\n${"=".repeat(60)}\n  COMBINED RESULTS\n${"=".repeat(60)}`);
for (const r of suiteResults) console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}: ${r.output}`);
console.log(`\n  TOTAL: ${totalPass} passed, ${totalFail} failed\n${"=".repeat(60)}`);
if (totalFail > 0) process.exit(1);
