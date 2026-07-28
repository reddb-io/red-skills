// ADR 0126, Spec #2651 slice 2: the cutover that made every rsp surface a client.
//
// surface-parity.test.ts proves the four headline surfaces agree on one core.
// This spec covers the two edges that cutover added: the pre-exec hook's own
// rewritten command line must land in the resident and open nothing of its own,
// and the surfaces the parity spec does not name — `wait` capture and the
// read-only dashboard/stats lane — must fail open the way the wrappers do.
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  buildBundleOnce,
  commitMany,
  countTrackedResidentProcesses,
  decode,
  expectWarmResident,
  extractHandle,
  initGitRepo,
  installRspShim,
  join,
  normalizedDurationMs,
  readFile,
  runBundleFromCwd,
  runBundleHookFromCwd,
  seedWarmRedCache,
  shellQuote,
  stat,
  testChildEnv,
  trackedResidentPaths,
  writeFile,
} from "./cli.helpers.js";

const HANDLE_SHAPE = /^el:[a-f0-9]{12}$/;
const HANDLE_ANYWHERE = /el:[a-f0-9]{12}/;

describe("rsp resident cutover (ADR 0126)", () => {
  it("runs the hook's own rewritten command line through the resident, opening no second store", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    // RSP_FAIL_IF_STORE_OPEN turns "this surface opened its own store" into a
    // hard failure, so a minted handle can only have come from the resident.
    // The heavy-output threshold is pinned low so the hook's plain rewrite —
    // which carries no loss flag — still reaches the elision path.
    const env = {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_FAIL_IF_STORE_OPEN: "1",
      RSP_HEAVY_GIT_BYTE_THRESHOLD: "1",
    };
    const setup = runBundleFromCwd(root, ["setup"], env);
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    await expectWarmResident(root, env);
    const proxyEnv = { ...env, PATH: await installRspShim(root) };

    // The hook is the real entry point: it hands the host a rewritten command.
    const hook = runBundleHookFromCwd(root, "git log", proxyEnv);
    expect(hook.status, hook.stderr.toString("utf8")).toBe(0);
    const rewritten = hookCommand(hook.stdout.toString("utf8"));
    expect(rewritten).toContain("proxy --");

    // Run exactly what the hook produced — no reconstruction, no shortcut.
    const routed = runHookCommand(root, rewritten, proxyEnv);
    expect(routed.status, `${routed.stdout.toString("utf8")}${routed.stderr.toString("utf8")}`).toBe(0);
    const handle = extractHandle(routed.stdout);
    expect(handle).toMatch(HANDLE_SHAPE);

    // The bytes are in the one store, recoverable through the read surface...
    const shown = runBundleFromCwd(root, ["show", handle], env);
    expect(shown.status, `${shown.stdout.toString("utf8")}${shown.stderr.toString("utf8")}`).toBe(0);
    expect(shown.stdout.length).toBeGreaterThan(routed.stdout.length);

    // ...and the dashboard, another reader, lists the same handle without
    // opening a store of its own.
    const dashboard = runBundleFromCwd(root, [], env);
    expect(dashboard.status, dashboard.stderr.toString("utf8")).toBe(0);
    expect(dashboard.stdout.toString("utf8")).toContain(handle);

    expect(await countTrackedResidentProcesses([root])).toBe(1);
  }, 180_000);

  it("fails open on the wait and dashboard surfaces when the resident socket is unreachable", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

    // The runtime socket directory hangs off XDG_RUNTIME_DIR, so pointing that
    // at a regular file means no surface can reach a resident or spawn one.
    const brokenXdg = join(root, "xdg-not-a-directory");
    await writeFile(brokenXdg, "not a directory\n", "utf8");
    const env = {
      RED_SKILLS_CACHE_DIR: cacheDir,
      XDG_RUNTIME_DIR: brokenXdg,
      RSP_FAIL_IF_STORE_OPEN: "1",
      RSP_RESIDENT_READY_TIMEOUT_MS: String(normalizedDurationMs(1_000)),
    };

    // wait cmd: the command's own exit code and bytes survive, no handle is
    // claimed that nothing could recover, and the spool keeps the originals.
    const script = "process.stdout.write('abcdefghijklmnopqrstuvwxyz'); process.exit(3)";
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
    const waited = runBundleFromCwd(root, ["wait", "cmd", "--json", "--capture-bytes", "5", "--", command], env);
    const result = JSON.parse(waited.stdout.toString("utf8")) as {
      verdict: {
        details: {
          status: number;
          stdout: { bytes: number; inline: string; handle?: string; recovery_error?: string; spool_path?: string };
        };
      };
    };
    expect(result.verdict.details.status).toBe(3);
    const captured = result.verdict.details.stdout;
    expect(captured).toMatchObject({ bytes: 26, inline: "abcde" });
    expect(captured.handle).toBeUndefined();
    expect(captured.recovery_error).toBeTruthy();
    expect(await readFile(captured.spool_path!, "utf8")).toBe("fghijklmnopqrstuvwxyz");

    // The readers degrade to an empty snapshot rather than to an error.
    const dashboard = runBundleFromCwd(root, [], env);
    expect(dashboard.status, dashboard.stderr.toString("utf8")).toBe(0);
    expect(decode(dashboard.stdout.toString("utf8"))).toMatchObject({
      recovery: { pending: 0 },
      store: { records: 0, bytes: 0 },
    });
    expect(dashboard.stdout.toString("utf8")).not.toMatch(HANDLE_ANYWHERE);

    const stats = runBundleFromCwd(root, ["stats", "--since", "7d"], env);
    expect(stats.status, stats.stderr.toString("utf8")).toBe(0);
    expect(decode(stats.stdout.toString("utf8"))).toMatchObject({ records: 0, savings: { empty: true } });

    await expect(stat(trackedResidentPaths(root).socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await countTrackedResidentProcesses([root])).toBe(0);
  }, 180_000);
});

function hookCommand(stdout: string): string {
  const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { updatedInput?: { command?: string } } };
  const command = parsed.hookSpecificOutput?.updatedInput?.command;
  expect(command, `hook emitted no rewritten command: ${stdout}`).toBeTruthy();
  return command!;
}

function runHookCommand(cwd: string, command: string, env: Record<string, string>) {
  return spawnSync(command, { cwd, shell: true, env: testChildEnv(env), encoding: "buffer" });
}
