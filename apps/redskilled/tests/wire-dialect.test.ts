// One daemon serves checkouts pinned to different bundle versions (ADR 0130
// rule 3), so the socket's move to TOON has to hold against a client from either
// side of the rollout. The framing itself is proven in
// `packages/shared/resident-wire.test.ts`; what is proven HERE is that the real
// daemon — not a stand-in — answers both of them.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWireFrame, isUnintelligibleResponse, takeWireFrame } from "@reddb-io/shared/resident-wire.js";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { isRedskilledPong, sendRedskilledRequest } from "../src/protocol.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-wire-"));
  roots.push(root);
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

/** A client from before the migration: one JSON line out, one JSON line back. */
async function oldClientPing(socketPath: string, id: string): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, op: "ping" })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const raw = buffer.slice(0, newline);
      try {
        resolve({ raw, parsed: JSON.parse(raw) as Record<string, unknown> });
      } catch (err) {
        reject(err);
      }
      socket.end();
    });
    socket.on("error", reject);
  });
}

/** A client from after it: one TOON frame out, whichever encoding comes back. */
async function toonClientPing(socketPath: string, id: string): Promise<{ raw: string; parsed: unknown }> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    socket.on("connect", () => socket.write(`id: ${id}\nop: ping\n\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const framed = takeWireFrame(buffer);
      if (!framed) return;
      try {
        resolve({ raw: framed.frame, parsed: decodeWireFrame(framed.frame) });
      } catch (err) {
        reject(err);
      }
      socket.end();
    });
    socket.on("error", reject);
  });
}

describe("redskilled socket dialect", () => {
  it("answers its own client, which writes TOON", async () => {
    const paths = await sessionPaths();
    running.push(await startRedskilledDaemon({ paths }));

    const response = await sendRedskilledRequest({ socketPath: paths.socketPath }, { id: randomUUID(), op: "ping" });

    expect(response.ok).toBe(true);
    expect(response.ok && isRedskilledPong(response.value)).toBe(true);
  });

  it("answers a TOON caller in TOON", async () => {
    const paths = await sessionPaths();
    running.push(await startRedskilledDaemon({ paths }));

    const { raw, parsed } = await toonClientPing(paths.socketPath, "toon-1");

    expect(raw.startsWith("{")).toBe(false);
    expect(parsed).toMatchObject({ id: "toon-1", ok: true });
  });

  it("answers a pre-migration JSON caller in the one JSON line it knows how to read", async () => {
    const paths = await sessionPaths();
    running.push(await startRedskilledDaemon({ paths }));

    const { raw, parsed } = await oldClientPing(paths.socketPath, "json-1");

    expect(raw.startsWith("{")).toBe(true);
    expect(parsed).toMatchObject({ id: "json-1", ok: true });
    expect(isRedskilledPong((parsed as { value: unknown }).value)).toBe(true);
  });
});

describe("a handler failure never masquerades as the downgrade proof", () => {
  async function rawExchange(socketPath: string, payload: string): Promise<Record<string, unknown>> {
    return await new Promise((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const framed = takeWireFrame(buffer);
        if (framed == null) return;
        try {
          resolve(decodeWireFrame(framed.frame) as Record<string, unknown>);
        } catch (err) {
          reject(err as Error);
        }
        socket.end();
      });
      socket.on("error", reject);
    });
  }

  it("a failure on a request the daemon did parse echoes that request's id", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    const id = randomUUID();
    const parsed = await rawExchange(paths.socketPath, `${JSON.stringify({ id, op: "no-such-op" })}\n`);

    expect(parsed.ok).toBe(false);
    expect(parsed.id).toBe(id);
    // The rule-3 reader agrees: this is an ordinary refusal, not a dialect
    // downgrade proof — a TOON client keeps speaking TOON after it.
    expect(isUnintelligibleResponse({ id, op: "no-such-op" }, parsed)).toBe(false);
  });

  it("a frame the daemon cannot parse still answers with a fresh id — the real proof", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    const id = randomUUID();
    const parsed = await rawExchange(paths.socketPath, "{{{{\n");

    expect(parsed.ok).toBe(false);
    expect(typeof parsed.id).toBe("string");
    expect(parsed.id).not.toBe(id);
    expect(isUnintelligibleResponse({ id }, parsed)).toBe(true);
  });
});
