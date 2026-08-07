// `renewed_at` must advance while the daemon runs — #3092.
//
// The lease shipped with a `renew()` and ZERO callers, so after five hours of
// continuous, working uptime the record still read `renewed_at == acquired_at`.
// A field nothing advances is worse than no field at all: it invites exactly the
// freshness check that would then be permanently wrong about a healthy host.
//
// The first check is the behaviour; the second is the wiring. Both are here
// because the wiring is what regressed — a mechanism designed on one side and
// called from nowhere reads as present in review and is absent in production,
// the same shape as #3079's heartbeat publisher and #3081's dropped launch env.
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { readRedskilledLeaseFile } from "../src/session-lease.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-renew-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

describe("the redskilled session lease is renewed while the daemon serves", () => {
  it("advances renewed_at past acquired_at on its own tick", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000, leaseRenewMs: 20 });
    running.push(daemon);

    const acquired = await readRedskilledLeaseFile(paths.leasePath);
    expect(acquired?.renewed_at).toBe(acquired?.acquired_at);

    const deadline = Date.now() + 5_000;
    let renewed = acquired;
    while (Date.now() < deadline && renewed?.renewed_at === acquired?.acquired_at) {
      await new Promise((r) => setTimeout(r, 25));
      renewed = await readRedskilledLeaseFile(paths.leasePath);
    }

    expect(renewed?.renewed_at).not.toBe(acquired?.acquired_at);
    expect(Date.parse(renewed?.renewed_at ?? "")).toBeGreaterThan(Date.parse(acquired?.acquired_at ?? ""));
    // Everything that identifies the holder survives the rewrite: a renewal that
    // moved the pid would hand the session to a process that never took it.
    expect(renewed?.pid).toBe(acquired?.pid);
    expect(renewed?.acquired_at).toBe(acquired?.acquired_at);
    expect(renewed?.socket_path).toBe(paths.socketPath);
  }, 30_000);

  it("keeps `.renew()` wired — a mechanism with zero callers is a mechanism that is off", async () => {
    // Reads the IMPLEMENTATION, not the façade: `daemon.ts` re-exports `./daemon/*`,
    // so grepping it for a call site finds only forwarding.
    const daemonSource = await readFile(resolve(__dirname, "..", "src", "daemon", "lifecycle.ts"), "utf8");
    // Named at the call site, not merely defined: this is the exact grep that came
    // back empty in #3092 while the field it feeds sat five hours stale.
    expect(daemonSource).toMatch(/leaseStore\.renew\(/);
    expect(daemonSource).toMatch(/armLeaseTimer\(\)/);
  });

  it("leaves the renewer unarmed when the window is zero, and still serves", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000, leaseRenewMs: 0 });
    running.push(daemon);

    await new Promise((r) => setTimeout(r, 60));
    const held = await readRedskilledLeaseFile(paths.leasePath);
    expect(held?.renewed_at).toBe(held?.acquired_at);
    // And the explicit drive still works, which is what the timer calls.
    expect((await daemon.renewLease())?.renewed_at).not.toBe(held?.acquired_at);
  }, 30_000);
});
