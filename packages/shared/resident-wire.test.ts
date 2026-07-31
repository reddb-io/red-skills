// The resident socket speaks TOON, and one daemon serves checkouts pinned to
// different bundle versions (ADR 0130 rule 3) — so the migration is only correct
// if EVERY ordering of the two upgrades still talks. These tests pair an old
// reader with a new writer and the reverse, against real unix sockets, because
// the framing is the part a unit test of the encoder cannot reach.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendLineRequest, serveWireSocket } from "./resident-core.js";
import {
  decodeWireFrame,
  encodeWireFrame,
  isUnintelligibleResponse,
  resetResidentWireDialects,
  sniffWireDialect,
  takeWireFrame,
} from "./resident-wire.js";

interface Envelope {
  id: string;
  op: string;
  note?: string;
}

const servers: Server[] = [];
const roots: string[] = [];

beforeEach(() => {
  resetResidentWireDialects();
});

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  resetResidentWireDialects();
});

async function socketPath(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `resident-wire-${prefix}-`));
  roots.push(root);
  return join(root, "s.sock");
}

async function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

/** The daemon as it is today: reads either encoding, answers in the one it was asked in. */
async function newDaemon(path: string, seen: string[], handled: Envelope[]): Promise<void> {
  await listen(path, (socket) => {
    socket.on("data", (chunk: Buffer | string) => seen.push(chunk.toString()));
    serveWireSocket<Envelope>(
      socket,
      async (request, respond) => {
        handled.push(request);
        respond({ id: request.id, ok: true, value: `handled:${request.op}` });
      },
      (err, request, respond) => {
        respond({ id: request?.id ?? randomUUID(), ok: false, error: String(err) });
      },
    );
  });
}

/** The daemon as it shipped before this migration: one JSON line in, one JSON line out. */
async function oldDaemon(path: string, handled: Envelope[], connections: string[] = []): Promise<void> {
  await listen(path, (socket) => {
    connections.push("connected");
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      socket.pause();
      let request: Envelope | undefined;
      try {
        request = JSON.parse(line) as Envelope;
        handled.push(request);
        socket.write(`${JSON.stringify({ id: request.id, ok: true, value: `handled:${request.op}` })}\n`);
      } catch (err) {
        // The pre-migration daemon has no request to echo an id from — the very
        // fact a newer client reads to recognise it.
        socket.write(`${JSON.stringify({ id: randomUUID(), ok: false, error: String(err) })}\n`);
      } finally {
        socket.end();
      }
    });
  });
}

/** The client as it shipped before this migration: writes JSON, reads one JSON line. */
async function oldClientRequest(path: string, request: Envelope): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
      socket.end();
    });
    socket.on("error", reject);
  });
}

describe("resident wire framing", () => {
  it("reads a JSON frame at its first newline and a TOON frame at its blank line", () => {
    const json = takeWireFrame('{"id":"a"}\nleftover');
    expect(json).toEqual({ frame: '{"id":"a"}', dialect: "json", rest: "leftover" });

    const toon = takeWireFrame("id: a\nop: ping\n\nleftover");
    expect(toon).toEqual({ frame: "id: a\nop: ping\n", dialect: "toon", rest: "leftover" });
  });

  it("owes more bytes rather than half a frame", () => {
    expect(takeWireFrame('{"id":"a"}')).toBeNull();
    expect(takeWireFrame("id: a\nop: ping\n")).toBeNull();
    expect(takeWireFrame("")).toBeNull();
  });

  it("drops leading blank lines instead of reading one as an empty frame", () => {
    expect(takeWireFrame('\n\n{"id":"a"}\n')?.frame).toBe('{"id":"a"}');
  });

  it("names the dialect from the first meaningful byte", () => {
    expect(sniffWireDialect('{"id":"a"}')).toBe("json");
    expect(sniffWireDialect("id: a\n")).toBe("toon");
  });
});

describe("resident wire encodings", () => {
  const value = { id: "abc", op: "ping", nested: { list: ["x", "y"] } };

  it("reads the same message from either encoding — the reader accepts both", () => {
    expect(decodeWireFrame(encodeWireFrame(value, "json").trimEnd())).toEqual(value);
    expect(decodeWireFrame(takeWireFrame(encodeWireFrame(value, "toon"))!.frame)).toEqual(value);
  });

  it("writes TOON, not JSON, when asked for TOON", () => {
    const frame = encodeWireFrame(value, "toon");
    expect(frame.startsWith("{")).toBe(false);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(takeWireFrame(frame)).toMatchObject({ dialect: "toon", rest: "" });
  });

  it("carries a value the TOON encoder alone would refuse", () => {
    // `undefined` is what an optional response field is; the encoder rejects it
    // where `JSON.stringify` drops it, so the wire drops it too.
    const frame = encodeWireFrame({ id: "a", ok: true, storeOpenCount: undefined }, "toon");
    expect(decodeWireFrame(takeWireFrame(frame)!.frame)).toEqual({ id: "a", ok: true });
  });

  it("keeps a newline inside a string from ending the frame early", () => {
    const chatty = { id: "a", last_line: "one\n\ntwo" };
    const frame = encodeWireFrame(chatty, "toon");
    const framed = takeWireFrame(frame)!;
    expect(framed.rest).toBe("");
    expect(decodeWireFrame(framed.frame)).toEqual(chatty);
  });
});

describe("recognising a peer that could not read the request", () => {
  it("reads a fresh id on a refusal as proof the request was never parsed", () => {
    expect(isUnintelligibleResponse({ id: "a" }, { id: "z", ok: false, error: "boom" })).toBe(true);
  });

  it("never mistakes a real refusal, which echoes the id, for an unread dialect", () => {
    expect(isUnintelligibleResponse({ id: "a" }, { id: "a", ok: false, error: "no such worker" })).toBe(false);
    expect(isUnintelligibleResponse({ id: "a" }, { id: "z", ok: true, value: 1 })).toBe(false);
  });
});

describe("resident wire across a rollout", () => {
  it("puts TOON on the wire between a new client and a new daemon", async () => {
    const path = await socketPath("new-new");
    const seen: string[] = [];
    const handled: Envelope[] = [];
    await newDaemon(path, seen, handled);

    const response = await sendLineRequest<Envelope, Record<string, unknown>>({ socketPath: path }, { id: "r1", op: "ping" });

    expect(response).toEqual({ id: "r1", ok: true, value: "handled:ping" });
    expect(seen.join("").startsWith("{")).toBe(false);
    expect(decodeWireFrame(takeWireFrame(seen.join(""))!.frame)).toEqual({ id: "r1", op: "ping" });
  });

  it("answers an OLD client in the JSON it was addressed in", async () => {
    const path = await socketPath("old-new");
    const handled: Envelope[] = [];
    await newDaemon(path, [], handled);

    const response = await oldClientRequest(path, { id: "r2", op: "ping" });

    expect(response).toEqual({ id: "r2", ok: true, value: "handled:ping" });
    expect(handled).toEqual([{ id: "r2", op: "ping" }]);
  });

  it("downgrades to JSON for an OLD daemon, and never makes it run the request twice", async () => {
    const path = await socketPath("new-old");
    const handled: Envelope[] = [];
    await oldDaemon(path, handled);

    const response = await sendLineRequest<Envelope, Record<string, unknown>>(
      { socketPath: path },
      { id: "r3", op: "worker-start" },
    );

    expect(response).toEqual({ id: "r3", ok: true, value: "handled:worker-start" });
    // The TOON attempt died at the old daemon's parse, before it held a request,
    // so the retry is the FIRST and only execution.
    expect(handled).toEqual([{ id: "r3", op: "worker-start" }]);
  });

  it("remembers the downgrade, so a second request costs no extra round trip", async () => {
    const path = await socketPath("remember");
    const handled: Envelope[] = [];
    const connections: string[] = [];
    await oldDaemon(path, handled, connections);

    await sendLineRequest<Envelope, Record<string, unknown>>({ socketPath: path }, { id: "r4", op: "ping" });
    expect(connections).toHaveLength(2); // the TOON attempt, then the JSON retry
    await sendLineRequest<Envelope, Record<string, unknown>>({ socketPath: path }, { id: "r5", op: "ping" });

    expect(connections).toHaveLength(3); // JSON straight away — the peer is remembered
    expect(handled.map((request) => request.id)).toEqual(["r4", "r5"]);
  });

  it("keeps talking to a NEW daemon after a downgrade, because it reads JSON too", async () => {
    const path = await socketPath("downgraded-new");
    const handled: Envelope[] = [];
    await newDaemon(path, [], handled);

    const response = await sendLineRequest<Envelope, Record<string, unknown>>(
      { socketPath: path, wire: "json" },
      { id: "r6", op: "ping" },
    );

    expect(response).toEqual({ id: "r6", ok: true, value: "handled:ping" });
  });
});
