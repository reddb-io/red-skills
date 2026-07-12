import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RspResidentConfig, RspResidentRequest } from "./resident-protocol.js";
import { sendResidentRequest } from "./resident-protocol.js";

export interface RspResidentPaths {
  rootDir: string;
  socketPath: string;
  lockPath: string;
}

export function resolveResidentPaths(cwd: string): RspResidentPaths {
  const rootDir = findRepoRoot(cwd) ?? resolve(cwd);
  return {
    rootDir,
    socketPath: join(rootDir, ".red", "tmp", "rsp.sock"),
    lockPath: join(rootDir, ".red", "tmp", "rsp.lock"),
  };
}

export async function ensureResidentServer(paths: RspResidentPaths, config: RspResidentConfig): Promise<void> {
  await mkdir(dirname(paths.socketPath), { recursive: true });
  if (await ping(paths.socketPath)) return;

  const lock = await tryAcquireLock(paths.lockPath);
  if (lock) {
    try {
      if (await ping(paths.socketPath)) return;
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

type ResidentRequestWithoutId = RspResidentRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

async function ping(socketPath: string): Promise<boolean> {
  try {
    const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, { id: randomUUID(), op: "ping" });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(socketPath: string, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + 5_000;
  let childError: Error | undefined;
  child?.once("error", (err) => {
    childError = err;
  });
  while (Date.now() < deadline) {
    if (await ping(socketPath)) return;
    if (childError) throw childError;
    if (child && child.exitCode != null) {
      throw new Error(`resident rsp server exited before ready (${child.exitCode})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resident rsp server did not start");
}

async function tryAcquireLock(lockPath: string) {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    return await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return null;
  }
}

function spawnResident(paths: RspResidentPaths, config: RspResidentConfig): ChildProcess {
  const command = config.serverCommand ?? process.execPath;
  const prefix = config.serverCommand ? (config.serverArgs ?? []) : [...process.execArgv, process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url)];
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
  ], {
    cwd: paths.rootDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, RSP_RESIDENT_SERVER: "1" },
  });
  child.unref();
  return child;
}

function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 32; i++) {
    if (readFileSyncSafe(join(dir, ".red", "config.yaml")) != null) return dir;
    if (readFileSyncSafe(join(dir, ".git", "HEAD")) != null) return dir;
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
