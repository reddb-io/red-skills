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
