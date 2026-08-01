/**
 * redskilled-isolation — "no daemon" is a fact about the SANDBOX, never about
 * the developer's machine (#2981, the rule #2884 established for the canary).
 *
 * A test that asserts a refusal from an absent daemon has to own the absence.
 * Resolved from the ambient environment, `resolveRedskilledPaths()` lands on the
 * operator's real socket, so `project_start` succeeded with `status: registered`
 * on every host that runs a daemon and the refusal assertion went red on
 * untouched code. Three files had already pinned their own scope by hand — the
 * canary sandbox, the MCP contract fixture, and redskilled's own offline
 * `--help` suite — which is three spellings of one boundary and a fourth waiting
 * to be forgotten. This module is the boundary for THIS package: imported once
 * as its vitest setup file, so every test in the suite inherits it and no new
 * one has to remember it. The canary's sandbox stays as it is — it pins the
 * environment of the child processes it launches, which no setup file can do.
 *
 * Four pins, and each closes a different way to the operator's host:
 *
 * 1. `REDSKILLED_SESSION` — the scope itself. A key nothing else uses means the
 *    derived socket is one no daemon on this machine is listening on.
 * 2. `XDG_RUNTIME_DIR` — where that socket lives. Pinned so a suite does not
 *    deposit dead session directories in the operator's real runtime dir, which
 *    is the litter #2884 named.
 * 3. `REDSKILLED_MACHINE_DIR` — the machine claim. It lives in a SHARED
 *    directory by design, so an unpinned test reads the live claim of the
 *    operator's daemon and gets "the machine is held" instead of "nothing is
 *    there".
 * 4. `REDSKILLED_BIN` — the auto-spawn (ADR 0130 rule 7). Reaching a silent
 *    socket tries to START a daemon from the published bundle, so a host with a
 *    cached bundle would answer its own refusal test by launching the very
 *    daemon it is asserting the absence of. Pinned to a path that does not
 *    exist: the spawn fails immediately, by name, without a network fetch.
 *
 * Every pin is an environment variable rather than an injected parameter,
 * because the leak is in the DEFAULT derivation — a test that had to remember to
 * inject is a test that can forget.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Plugin roots the entry resolver probes for a bundle to spawn a daemon from. */
const PLUGIN_ROOT_ENV = [
  "RED_SKILLS_DEV_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "CODEX_PLUGIN_ROOT",
  "OPENCODE_PLUGIN_ROOT",
] as const;

/**
 * Pin this process's whole reach into `redskilled` inside one scratch directory.
 *
 * Returns the directory, so a caller can assert that a resolved socket is inside
 * it. Idempotent per process: the same pid pins the same root.
 */
export function pinIsolatedRedskilledHost(env: NodeJS.ProcessEnv = process.env): string {
  const parent = join(tmpdir(), "red-skills-test-host");
  const root = join(parent, String(process.pid));
  mkdirSync(root, { recursive: true });
  reapDeadSandboxes(parent);
  env.REDSKILLED_SESSION = `red-skills-test-host:${root}`;
  env.XDG_RUNTIME_DIR = join(root, "runtime");
  env.REDSKILLED_MACHINE_DIR = join(root, "machine");
  // Named for what it is, so the failure a spawn reports reads as the pin rather
  // than as a broken installation.
  env.REDSKILLED_BIN = join(root, "no-daemon-in-this-sandbox");
  for (const variable of PLUGIN_ROOT_ENV) delete env[variable];
  mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true });
  mkdirSync(env.REDSKILLED_MACHINE_DIR, { recursive: true });
  return root;
}

/**
 * Remove the sandboxes of processes that are gone.
 *
 * A sandbox that outlives its process is the litter the pin exists to avoid, and
 * the exit hook below is not enough on its own: a vitest worker is usually
 * SIGKILLed at the end of a run, which runs no hook — one suite left 362
 * directories behind before this reaper existed. Keyed on the pid being DEAD, so
 * a concurrent run's sandbox is never taken out from under it.
 */
function reapDeadSandboxes(parent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid)) continue;
    rmSync(join(parent, entry), { recursive: true, force: true });
  }
}

/** Signal 0: does this pid exist? `EPERM` means it does, under another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The scratch host this test process owns.
 *
 * Exported as a top-level constant on purpose: importing this module IS the pin,
 * which is what makes it usable as a vitest `setupFiles` entry.
 */
export const ISOLATED_REDSKILLED_HOST_ROOT = pinIsolatedRedskilledHost();

// The tidy exit, for the runs that get one.
process.on("exit", () => {
  rmSync(ISOLATED_REDSKILLED_HOST_ROOT, { recursive: true, force: true });
});
