import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

const parent = join(tmpdir(), "redskilled-test-host");
const root = join(parent, String(process.pid));

mkdirSync(root, { recursive: true });
reapDeadSandboxes(parent);

const isolatedEnvironment = {
  HOME: join(root, "home"),
  XDG_RUNTIME_DIR: join(root, "runtime"),
  REDSKILLED_MACHINE_DIR: join(root, "machine"),
  REDSKILLED_TEST_HOST_ROOT: root,
} as const;

// Every line above isolates a PATH. Unit discovery isolates none of them: a
// booting daemon asks the user's systemd for `red-worker-*` units, and systemd
// has never heard of HOME. So a sandboxed daemon adopted the operator's REAL
// Workers and counted them against budgets the tests had just declared — 77 of
// 859 failing on a developer machine that happened to be draining a queue in
// another checkout, and passing on an idle one.
//
// So the sandbox does not sweep by default. It sits OUTSIDE the pinned set
// above because it is a feature switch rather than an identity: the suites that
// test the sweep must be able to ask for it back, and `assertIsolatedHostIdentity`
// would call that legitimate opt-in an escape.
process.env.REDSKILLED_UNIT_DISCOVERY = "off";

/**
 * Let THIS suite sweep the host, for the suites whose subject is the sweep.
 *
 * The reaper and the WSL2 census cannot be tested with discovery off — it is the
 * behaviour under test, so the safe default would silently assert that finding
 * nothing is finding nothing. Such a suite must supply its own process fixtures
 * and never let a verdict rest on what this machine happens to be running.
 *
 * Call it at module scope, before the daemon under test is spawned: a child
 * inherits the environment as it stood at spawn, not as it stands at assertion.
 */
export function permitUnitDiscoveryForThisSuite(): void {
  delete process.env.REDSKILLED_UNIT_DISCOVERY;
}

Object.assign(process.env, isolatedEnvironment);
mkdirSync(isolatedEnvironment.HOME, { recursive: true });
mkdirSync(isolatedEnvironment.XDG_RUNTIME_DIR, { recursive: true });
mkdirSync(isolatedEnvironment.REDSKILLED_MACHINE_DIR, { recursive: true });

export function assertIsolatedHostIdentity(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, expected] of Object.entries(isolatedEnvironment)) {
    if (env[name] !== expected) {
      throw new Error(
        `redskilled test host identity escaped its sandbox: ${name} must remain pinned for every test`,
      );
    }
  }
}

beforeEach(() => assertIsolatedHostIdentity());
afterEach(() => assertIsolatedHostIdentity());

process.on("exit", () => {
  rmSync(root, { recursive: true, force: true });
});

function reapDeadSandboxes(sandboxParent: string): void {
  let entries: string[];
  try {
    entries = readdirSync(sandboxParent);
  } catch {
    return;
  }
  for (const entry of entries) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid)) continue;
    rmSync(join(sandboxParent, entry), { recursive: true, force: true });
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
