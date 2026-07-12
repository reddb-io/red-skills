import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { readFileSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RspElisionRecord,
  RspExpiredHandle,
  RspMintMeta,
  RspStoreStats,
} from "./elision-store.js";
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

export class ResidentRspElisionStore {
  constructor(
    private readonly paths: RspResidentPaths,
    private readonly config: RspResidentConfig,
  ) {}

  async mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    const response = await this.request({
      op: "mint",
      original: Buffer.from(original).toString("base64"),
      meta,
    });
    const handle = (response as { handle?: string }).handle;
    if (!handle?.startsWith("el:")) throw new Error("resident rsp returned invalid handle");
    return handle as `el:${string}`;
  }

  async get(handle: string): Promise<RspElisionRecord | RspExpiredHandle | null> {
    const raw = await this.request({ op: "get", handle });
    if (!raw) return null;
    if (isRecord(raw) && raw.status === "expired") return raw as unknown as RspExpiredHandle;
    if (!isRecord(raw) || typeof raw.original !== "string") return null;
    return {
      ...(raw as Omit<RspElisionRecord, "original">),
      original: Buffer.from(raw.original, "base64"),
    } as RspElisionRecord;
  }

  async stats(): Promise<RspStoreStats> {
    return await this.request({ op: "stats" }) as RspStoreStats;
  }

  async memory(action: "recall" | "ingest", payload: unknown): Promise<unknown> {
    return await this.request({ op: "memory", action, payload });
  }

  async close(): Promise<void> {}

  private async request(request: ResidentRequestWithoutId): Promise<unknown> {
    await ensureResidentServer(this.paths, this.config);
    const response = await sendResidentRequest(this.paths, { ...request, id: randomUUID() } as Parameters<typeof sendResidentRequest>[1]);
    if (!response.ok) throw new Error(response.error);
    return response.value;
  }
}

type ResidentRequestWithoutId = RspResidentRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, "id">
    : never
  : never;

export async function ensureResidentServer(paths: RspResidentPaths, config: RspResidentConfig): Promise<void> {
  await mkdir(dirname(paths.socketPath), { recursive: true });
  if (await ping(paths.socketPath)) return;

  const lock = await tryAcquireLock(paths.lockPath);
  if (lock) {
    try {
      if (await ping(paths.socketPath)) return;
      spawnResident(paths, config);
      await waitForServer(paths.socketPath);
      return;
    } finally {
      await lock.close();
      await rm(paths.lockPath, { force: true });
    }
  }

  await waitForServer(paths.socketPath);
}

async function ping(socketPath: string): Promise<boolean> {
  try {
    const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, { id: randomUUID(), op: "ping" });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(socketPath: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last: unknown;
  while (Date.now() < deadline) {
    if (await ping(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw last instanceof Error ? last : new Error("resident rsp server did not start");
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

function spawnResident(paths: RspResidentPaths, config: RspResidentConfig): void {
  const entry = process.argv[1] ? resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [
    ...process.execArgv,
    entry,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
