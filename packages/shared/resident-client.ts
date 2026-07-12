import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RspResidentConfig, RspResidentRequest } from "./resident-protocol.js";
import { sendResidentRequest } from "./resident-protocol.js";

export interface RspResidentPaths {
  rootDir: string;
  socketPath: string;
  lockPath: string;
  wakeLockPath: string;
}

const UNIX_SOCKET_PATH_LIMIT = 108;

export function resolveResidentPaths(cwd: string): RspResidentPaths {
  const rootDir = findRepoRoot(cwd) ?? resolve(cwd);
  const socketDir = resolveRuntimeSocketDir(rootDir);
  return {
    rootDir,
    socketPath: join(socketDir, "rsp.sock"),
    lockPath: join(socketDir, "rsp.lock"),
    wakeLockPath: join(socketDir, "rsp.wake.lock"),
  };
}

/**
 * Generic client for the resident rsp server. Consumers outside the rsp app
 * (memory today, brain next) set `config.serverCommand` so an auto-start
 * spawns the rsp binary rather than re-executing the caller's own entrypoint.
 */
export class ResidentRspClient {
  constructor(
    private readonly paths: RspResidentPaths,
    private readonly config: RspResidentConfig,
  ) {}

  async request(request: ResidentRequestWithoutId): Promise<unknown> {
    await ensureResidentServer(this.paths, this.config);
    const response = await sendResidentRequest(this.paths, { ...request, id: randomUUID() } as RspResidentRequest);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }
}

export type ResidentRequestWithoutId = RspResidentRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

export async function ensureResidentServer(paths: RspResidentPaths, config: RspResidentConfig): Promise<void> {
  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  if (await pingResident(paths.socketPath)) return;

  const lock = await tryAcquireLock(paths.lockPath);
  if (lock) {
    try {
      if (await pingResident(paths.socketPath)) return;
      await removeUnresponsiveSocket(paths.socketPath);
      const child = spawnResident(paths, config);
      await waitForServer(paths.socketPath, child);
      return;
    } finally {
      await lock.close();
      await rm(paths.lockPath, { force: true });
    }
  }

  await waitForServer(paths.socketPath);
}

export async function pingResident(socketPath: string, timeoutMs = 200): Promise<boolean> {
  try {
    const response = await sendResidentRequest({ socketPath, timeoutMs }, { id: randomUUID(), op: "ping" });
    return response.ok;
  } catch {
    return false;
  }
}

export async function kickResidentServer(paths: RspResidentPaths, config: RspResidentConfig): Promise<boolean> {
  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  if (await pingResident(paths.socketPath, 50)) return false;

  const lock = await tryAcquireLock(paths.wakeLockPath);
  if (!lock) return false;
  await lock.close();

  const [command, prefix] = spawnTarget(config);
  const child = spawn(command, [
    ...prefix,
    "warm-resident",
    "--socket",
    paths.socketPath,
    "--store-uri",
    config.storeUri,
    "--ttl-days",
    String(config.ttlDays),
    "--byte-budget",
    String(config.byteBudget),
    "--telemetry-ttl-days",
    String(config.telemetryTtlDays ?? 90),
    "--telemetry-byte-budget",
    String(config.telemetryByteBudget ?? config.byteBudget),
    "--wake-lock",
    paths.wakeLockPath,
  ], {
    cwd: paths.rootDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, RSP_RESIDENT_WARMER: "1" },
  });
  child.unref();
  return true;
}

export async function warmResidentServer(paths: RspResidentPaths, config: RspResidentConfig): Promise<void> {
  try {
    await ensureResidentServer(paths, config);
  } finally {
    await rm(paths.wakeLockPath, { force: true });
  }
}

async function waitForServer(socketPath: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  let last: unknown;
  while (Date.now() < deadline) {
    if (await pingResident(socketPath)) return;
    if (child && child.exitCode != null) {
      throw new Error(`resident rsp server exited before ready (${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last instanceof Error ? last : new Error("resident rsp server did not start");
}

async function removeUnresponsiveSocket(socketPath: string): Promise<void> {
  await rm(socketPath, { force: true });
}

async function tryAcquireLock(lockPath: string) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return null;
  }
}

function spawnResident(paths: RspResidentPaths, config: RspResidentConfig): ChildProcess {
  const [command, prefix] = spawnTarget(config);
  const child = spawn(command, [
    ...prefix,
    "server",
    "--socket",
    paths.socketPath,
    "--store-uri",
    config.storeUri,
    "--ttl-days",
    String(config.ttlDays),
    "--byte-budget",
    String(config.byteBudget),
    "--telemetry-ttl-days",
    String(config.telemetryTtlDays ?? 90),
    "--telemetry-byte-budget",
    String(config.telemetryByteBudget ?? config.byteBudget),
  ], {
    cwd: paths.rootDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, RSP_RESIDENT_SERVER: "1" },
  });
  child.unref();
  return child;
}

function spawnTarget(config: RspResidentConfig): [string, string[]] {
  if (config.serverCommand) return [config.serverCommand, config.serverArgs ?? []];
  const entry = process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  return [process.execPath, [...process.execArgv, entry]];
}

function resolveRuntimeSocketDir(rootDir: string): string {
  const hash = createHash("sha256").update(rootDir).digest("hex").slice(0, 20);
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) {
    const candidate = join(xdg, "red-skills", hash);
    if (join(candidate, "rsp.sock").length < UNIX_SOCKET_PATH_LIMIT) return candidate;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "nouid";
  return join(tmpdir(), `red-skills-${uid}`, hash);
}

function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 32; i++) {
    try {
      if (readFileSyncSafe(join(dir, ".red", "config.yaml")) != null) return dir;
      if (readFileSyncSafe(join(dir, ".git", "HEAD")) != null) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
