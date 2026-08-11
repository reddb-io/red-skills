import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode, type JsonObject } from "@reddb-io/toon";
import { rspStateDir } from "./red-paths.js";
import {
  acquireSpawnLock,
  describeSpawnLockHolder,
  isPidAlive,
  releaseSpawnLock,
  runtimeSocketDir,
  terminatePid,
  tryAcquireExclusiveLock,
} from "./resident-core.js";
import type { RspResidentConfig, RspResidentRequest } from "./resident-protocol.js";
import { sendResidentRequest } from "./resident-protocol.js";
import { requireRspEntry } from "./rsp-entry.js";

export interface RspResidentPaths {
  rootDir: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  wakeLockPath: string;
  summaryPath: string;
  registryPath: string;
}

const RESIDENT_REGISTRY_VERSION = 1;
const DEFAULT_RESIDENT_READY_TIMEOUT_MS = 5_000;

export interface RspResidentRegistryEntry {
  version: typeof RESIDENT_REGISTRY_VERSION;
  pid: number;
  socket_path: string;
  store_uri: string;
  resident_version: string;
  started_at: string;
}

export interface RspResidentRegistryStatus {
  registry_path: string;
  state:
    | "missing"
    | "registered-alive-socket-healthy"
    | "registered-alive-socket-dead"
    | "registered-alive-store-missing"
    | "registered-dead"
    | "invalid";
  entry?: RspResidentRegistryEntry;
}

export function resolveResidentPaths(cwd: string): RspResidentPaths {
  const rootDir = findRepoRoot(cwd) ?? resolve(cwd);
  const socketDir = resolveRuntimeSocketDir(rootDir);
  const rspState = rspStateDir(rootDir);
  return {
    rootDir,
    socketPath: join(socketDir, "rsp.sock"),
    pidPath: join(socketDir, "rsp.pid"),
    lockPath: join(socketDir, "rsp.lock"),
    // The wake lock is a genuinely ephemeral guard, so it stays in the tmp
    // tier — inside the registered `rsp` lane: ADR 0098 forbids loose files at
    // the `.red/tmp/` root, every writer uses a named lane.
    wakeLockPath: join(rootDir, ".red", "tmp", "rsp", "wake.lock"),
    // Durable status + resident metadata live in the rsp state lane (ADR 0098).
    summaryPath: join(rspState, "rsp-status-summary.json"),
    registryPath: join(rspState, "rsp-resident.pid.json"),
  };
}

export { RspResidentEntryError, RSP_ENTRY_UNRESOLVED, resolveRspEntry } from "./rsp-entry.js";

/**
 * Generic client for the resident rsp server. Consumers outside the rsp app
 * (memory, brain, the dev bundle, redskilled-mcp) need no extra wiring: an
 * auto-start resolves the rsp entry explicitly (`rsp-entry.ts`) rather than
 * re-executing the caller's own entrypoint. `config.serverCommand` stays the
 * override for a host that knows better.
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
  if (await isResidentUsable(paths.socketPath, config)) return;
  await reconcileResidentRegistry(paths, config);

  // Reaping, not merely exclusive: an orphaned lock here refuses every auto-spawn
  // for as long as it exists, and the resident is the only path a fresh session
  // has to a store (#3123). The reaping is reported rather than silent.
  const lock = await acquireSpawnLock(paths.lockPath, {
    onReap: (reaping) =>
      process.stderr.write(
        `rsp: reaped the resident spawn lock ${JSON.stringify(reaping.lockPath)} ` +
          `(${reaping.reason}, ${Math.round(reaping.ageMs / 1_000)}s old)\n`,
      ),
  });
  if (lock.acquired) {
    try {
      if (await isResidentUsable(paths.socketPath, config)) return;
      await reconcileResidentRegistry(paths, config);
      await removeUnresponsiveSocket(paths.socketPath);
      const child = spawnResident(paths, config);
      await waitForServer(paths.socketPath, child);
      return;
    } finally {
      await releaseSpawnLock(lock);
    }
  }

  try {
    await waitForServer(paths.socketPath);
  } catch (err) {
    // The gate that refused, not a daemon that failed: this client never spawned.
    throw new Error(`${err instanceof Error ? err.message : String(err)}; ${describeSpawnLockHolder(lock)}`);
  }
}

export async function pingResident(socketPath: string, timeoutMs = 200): Promise<boolean> {
  try {
    return await pingResidentHello(socketPath, timeoutMs) != null;
  } catch {
    return false;
  }
}

export interface ResidentHello {
  version?: string;
}

export async function pingResidentHello(socketPath: string, timeoutMs = 200): Promise<ResidentHello | null> {
  const response = await sendResidentRequest({ socketPath, timeoutMs }, { id: randomUUID(), op: "ping" });
  if (!response.ok) return null;
  return isRecord(response.value) ? { version: stringValue(response.value.version) } : {};
}

export async function kickResidentServer(paths: RspResidentPaths, config: RspResidentConfig): Promise<boolean> {
  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  if (await pingResident(paths.socketPath, 50)) return false;

  const lock = await tryAcquireLock(paths.wakeLockPath);
  if (!lock) return false;
  await lock.close();

  const [command, prefix] = spawnTarget(paths, config);
  const child = spawn(command, [
    ...prefix,
    "warm-resident",
    "--socket",
    paths.socketPath,
    "--pid-file",
    paths.pidPath,
    "--store-uri",
    config.storeUri,
    "--ttl-days",
    String(config.ttlDays),
    "--ephemeral-ttl-hours",
    String(config.ephemeralTtlHours ?? 6),
    "--byte-budget",
    String(config.byteBudget),
    "--telemetry-ttl-days",
    String(config.telemetryTtlDays ?? 90),
    "--telemetry-byte-budget",
    String(config.telemetryByteBudget ?? config.byteBudget),
    "--telemetry-drain-interval-ms",
    String(config.telemetryDrainIntervalMs ?? 30_000),
    "--telemetry-drain-timeout-ms",
    String(config.telemetryDrainTimeoutMs ?? 2_000),
    "--idle-ms",
    String(config.idleMs ?? 300_000),
    "--resident-version",
    config.clientVersion ?? "0.0.0-dev",
    "--registry",
    paths.registryPath,
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

export async function readResidentRegistry(path: string): Promise<RspResidentRegistryEntry | null> {
  try {
    const parsed = parseStructuredDocument(await readFile(path, "utf8"));
    return isResidentRegistryEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeResidentRegistry(
  path: string,
  entry: Omit<RspResidentRegistryEntry, "version" | "pid" | "started_at"> & {
    pid?: number;
    started_at?: string;
  },
): Promise<void> {
  const payload: RspResidentRegistryEntry = {
    version: RESIDENT_REGISTRY_VERSION,
    pid: entry.pid ?? process.pid,
    socket_path: entry.socket_path,
    store_uri: entry.store_uri,
    resident_version: entry.resident_version,
    started_at: entry.started_at ?? new Date().toISOString(),
  };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${encode(payload as unknown as JsonObject)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function removeResidentRegistry(path: string, pid = process.pid): Promise<void> {
  try {
    const entry = await readResidentRegistry(path);
    if (entry && entry.pid !== pid) return;
    await rm(path, { force: true });
  } catch {}
}

export async function residentRegistryStatus(paths: RspResidentPaths): Promise<RspResidentRegistryStatus> {
  const entry = await readResidentRegistry(paths.registryPath);
  if (!entry) {
    try {
      await readFile(paths.registryPath, "utf8");
      return { registry_path: paths.registryPath, state: "invalid" };
    } catch {
      return { registry_path: paths.registryPath, state: "missing" };
    }
  }
  if (!isPidAlive(entry.pid)) return { registry_path: paths.registryPath, state: "registered-dead", entry };
  const socketHealthy = await pingResident(entry.socket_path, 100);
  if (socketHealthy && await isStorePathMissing(entry.store_uri)) {
    return { registry_path: paths.registryPath, state: "registered-alive-store-missing", entry };
  }
  return {
    registry_path: paths.registryPath,
    state: socketHealthy ? "registered-alive-socket-healthy" : "registered-alive-socket-dead",
    entry,
  };
}

export async function sweepResidentRegistry(paths: RspResidentPaths): Promise<RspResidentRegistryStatus> {
  const status = await residentRegistryStatus(paths);
  if (status.state === "registered-dead" || status.state === "invalid") {
    await rm(paths.registryPath, { force: true });
    return await residentRegistryStatus(paths);
  }
  if (
    (status.state === "registered-alive-socket-dead" || status.state === "registered-alive-store-missing") &&
    status.entry
  ) {
    await terminatePid(status.entry.pid);
    await rm(paths.registryPath, { force: true });
    await rm(status.entry.socket_path, { force: true });
    return await residentRegistryStatus(paths);
  }
  return status;
}

interface ResidentSpawn {
  child: ChildProcess;
  stderrTail(): string;
  spawnError(): Error | undefined;
}

async function waitForServer(socketPath: string, spawnHandle?: ResidentSpawn): Promise<void> {
  const deadline = Date.now() + residentReadyTimeoutMs();
  let last: unknown;
  while (Date.now() < deadline) {
    if (await pingResident(socketPath)) return;
    if (spawnHandle) {
      const spawnError = spawnHandle.spawnError();
      if (spawnError) throw new Error(formatResidentStartFailure("resident rsp server spawn failed", spawnHandle, spawnError));
      if (spawnHandle.child.exitCode != null || spawnHandle.child.signalCode != null) {
        throw new Error(formatResidentStartFailure("resident rsp server exited before ready", spawnHandle));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (last instanceof Error) throw last;
  throw new Error(spawnHandle ? formatResidentStartFailure("resident rsp server did not start", spawnHandle) : "resident rsp server did not start");
}

function residentReadyTimeoutMs(): number {
  const value = Number(process.env.RSP_RESIDENT_READY_TIMEOUT_MS ?? "");
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RESIDENT_READY_TIMEOUT_MS;
}

async function removeUnresponsiveSocket(socketPath: string): Promise<void> {
  await rm(socketPath, { force: true });
}

const tryAcquireLock = tryAcquireExclusiveLock;

function spawnResident(paths: RspResidentPaths, config: RspResidentConfig): ResidentSpawn {
  const [command, prefix] = spawnTarget(paths, config);
  const captureDiagnostics = process.env.RSP_DEBUG === "1";
  let spawnError: Error | undefined;
  let stderrTail = "";
  const child = spawn(command, [
    ...prefix,
    "server",
    "--socket",
    paths.socketPath,
    "--pid-file",
    paths.pidPath,
    "--store-uri",
    config.storeUri,
    "--ttl-days",
    String(config.ttlDays),
    "--ephemeral-ttl-hours",
    String(config.ephemeralTtlHours ?? 6),
    "--byte-budget",
    String(config.byteBudget),
    "--telemetry-ttl-days",
    String(config.telemetryTtlDays ?? 90),
    "--telemetry-byte-budget",
    String(config.telemetryByteBudget ?? config.byteBudget),
    "--telemetry-drain-interval-ms",
    String(config.telemetryDrainIntervalMs ?? 30_000),
    "--telemetry-drain-timeout-ms",
    String(config.telemetryDrainTimeoutMs ?? 2_000),
    "--idle-ms",
    String(config.idleMs ?? 300_000),
    "--resident-version",
    config.clientVersion ?? "0.0.0-dev",
    "--registry",
    paths.registryPath,
  ], {
    cwd: paths.rootDir,
    detached: true,
    stdio: captureDiagnostics ? ["ignore", "ignore", "pipe"] : "ignore",
    env: { ...process.env, RSP_RESIDENT_SERVER: "1" },
  });
  child.on("error", (err) => {
    spawnError = err;
  });
  if (captureDiagnostics) {
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = tailString(`${stderrTail}${chunk}`, RESIDENT_START_STDERR_TAIL_BYTES);
    });
  }
  child.unref();
  return {
    child,
    stderrTail: () => stderrTail,
    spawnError: () => spawnError,
  };
}

const RESIDENT_START_STDERR_TAIL_BYTES = 8 * 1024;

function formatResidentStartFailure(reason: string, spawnHandle: ResidentSpawn, err?: Error): string {
  const parts = [reason];
  if (err) parts.push(`error: ${err.message}`);
  if (spawnHandle.child.exitCode != null) parts.push(`exit code: ${spawnHandle.child.exitCode}`);
  if (spawnHandle.child.signalCode != null) parts.push(`signal: ${spawnHandle.child.signalCode}`);
  const stderrTail = spawnHandle.stderrTail().trimEnd();
  if (stderrTail) parts.push(`stderr tail:\n${stderrTail}`);
  return parts.join("\n");
}

function tailString(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;
  return Buffer.from(value, "utf8").subarray(bytes - maxBytes).toString("utf8").replace(/^\uFFFD+/, "");
}

function parseStructuredDocument(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return decode(body);
  }
}

async function reconcileResidentRegistry(paths: RspResidentPaths, config: RspResidentConfig): Promise<void> {
  try {
    const entry = await readResidentRegistry(paths.registryPath);
    if (!entry) return;
    if (entry.socket_path !== paths.socketPath || entry.store_uri !== config.storeUri) return;
    if (!isPidAlive(entry.pid)) {
      await rm(paths.registryPath, { force: true });
      return;
    }
    if (await pingResident(entry.socket_path, 100)) return;
    if (shouldHandover(config.clientVersion, entry.resident_version)) {
      await waitForPidExit(entry.pid, 1_500);
      if (!isPidAlive(entry.pid)) {
        await rm(paths.registryPath, { force: true });
        return;
      }
    }
    await terminatePid(entry.pid);
    await rm(paths.registryPath, { force: true });
  } catch {}
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function isStorePathMissing(storeUri: string): Promise<boolean> {
  if (!storeUri.startsWith("file://")) return false;
  try {
    await stat(fileURLToPath(storeUri));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * The rsp entry, resolved explicitly — never inferred from the caller's argv.
 *
 * Throws {@link RspResidentEntryError} when no rsp entry exists on this host, so
 * a foreign bundle gets a named diagnostic instead of re-executing itself with
 * an argument it does not route (#2736).
 */
function spawnTarget(paths: RspResidentPaths, config: RspResidentConfig): [string, string[]] {
  const entry = requireRspEntry(config, { rootDir: paths.rootDir });
  return [entry.command, entry.args];
}

function resolveRuntimeSocketDir(rootDir: string): string {
  return runtimeSocketDir({ key: rootDir, socketFileName: "rsp.sock" });
}

function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 32; i++) {
    try {
      const gitFile = readFileSyncSafe(join(dir, ".git"));
      if (gitFile != null) return linkedWorktreePrimaryRoot(dir, gitFile) ?? dir;
      if (readFileSyncSafe(join(dir, ".git", "HEAD")) != null) return dir;
      if (readFileSyncSafe(join(dir, ".red", "config.yaml")) != null) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function linkedWorktreePrimaryRoot(worktreeRoot: string, gitFile: string): string | null {
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(gitFile);
  if (!match) return null;
  const gitDir = resolve(worktreeRoot, match[1]);
  if (!/[/\\]worktrees[/\\][^/\\]+$/.test(gitDir)) return null;
  return dirname(dirname(dirname(gitDir)));
}

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function isResidentUsable(socketPath: string, config: RspResidentConfig): Promise<boolean> {
  const hello = await pingResidentHello(socketPath).catch(() => null);
  if (!hello) return false;
  if (!shouldHandover(config.clientVersion, hello.version)) return true;

  await requestResidentHandover(socketPath, config.clientVersion!);
  await waitForResidentExit(socketPath);
  return false;
}

async function requestResidentHandover(socketPath: string, clientVersion: string): Promise<void> {
  try {
    await sendResidentRequest({ socketPath, timeoutMs: 200 }, { id: randomUUID(), op: "handover", clientVersion });
  } catch {
    // A hung or pre-handover resident should fall through to the existing
    // unresponsive-socket removal path under the spawn lock.
  }
}

function shouldHandover(clientVersion: string | undefined, residentVersion: string | undefined): boolean {
  if (!clientVersion || !residentVersion) return false;
  return compareSemver(clientVersion, residentVersion) > 0;
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isResidentRegistryEntry(value: unknown): value is RspResidentRegistryEntry {
  return isRecord(value) &&
    value.version === RESIDENT_REGISTRY_VERSION &&
    Number.isInteger(value.pid) &&
    typeof value.socket_path === "string" &&
    typeof value.store_uri === "string" &&
    typeof value.resident_version === "string" &&
    typeof value.started_at === "string";
}

async function waitForResidentExit(socketPath: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!await pingResident(socketPath, 50)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
