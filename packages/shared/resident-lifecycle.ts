import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, encode, type JsonObject } from "@reddb-io/toon";
import {
  acquireSpawnLock,
  describeSpawnLockHolder,
  releaseSpawnLock,
} from "./resident-core.js";

export const DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS = 30_000;
export const DEFAULT_RESIDENT_IDLE_MS = 5 * 60_000;
export const VERSIONED_RESIDENT_REGISTRY_SCHEMA = "red.shared.resident_registry.v1" as const;

export interface VersionedResidentRegistryEntry {
  readonly schema: typeof VERSIONED_RESIDENT_REGISTRY_SCHEMA;
  readonly kind: string;
  readonly pid: number;
  readonly socket_path: string;
  readonly resident_version: string;
  readonly protocol_version: string;
  readonly started_at: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface WriteVersionedResidentRegistryInput {
  readonly kind: string;
  readonly pid?: number;
  readonly socketPath: string;
  readonly residentVersion: string;
  readonly protocolVersion: string;
  readonly startedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function readVersionedResidentRegistry(
  path: string,
): Promise<VersionedResidentRegistryEntry | null> {
  const value = await readResidentRegistryDocument(path);
  return isVersionedResidentRegistryEntry(value) ? value : null;
}

/** Read one JSON/TOON registry payload without imposing daemon semantics. */
export async function readResidentRegistryDocument(path: string): Promise<unknown | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (raw === "") return null;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return decode(raw);
    }
  } catch {
    return null;
  }
}

export async function writeVersionedResidentRegistry(
  path: string,
  input: WriteVersionedResidentRegistryInput,
): Promise<void> {
  const entry: VersionedResidentRegistryEntry = {
    schema: VERSIONED_RESIDENT_REGISTRY_SCHEMA,
    kind: input.kind,
    pid: input.pid ?? process.pid,
    socket_path: input.socketPath,
    resident_version: input.residentVersion,
    protocol_version: input.protocolVersion,
    started_at: input.startedAt ?? new Date().toISOString(),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
  await writeResidentRegistryDocument(path, entry as unknown as Record<string, unknown>);
}

/** Atomically persist one daemon-owned payload using the shared registry encoding. */
export async function writeResidentRegistryDocument(
  path: string,
  value: Readonly<Record<string, unknown>>,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${encode(value as JsonObject)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

export async function removeVersionedResidentRegistry(
  path: string,
  pid = process.pid,
): Promise<void> {
  const current = await readVersionedResidentRegistry(path);
  if (current !== null && current.pid !== pid) return;
  await rm(path, { force: true });
}

export class IncompatibleResidentProtocolError extends Error {
  readonly code = "INCOMPATIBLE_RESIDENT_PROTOCOL" as const;

  constructor(
    readonly clientProtocol: string,
    readonly residentProtocol: string,
  ) {
    super(
      `resident protocol ${residentProtocol} is incompatible with client protocol ${clientProtocol}`,
    );
    this.name = "IncompatibleResidentProtocolError";
  }
}

export class ResidentDrainingError extends Error {
  readonly code = "RESIDENT_DRAINING" as const;

  constructor() {
    super("resident is draining for version handover");
    this.name = "ResidentDrainingError";
  }
}

export interface ResidentHello {
  readonly residentVersion: string;
  readonly protocolVersion: string;
}

export interface EnsureVersionedResidentOptions {
  readonly lockPath: string;
  readonly clientVersion: string;
  readonly protocolVersion: string;
  readonly probe: () => Promise<ResidentHello | null>;
  readonly spawn: () => void | Promise<void>;
  readonly requestHandover?: (hello: ResidentHello) => void | Promise<void>;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
}

/**
 * Join one compatible resident, or serialize its birth/handover under the
 * shared spawn lock. Protocol incompatibility is terminal and is checked before
 * any spawn hook is reached: callers never conceal it with an in-process core.
 */
export async function ensureVersionedResident(
  options: EnsureVersionedResidentOptions,
): Promise<ResidentHello> {
  const first = await usableResident(options, await options.probe());
  if (first !== null) return first;

  const lock = await acquireSpawnLock(options.lockPath);
  if (lock.acquired) {
    try {
      const raced = await usableResident(options, await options.probe());
      if (raced !== null) return raced;
      await options.spawn();
      return await waitForResident(options);
    } finally {
      await releaseSpawnLock(lock);
    }
  }

  try {
    return await waitForResident(options);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ${describeSpawnLockHolder(lock)}`,
    );
  }
}

async function usableResident(
  options: EnsureVersionedResidentOptions,
  hello: ResidentHello | null,
): Promise<ResidentHello | null> {
  if (hello === null) return null;
  assertResidentProtocolCompatibility(options.protocolVersion, hello.protocolVersion);
  if (
    options.requestHandover !== undefined &&
    compareSemver(options.clientVersion, hello.residentVersion) > 0
  ) {
    await options.requestHandover(hello);
    await waitForAbsence(options);
    return null;
  }
  return hello;
}

async function waitForResident(options: EnsureVersionedResidentOptions): Promise<ResidentHello> {
  const timeoutMs = options.readyTimeoutMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const hello = await options.probe();
    if (hello !== null) {
      assertResidentProtocolCompatibility(options.protocolVersion, hello.protocolVersion);
      return hello;
    }
    await delay(options.pollMs ?? 20);
  }
  throw new Error("versioned resident did not become ready");
}

async function waitForAbsence(options: EnsureVersionedResidentOptions): Promise<void> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS);
  while (Date.now() <= deadline) {
    if (await options.probe() === null) return;
    await delay(options.pollMs ?? 20);
  }
  throw new Error("versioned resident did not complete handover");
}

export function assertResidentProtocolCompatibility(clientProtocol: string, residentProtocol: string): void {
  const client = parseSemver(clientProtocol);
  const resident = parseSemver(residentProtocol);
  if (client === null || resident === null || client.major !== resident.major) {
    throw new IncompatibleResidentProtocolError(clientProtocol, residentProtocol);
  }
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (a === null || b === null) return 0;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function parseSemver(value: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  return match === null
    ? null
    : { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ResidentActivityOptions {
  readonly now?: () => number;
  readonly idleMs?: number;
}

export interface ResidentHandoverResult {
  readonly drained: boolean;
  readonly completed: readonly string[];
  readonly pending: readonly string[];
}

/** The shared truth for client/call/Worker/obligation-aware shutdown. */
export class ResidentActivity {
  readonly #now: () => number;
  readonly #idleMs: number;
  readonly #clients = new Set<string>();
  readonly #workers = new Set<string>();
  readonly #obligations = new Set<string>();
  readonly #calls = new Set<string>();
  readonly #completed = new Set<string>();
  readonly #drainWaiters = new Set<() => void>();
  #lastActivity: number;
  #draining = false;

  constructor(options: ResidentActivityOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#idleMs = options.idleMs ?? DEFAULT_RESIDENT_IDLE_MS;
    this.#lastActivity = this.#now();
  }

  beginCall(id: string): () => void {
    if (this.#draining) throw new ResidentDrainingError();
    this.#calls.add(id);
    this.#touch();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#calls.delete(id);
      this.#completed.add(id);
      this.#touch();
      if (this.#calls.size === 0) {
        for (const resolve of this.#drainWaiters) resolve();
        this.#drainWaiters.clear();
      }
    };
  }

  addClient(id: string): void { this.#clients.add(id); this.#touch(); }
  removeClient(id: string): void { this.#clients.delete(id); this.#touch(); }
  addWorker(id: string): void { this.#workers.add(id); this.#touch(); }
  removeWorker(id: string): void { this.#workers.delete(id); this.#touch(); }
  armObligation(id: string): void { this.#obligations.add(id); this.#touch(); }
  disarmObligation(id: string): void { this.#obligations.delete(id); this.#touch(); }

  canExitIdle(): boolean {
    return !this.#draining &&
      this.#clients.size === 0 &&
      this.#workers.size === 0 &&
      this.#obligations.size === 0 &&
      this.#calls.size === 0 &&
      this.#now() - this.#lastActivity >= this.#idleMs;
  }

  async beginHandover(options: { timeoutMs?: number } = {}): Promise<ResidentHandoverResult> {
    this.#draining = true;
    if (this.#calls.size > 0) {
      await Promise.race([
        new Promise<void>((resolve) => this.#drainWaiters.add(resolve)),
        delay(options.timeoutMs ?? DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS),
      ]);
    }
    const pending = [...this.#calls];
    return {
      drained: pending.length === 0,
      completed: [...this.#completed],
      pending,
    };
  }

  snapshot(): {
    readonly clients: number;
    readonly workers: number;
    readonly obligations: number;
    readonly calls: number;
    readonly draining: boolean;
  } {
    return {
      clients: this.#clients.size,
      workers: this.#workers.size,
      obligations: this.#obligations.size,
      calls: this.#calls.size,
      draining: this.#draining,
    };
  }

  #touch(): void {
    this.#lastActivity = this.#now();
  }
}

function isVersionedResidentRegistryEntry(value: unknown): value is VersionedResidentRegistryEntry {
  if (!isRecord(value) || value.schema !== VERSIONED_RESIDENT_REGISTRY_SCHEMA) return false;
  return typeof value.kind === "string" &&
    Number.isInteger(value.pid) && Number(value.pid) > 0 &&
    typeof value.socket_path === "string" &&
    typeof value.resident_version === "string" &&
    typeof value.protocol_version === "string" &&
    typeof value.started_at === "string" &&
    (value.metadata === undefined || isRecord(value.metadata));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
