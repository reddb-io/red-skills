// The rsp resident shares its socket core — and therefore its wire — with the
// `redskilled` daemon, so it inherits the same rollout obligation: a checkout
// pinned to an older bundle keeps talking to it, and it keeps talking to an
// older resident. The framing is proven in `packages/shared/resident-wire.test.ts`;
// what is proven HERE is that the real resident answers both callers.
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWireFrame, takeWireFrame } from "@reddb-io/shared/resident-wire.js";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/config.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import { runResidentServer } from "../src/resident-server.js";
import { shutdownResident, waitForResident } from "./telemetry.helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function startResident(): Promise<{ socketPath: string; closed: Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "rsp-wire-dialect-"));
  roots.push(root);
  const paths = resolveResidentPaths(root);
  const closed = runResidentServer({
    socketPath: paths.socketPath,
    rootDir: paths.rootDir,
    storeUri: `file://${join(root, ".red", "tmp", "red-skills.rdb")}`,
    ttlDays: DEFAULT_RSP_TTL_DAYS,
    byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    idleMs: 30_000,
    residentVersion: "9.9.9-test",
  });
  await waitForResident(paths.socketPath, 20_000);
  return { socketPath: paths.socketPath, closed };
}

/** One line of raw bytes in, the first line back — either side of the migration. */
async function rawExchange(socketPath: string, payload: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("resident did not answer"));
    }, 5_000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const framed = takeWireFrame(buffer);
      if (!framed) return;
      clearTimeout(timer);
      resolve(framed.frame);
      socket.end();
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("rsp resident socket dialect", () => {
  it("answers its own client, which writes TOON", async () => {
    const { socketPath, closed } = await startResident();
    try {
      const response = await sendResidentRequest({ socketPath, timeoutMs: 5_000 }, { id: "toon-ping", op: "ping" });
      expect(response).toMatchObject({ id: "toon-ping", ok: true, value: { pong: true, version: "9.9.9-test" } });
    } finally {
      await shutdownResident(socketPath);
      await closed;
    }
  }, 60_000);

  it("answers a TOON caller in TOON", async () => {
    const { socketPath, closed } = await startResident();
    try {
      const frame = await rawExchange(socketPath, "id: raw-toon\nop: ping\n\n");
      expect(frame.startsWith("{")).toBe(false);
      expect(decodeWireFrame(frame)).toMatchObject({ id: "raw-toon", ok: true });
    } finally {
      await shutdownResident(socketPath);
      await closed;
    }
  }, 60_000);

  it("answers a pre-migration JSON caller in the one JSON line it knows how to read", async () => {
    const { socketPath, closed } = await startResident();
    try {
      const frame = await rawExchange(socketPath, `${JSON.stringify({ id: "raw-json", op: "ping" })}\n`);
      expect(frame.startsWith("{")).toBe(true);
      expect(JSON.parse(frame)).toMatchObject({ id: "raw-json", ok: true, value: { pong: true } });
    } finally {
      await shutdownResident(socketPath);
      await closed;
    }
  }, 60_000);
});
