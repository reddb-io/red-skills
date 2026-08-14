import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveProjectIdentity } from "@reddb-io/shared/project-identity.js";
import {
  CASTLE_RESIDENT_PROTOCOL_VERSION,
  CastleResidentClient,
  CastleResidentRequestError,
  castleResidentPathsForIdentity,
  sendCastleResidentRequest,
  startCastleResident,
} from "./resident.js";

describe("Castle resident", () => {
  it("maps a primary checkout and sibling worktree identity to one socket", () => {
    const primary = resolveProjectIdentity({
      checkoutPath: "/code/project",
      gitCommonDir: "/code/project/.git",
      remoteUrl: "git@example.invalid:owner/project.git",
    });
    const sibling = resolveProjectIdentity({
      checkoutPath: "/code/project/.red/tmp/workers/w1/3803/worktree",
      gitCommonDir: "/code/project/.git",
      remoteUrl: "git@example.invalid:owner/project.git",
    });
    expect(castleResidentPathsForIdentity(primary).socketPath)
      .toBe(castleResidentPathsForIdentity(sibling).socketPath);
  });

  it("multiplexes calls and notifications through one resident core", async () => {
    const root = mkdtempSync(join(tmpdir(), "castle-resident-"));
    const paths = castleResidentPathsForIdentity(
      resolveProjectIdentity({ checkoutPath: root }),
    );
    const notify = vi.fn(async () => undefined);
    const resident = await startCastleResident({
      paths,
      residentVersion: "3.18.6",
      invoke: async (method, input) => ({ method, input, pid: process.pid }),
      notify,
    });
    try {
      expect(await sendCastleResidentRequest(paths.socketPath, {
        id: "open",
        op: "client-open",
        protocolVersion: CASTLE_RESIDENT_PROTOCOL_VERSION,
        clientId: "mcp-1",
      })).toMatchObject({ ok: true });
      expect(await sendCastleResidentRequest(paths.socketPath, {
        id: "call",
        op: "call",
        protocolVersion: CASTLE_RESIDENT_PROTOCOL_VERSION,
        method: "queueStatus",
        input: { limit: 1 },
      })).toMatchObject({
        ok: true,
        value: { method: "queueStatus", input: { limit: 1 }, pid: process.pid },
      });
      expect(await sendCastleResidentRequest(paths.socketPath, {
        id: "notify",
        op: "notify",
        protocolVersion: CASTLE_RESIDENT_PROTOCOL_VERSION,
        topic: "worker-state",
        value: { worker: "w1" },
      })).toMatchObject({ ok: true });
      expect(notify).toHaveBeenCalledWith("worker-state", { worker: "w1" });
      expect(resident.activity.snapshot()).toMatchObject({ clients: 1, calls: 0 });
    } finally {
      await resident.close();
    }
  });

  it("counts four lightweight session clients against one resident", async () => {
    const root = mkdtempSync(join(tmpdir(), "castle-clients-"));
    const paths = castleResidentPathsForIdentity(resolveProjectIdentity({ checkoutPath: root }));
    const resident = await startCastleResident({
      paths,
      residentVersion: "3.18.6",
      invoke: async () => null,
    });
    const clients = Array.from({ length: 4 }, () => new CastleResidentClient({
      cwd: root,
      paths,
      clientVersion: "3.18.6",
      serverCommand: process.execPath,
      serverArgs: [],
    }));
    try {
      await Promise.all(clients.map((client) => client.open()));
      expect(resident.activity.snapshot().clients).toBe(4);
      expect(await clients[0]!.status()).toMatchObject({
        health: "ready",
        residentVersion: "3.18.6",
        protocolVersion: CASTLE_RESIDENT_PROTOCOL_VERSION,
        pid: process.pid,
        clients: 4,
        handover: "serving",
      });
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      await resident.close();
    }
  });

  it("preserves typed resident failures without running a local fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "castle-typed-error-"));
    const paths = castleResidentPathsForIdentity(resolveProjectIdentity({ checkoutPath: root }));
    const resident = await startCastleResident({
      paths,
      residentVersion: "3.18.6",
      invoke: async () => {
        throw Object.assign(new Error("resident is draining"), { code: "RESIDENT_DRAINING" });
      },
    });
    const client = new CastleResidentClient({
      cwd: root,
      paths,
      clientVersion: "3.18.6",
      serverCommand: process.execPath,
      serverArgs: [],
    });
    try {
      await client.open();
      const failure = await client.call("queue_status", {}).catch((error) => error);
      expect(failure).toBeInstanceOf(CastleResidentRequestError);
      expect(failure).toMatchObject({ code: "RESIDENT_DRAINING" });
    } finally {
      await client.close();
      await resident.close();
    }
  });

  it("returns a typed incompatible-protocol error and invokes no engine fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "castle-protocol-"));
    const paths = castleResidentPathsForIdentity(resolveProjectIdentity({ checkoutPath: root }));
    const invoke = vi.fn(async () => "should not run");
    const resident = await startCastleResident({ paths, residentVersion: "3.18.6", invoke });
    try {
      expect(await sendCastleResidentRequest(paths.socketPath, {
        id: "bad",
        op: "call",
        protocolVersion: "2.0.0",
        method: "queueStatus",
        input: {},
      })).toEqual({
        id: "bad",
        ok: false,
        error: {
          code: "INCOMPATIBLE_RESIDENT_PROTOCOL",
          message: expect.stringMatching(/incompatible/i),
          clientProtocol: "2.0.0",
          residentProtocol: CASTLE_RESIDENT_PROTOCOL_VERSION,
        },
      });
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      await resident.close();
    }
  });

  it("reports calls that miss the handover drain deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "castle-handover-"));
    const paths = castleResidentPathsForIdentity(resolveProjectIdentity({ checkoutPath: root }));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const resident = await startCastleResident({
      paths,
      residentVersion: "3.18.6",
      handoverTimeoutMs: 10,
      invoke: async () => { await blocked; return "released"; },
    });
    const call = sendCastleResidentRequest(paths.socketPath, {
      id: "in-flight",
      op: "call",
      protocolVersion: CASTLE_RESIDENT_PROTOCOL_VERSION,
      method: "gateRun",
      input: {},
    }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const handover = await sendCastleResidentRequest(paths.socketPath, {
      id: "handover",
      op: "handover",
      protocolVersion: CASTLE_RESIDENT_PROTOCOL_VERSION,
      clientVersion: "3.18.7",
    });
    expect(handover).toMatchObject({
      ok: true,
      value: { drained: false, pending: ["in-flight"] },
    });
    release();
    await call;
    await resident.closed;
  });
});
