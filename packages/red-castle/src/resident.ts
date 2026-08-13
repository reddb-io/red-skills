import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  assertResidentProtocolCompatibility,
  DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS,
  DEFAULT_RESIDENT_IDLE_MS,
  ensureVersionedResident,
  IncompatibleResidentProtocolError,
  removeVersionedResidentRegistry,
  ResidentActivity,
  writeVersionedResidentRegistry,
  type ResidentHello,
} from "@reddb-io/shared/resident-lifecycle.js";
import { runtimeSocketDir, sendLineRequest, serveWireSocket } from "@reddb-io/shared/resident-core.js";
import { resolveProjectIdentityForDir } from "@reddb-io/shared/project-identity-resolve.js";
import type { ProjectIdentity } from "@reddb-io/shared/project-identity.js";

export const CASTLE_RESIDENT_PROTOCOL_VERSION = "1.0.0";

export interface CastleResidentPaths {
  readonly rootDir: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly lockPath: string;
  readonly registryPath: string;
}

export function castleResidentPathsForIdentity(identity: ProjectIdentity): CastleResidentPaths {
  const rootDir = runtimeSocketDir({ key: `castle:${identity.slug}`, socketFileName: "castle.sock" });
  return {
    rootDir,
    socketPath: join(rootDir, "castle.sock"),
    pidPath: join(rootDir, "castle.pid"),
    lockPath: join(rootDir, "castle.lock"),
    registryPath: join(rootDir, "castle-resident.toon"),
  };
}

export function resolveCastleResidentPaths(cwd: string): CastleResidentPaths {
  return castleResidentPathsForIdentity(resolveProjectIdentityForDir(cwd));
}

interface CastleResidentRequestBase {
  readonly id: string;
  readonly protocolVersion: string;
}

export type CastleResidentRequest =
  | (CastleResidentRequestBase & { readonly op: "ping" })
  | (CastleResidentRequestBase & { readonly op: "status" })
  | (CastleResidentRequestBase & { readonly op: "client-open"; readonly clientId: string })
  | (CastleResidentRequestBase & { readonly op: "client-close"; readonly clientId: string })
  | (CastleResidentRequestBase & {
      readonly op: "call";
      readonly method: string;
      readonly input: Record<string, unknown>;
    })
  | (CastleResidentRequestBase & {
      readonly op: "notify";
      readonly topic: string;
      readonly value: unknown;
    })
  | (CastleResidentRequestBase & { readonly op: "handover"; readonly clientVersion: string });

type CastleResidentRequestWithoutProtocol = CastleResidentRequest extends infer Request
  ? Request extends { protocolVersion: string }
    ? Omit<Request, "protocolVersion">
    : never
  : never;

export interface CastleResidentProtocolError {
  readonly code: "INCOMPATIBLE_RESIDENT_PROTOCOL";
  readonly message: string;
  readonly clientProtocol: string;
  readonly residentProtocol: string;
}

export type CastleResidentResponse =
  | { readonly id: string; readonly ok: true; readonly value?: unknown }
  | { readonly id: string; readonly ok: false; readonly error: CastleResidentProtocolError | { code: string; message: string } };

export async function sendCastleResidentRequest(
  socketPath: string,
  request: CastleResidentRequest,
  timeoutMs = request.op === "handover" ? DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS + 1_000 : 5_000,
): Promise<CastleResidentResponse> {
  return await sendLineRequest<CastleResidentRequest, CastleResidentResponse>(
    { socketPath, timeoutMs },
    request,
    "Castle resident",
  );
}

export interface StartCastleResidentOptions {
  readonly paths: CastleResidentPaths;
  readonly residentVersion: string;
  readonly protocolVersion?: string;
  readonly invoke: (method: string, input: Record<string, unknown>) => Promise<unknown>;
  readonly notify?: (topic: string, value: unknown) => void | Promise<void>;
  readonly idleMs?: number;
  readonly idleCheckMs?: number;
  readonly handoverTimeoutMs?: number;
  readonly activity?: ResidentActivity;
}

export interface CastleResidentServer {
  readonly activity: ResidentActivity;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/** Start the one heavy Castle authority for a canonical project identity. */
export async function startCastleResident(
  options: StartCastleResidentOptions,
): Promise<CastleResidentServer> {
  const protocolVersion = options.protocolVersion ?? CASTLE_RESIDENT_PROTOCOL_VERSION;
  const activity = options.activity ?? new ResidentActivity({ idleMs: options.idleMs ?? DEFAULT_RESIDENT_IDLE_MS });
  const sockets = new Set<Socket>();
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  await mkdir(options.paths.rootDir, { recursive: true, mode: 0o700 });
  await rm(options.paths.socketPath, { force: true });

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    serveWireSocket<CastleResidentRequest>(
      socket,
      async (request, respond) => {
        const incompatible = protocolError(request, protocolVersion);
        if (incompatible !== null) {
          respond({ id: request.id, ok: false, error: incompatible });
          return;
        }
        await handleCastleRequest(request, respond, activity, options, close);
      },
      (error, request, respond) => {
        respond({
          id: request?.id ?? randomUUID(),
          ok: false,
          error: { code: "CASTLE_RESIDENT_ERROR", message: errorMessage(error) },
        });
      },
    );
  });

  server.once("close", () => {
    void Promise.all([
      rm(options.paths.socketPath, { force: true }),
      rm(options.paths.pidPath, { force: true }),
      removeVersionedResidentRegistry(options.paths.registryPath),
    ]).finally(resolveClosed);
  });
  server.on("error", () => undefined);

  async function close(): Promise<void> {
    if (closing) return await closed;
    closing = true;
    clearInterval(idleTimer);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closed;
  }

  await listen(server, options.paths.socketPath);
  await writeFile(options.paths.pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  await writeVersionedResidentRegistry(options.paths.registryPath, {
    kind: "castle",
    socketPath: options.paths.socketPath,
    residentVersion: options.residentVersion,
    protocolVersion,
  });
  const idleTimer = setInterval(
    () => { if (activity.canExitIdle()) void close(); },
    options.idleCheckMs ?? Math.min(1_000, options.idleMs ?? DEFAULT_RESIDENT_IDLE_MS),
  );
  idleTimer.unref();

  return { activity, closed, close };
}

async function handleCastleRequest(
  request: CastleResidentRequest,
  respond: (response: CastleResidentResponse) => void,
  activity: ResidentActivity,
  options: StartCastleResidentOptions,
  close: () => Promise<void>,
): Promise<void> {
  if (request.op === "ping") {
    respond({
      id: request.id,
      ok: true,
      value: {
        residentVersion: options.residentVersion,
        protocolVersion: options.protocolVersion ?? CASTLE_RESIDENT_PROTOCOL_VERSION,
        pid: process.pid,
      },
    });
    return;
  }
  if (request.op === "status") {
    respond({ id: request.id, ok: true, value: activity.snapshot() });
    return;
  }
  if (request.op === "client-open") {
    activity.addClient(request.clientId);
    respond({ id: request.id, ok: true });
    return;
  }
  if (request.op === "client-close") {
    activity.removeClient(request.clientId);
    respond({ id: request.id, ok: true });
    return;
  }
  if (request.op === "notify") {
    await options.notify?.(request.topic, request.value);
    respond({ id: request.id, ok: true });
    return;
  }
  if (request.op === "handover") {
    const result = await activity.beginHandover({
      timeoutMs: options.handoverTimeoutMs ?? DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS,
    });
    respond({ id: request.id, ok: true, value: result });
    setTimeout(() => void close(), 5).unref();
    return;
  }

  const finish = activity.beginCall(request.id);
  try {
    respond({ id: request.id, ok: true, value: await options.invoke(request.method, request.input) });
  } finally {
    finish();
  }
}

function protocolError(
  request: CastleResidentRequest,
  residentProtocol: string,
): CastleResidentProtocolError | null {
  try {
    assertResidentProtocolCompatibility(request.protocolVersion, residentProtocol);
    return null;
  } catch (error) {
    if (!(error instanceof IncompatibleResidentProtocolError)) throw error;
    return {
      code: error.code,
      message: error.message,
      clientProtocol: error.clientProtocol,
      residentProtocol: error.residentProtocol,
    };
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface CastleResidentClientOptions {
  readonly cwd: string;
  readonly clientVersion: string;
  readonly protocolVersion?: string;
  readonly serverCommand: string;
  readonly serverArgs: readonly string[];
  readonly paths?: CastleResidentPaths;
}

/** A session client. Every operation crosses the wire; there is no local core. */
export class CastleResidentClient {
  readonly #paths: CastleResidentPaths;
  readonly #clientId = randomUUID();
  readonly #protocolVersion: string;
  #opened = false;

  constructor(private readonly options: CastleResidentClientOptions) {
    this.#paths = options.paths ?? resolveCastleResidentPaths(options.cwd);
    this.#protocolVersion = options.protocolVersion ?? CASTLE_RESIDENT_PROTOCOL_VERSION;
  }

  async open(): Promise<void> {
    await this.ensure();
    const response = await this.send({ id: randomUUID(), op: "client-open", clientId: this.#clientId });
    assertCastleResponse(response);
    this.#opened = true;
  }

  async close(): Promise<void> {
    if (!this.#opened) return;
    this.#opened = false;
    await this.send({ id: randomUUID(), op: "client-close", clientId: this.#clientId }).catch(() => undefined);
  }

  async call(method: string, input: Record<string, unknown>): Promise<unknown> {
    await this.ensure();
    const response = await this.send({ id: randomUUID(), op: "call", method, input });
    assertCastleResponse(response);
    return response.value;
  }

  async notify(topic: string, value: unknown): Promise<void> {
    await this.ensure();
    assertCastleResponse(await this.send({ id: randomUUID(), op: "notify", topic, value }));
  }

  async ensure(): Promise<ResidentHello> {
    return await ensureVersionedResident({
      lockPath: this.#paths.lockPath,
      clientVersion: this.options.clientVersion,
      protocolVersion: this.#protocolVersion,
      probe: async () => await this.probe(),
      requestHandover: async () => {
        const response = await this.send({
          id: randomUUID(),
          op: "handover",
          clientVersion: this.options.clientVersion,
        });
        assertCastleResponse(response);
      },
      spawn: () => {
        const child = spawn(this.options.serverCommand, [...this.options.serverArgs], {
          cwd: this.options.cwd,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      },
    });
  }

  async #sendRequest(request: CastleResidentRequestWithoutProtocol): Promise<CastleResidentResponse> {
    return await sendCastleResidentRequest(this.#paths.socketPath, {
      ...request,
      protocolVersion: this.#protocolVersion,
    } as CastleResidentRequest);
  }

  private send(request: CastleResidentRequestWithoutProtocol): Promise<CastleResidentResponse> {
    return this.#sendRequest(request);
  }

  private async probe(): Promise<ResidentHello | null> {
    try {
      const response = await this.send({ id: randomUUID(), op: "ping" });
      if (!response.ok || !isRecord(response.value)) {
        if (!response.ok && response.error.code === "INCOMPATIBLE_RESIDENT_PROTOCOL") {
          const error = response.error as CastleResidentProtocolError;
          throw new IncompatibleResidentProtocolError(error.clientProtocol, error.residentProtocol);
        }
        return null;
      }
      const residentVersion = response.value.residentVersion;
      const protocolVersion = response.value.protocolVersion;
      return typeof residentVersion === "string" && typeof protocolVersion === "string"
        ? { residentVersion, protocolVersion }
        : null;
    } catch (error) {
      if (error instanceof IncompatibleResidentProtocolError) throw error;
      return null;
    }
  }
}

function assertCastleResponse(
  response: CastleResidentResponse,
): asserts response is Extract<CastleResidentResponse, { ok: true }> {
  if (response.ok) return;
  if (response.error.code === "INCOMPATIBLE_RESIDENT_PROTOCOL") {
    const error = response.error as CastleResidentProtocolError;
    throw new IncompatibleResidentProtocolError(error.clientProtocol, error.residentProtocol);
  }
  throw new Error(response.error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
