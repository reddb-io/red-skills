// The ACP socket's dual-dialect codec (packages/protocol-acp).
//
// What is proven here: the framing rules hold per frame, the envelope is
// rewritten at the boundary in both directions, writes answer in the dialect
// the peer last proved, and — the part that matters — an unmodified ACP SDK
// connection completes a real request/response round trip when one end of the
// wire is writing TOON-RPC. The resident-wire framing itself is proven in
// `packages/shared/resident-wire.test.ts`; nothing here respells it.
import { describe, expect, it } from "vitest";
import { dualDialectStream } from "@reddb-io/protocol-acp";

function bytePipe(): {
  readable: ReadableStream<Uint8Array>;
  push: (text: string) => void;
  end: () => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const encoder = new TextEncoder();
  return {
    readable,
    push: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

function byteSink(): { writable: WritableStream<Uint8Array>; text: () => string } {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({ write(chunk) { chunks.push(chunk); } });
  return { writable, text: () => chunks.map((c) => new TextDecoder().decode(c)).join("") };
}

async function readMessages(readable: ReadableStream<unknown>, count: number): Promise<unknown[]> {
  const reader = readable.getReader();
  const out: unknown[] = [];
  while (out.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  reader.releaseLock();
  return out;
}

describe("the ACP dual-dialect codec", () => {
  it("reads a JSON line and a TOON document off the same stream, as jsonrpc objects", async () => {
    const pipe = bytePipe();
    const stream = dualDialectStream(byteSink().writable, pipe.readable);

    pipe.push('{"jsonrpc":"2.0","method":"ping","id":1}\n');
    pipe.push('toonrpc: "1.0"\nmethod: pong\nid: 2\n\n');

    const messages = await readMessages(stream.readable, 2);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", method: "ping", id: 1 });
    // The consumer sees the JSON-RPC envelope whatever the wire wore.
    expect(messages[1]).toEqual({ jsonrpc: "2.0", method: "pong", id: 2 });
  });

  it("reassembles a frame split across chunks", async () => {
    const pipe = bytePipe();
    const stream = dualDialectStream(byteSink().writable, pipe.readable);

    pipe.push('toonrpc: "1.0"\nmeth');
    pipe.push("od: ping\nid: 9\n");
    pipe.push("\n");

    const [message] = await readMessages(stream.readable, 1);
    expect(message).toEqual({ jsonrpc: "2.0", method: "ping", id: 9 });
  });

  it("writes JSON before any peer has proven a dialect — shipping this changes nothing", async () => {
    const out = byteSink();
    const stream = dualDialectStream(out.writable, bytePipe().readable);

    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", method: "hello", id: 1 });
    writer.releaseLock();

    expect(out.text()).toBe('{"jsonrpc":"2.0","method":"hello","id":1}\n');
  });

  it("answers a TOON peer in TOON, wearing the toonrpc envelope", async () => {
    const pipe = bytePipe();
    const out = byteSink();
    const stream = dualDialectStream(out.writable, pipe.readable);

    pipe.push('toonrpc: "1.0"\nmethod: ping\nid: 1\n\n');
    await readMessages(stream.readable, 1);

    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", result: "pong", id: 1 });
    writer.releaseLock();

    const written = out.text();
    expect(written.startsWith("toonrpc:")).toBe(true);
    expect(written.endsWith("\n\n")).toBe(true);
    expect(written).toContain("result: pong");
    expect(written).not.toContain("jsonrpc");
  });

  it("keeps answering a JSON peer in JSON even when preferred is toon", async () => {
    const pipe = bytePipe();
    const out = byteSink();
    const stream = dualDialectStream(out.writable, pipe.readable, { preferred: "toon" });

    pipe.push('{"jsonrpc":"2.0","method":"ping","id":1}\n');
    await readMessages(stream.readable, 1);

    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", result: "pong", id: 1 });
    writer.releaseLock();

    expect(out.text()).toBe('{"jsonrpc":"2.0","result":"pong","id":1}\n');
  });

  it("round-trips payload strings that contain blank lines through the TOON framing", async () => {
    const out = byteSink();
    const stream = dualDialectStream(out.writable, bytePipe().readable, { preferred: "toon" });

    const text = "line one\n\nline two";
    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", method: "say", params: { text }, id: 1 });
    writer.releaseLock();

    const echo = bytePipe();
    const reread = dualDialectStream(byteSink().writable, echo.readable);
    echo.push(out.text());
    const [message] = await readMessages(reread.readable, 1);
    expect((message as { params: { text: string } }).params.text).toBe(text);
  });

  it("carries a full SDK round trip with one end writing TOON", async () => {
    const { client, agent, methods } = await import("@agentclientprotocol/sdk");
    // Two byte pipes, crossed: what one side writes, the other reads.
    const aToB = bytePipe();
    const bToA = bytePipe();

    const sideA = dualDialectStream(
      new WritableStream<Uint8Array>({
        write(chunk) { aToB.push(new TextDecoder().decode(chunk)); },
      }),
      bToA.readable,
      { preferred: "toon" },
    );
    const sideB = dualDialectStream(
      new WritableStream<Uint8Array>({
        write(chunk) { bToA.push(new TextDecoder().decode(chunk)); },
      }),
      aToB.readable,
    );

    agent()
      .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .connect(sideB);
    const clientSide = client().connect(sideA);

    const answer = await clientSide.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(answer.protocolVersion).toBe(1);
  });
});

describe("parity with the SDK's ndJsonStream (ADR 0170)", () => {
  it("reads a JSON-RPC batch frame as an array without blocking later frames", async () => {
    const pipe = bytePipe();
    const stream = dualDialectStream(byteSink().writable, pipe.readable);

    pipe.push('[{"jsonrpc":"2.0","method":"ping","id":1},{"jsonrpc":"2.0","method":"ping","id":2}]\n');
    pipe.push('{"jsonrpc":"2.0","method":"after-the-batch","id":3}\n');

    const messages = await readMessages(stream.readable, 2);
    expect(messages[0]).toEqual([
      { jsonrpc: "2.0", method: "ping", id: 1 },
      { jsonrpc: "2.0", method: "ping", id: 2 },
    ]);
    // The frame behind the batch arrives — the batch used to sniff as TOON and
    // wait forever for a blank-line terminator, wedging everything behind it.
    expect(messages[1]).toEqual({ jsonrpc: "2.0", method: "after-the-batch", id: 3 });
  });

  it("skips a malformed frame, reports it, and keeps the connection open", async () => {
    const pipe = bytePipe();
    const stream = dualDialectStream(byteSink().writable, pipe.readable);

    pipe.push('{"jsonrpc":"2.0","method":"broken",\n');
    pipe.push('{"jsonrpc":"2.0","method":"alive","id":1}\n');

    const messages = await readMessages(stream.readable, 1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", method: "alive", id: 1 });
  });

  it("does not latch the peer dialect on a frame that fails to decode", async () => {
    const pipe = bytePipe();
    const sink = byteSink();
    const stream = dualDialectStream(sink.writable, pipe.readable);

    // Garbage that sniffs as TOON but decodes as neither dialect must not flip
    // the connection into answering TOON.
    pipe.push("%%% not a document %%%\n\n");
    pipe.push('{"jsonrpc":"2.0","method":"ping","id":1}\n');
    await readMessages(stream.readable, 1);

    const writer = stream.writable.getWriter();
    await writer.write({ jsonrpc: "2.0", result: {}, id: 1 });
    writer.releaseLock();
    expect(sink.text()).toBe('{"jsonrpc":"2.0","result":{},"id":1}\n');
  });

  it("writes an array as one JSON line even after the peer proved TOON", async () => {
    const pipe = bytePipe();
    const sink = byteSink();
    const stream = dualDialectStream(sink.writable, pipe.readable);

    pipe.push('toonrpc: "1.0"\nmethod: ping\nid: 1\n\n');
    await readMessages(stream.readable, 1);

    const writer = stream.writable.getWriter();
    await writer.write([{ jsonrpc: "2.0", result: {}, id: 1 }] as never);
    writer.releaseLock();
    expect(sink.text()).toBe('[{"jsonrpc":"2.0","result":{},"id":1}]\n');
  });

  it("flushes a final unterminated JSON line at end of input", async () => {
    const pipe = bytePipe();
    const stream = dualDialectStream(byteSink().writable, pipe.readable);

    pipe.push('{"jsonrpc":"2.0","method":"last-words","id":7}');
    pipe.end();

    const messages = await readMessages(stream.readable, 1);
    expect(messages[0]).toEqual({ jsonrpc: "2.0", method: "last-words", id: 7 });
  });

  it("cancel releases the underlying socket reader", async () => {
    let cancelled: unknown = "never";
    const readable = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancelled = reason;
      },
    });
    const stream = dualDialectStream(byteSink().writable, readable);

    await stream.readable.cancel(new Error("session over"));
    expect(cancelled).toEqual(new Error("session over"));
  });
});

describe("an unterminated frame past the byte ceiling refuses the connection", () => {
  it("errors loudly instead of buffering the peer's bytes forever", async () => {
    const { readable: inputReadable, writable: inputWritable } = new TransformStream<Uint8Array, Uint8Array>();
    const output = new WritableStream<Uint8Array>({ write: () => undefined });
    const stream = dualDialectStream(output, inputReadable);
    const reader = stream.readable.getReader();
    const writer = inputWritable.getWriter();

    // A TOON-sniffed frame (no leading '{' or '[') that never sends its blank
    // line: 9 MiB of un-terminated bytes, in 1 MiB chunks.
    const chunk = new TextEncoder().encode("k: " + "x".repeat(1_048_576 - 4) + " ");
    const feed = (async () => {
      for (let i = 0; i < 9; i += 1) await writer.write(chunk);
    })();

    await expect(reader.read()).rejects.toThrow(/exceeded .* without a terminator/);
    await feed.catch(() => undefined);
  });
});
