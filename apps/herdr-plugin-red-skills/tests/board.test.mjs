/**
 * The board is the one view whose correctness is NOT this plugin's to prove.
 *
 * Every cell arrives finished from `statusline-dashboard`, so what these assert
 * is the only thing a surface can get wrong: that it prints what it was handed,
 * that it re-derives nothing, that it asks the daemon for the size it has, and
 * that an unreachable host draws an absence rather than a table of zeros.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readBoard } from "../src/commands/board.mjs";
import { createRedskilledClient } from "../src/redskilled/client.mjs";
import { decodeFrame, encodeFrame, takeFrame } from "../src/redskilled/wire.mjs";
import { stripAnsi } from "../src/ui/ansi.mjs";
import { paintRow, renderBoard } from "../src/ui/board.mjs";
import { dashboard } from "./fixtures.mjs";

const SIZE = { columns: 160, rows: 30 };

function state(overrides = {}) {
  return { mode: "global", message: null, ...overrides };
}

function text(lines) {
  return lines.map(stripAnsi).join("\n");
}

async function withDaemon(handler, run) {
  const dir = await mkdtemp(join(tmpdir(), "red-skills-board-"));
  const socketPath = join(dir, "redskilled.sock");
  const seen = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let framed = takeFrame(buffer); framed; framed = takeFrame(buffer)) {
        buffer = framed.rest;
        const request = decodeFrame(framed.frame);
        seen.push(request);
        const response = handler(request);
        if (response !== undefined) socket.write(encodeFrame(response));
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await run({ socketPath, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
}

test("the frame prints the daemon's own lines, header first", () => {
  const board = dashboard();
  const rendered = text(renderBoard({ dashboard: board, state: state(), size: SIZE }));
  for (const line of board.lines) {
    assert.ok(rendered.includes(line), `the board dropped a line the daemon rendered: ${JSON.stringify(line)}`);
  }
  assert.ok(rendered.indexOf(board.header.line) < rendered.indexOf(board.rows[0].line));
});

test("every statusline field reaches the pane", () => {
  const rendered = text(renderBoard({ dashboard: dashboard(), state: state(), size: SIZE }));
  for (const cell of [
    "run=claude opus high",
    "org=afk",
    "iss=3012",
    "██▶░░░",
    "coding·impl",
    "1h0m",
    "hb=3s",
    "loc=+142 -36",
    "tks=45k",
    "tls=12",
    "rsn=4",
    "txt=9",
  ]) {
    assert.ok(rendered.includes(cell), `the pane lost the ${JSON.stringify(cell)} cell`);
  }
});

test("the header line carries the repo, the version, the model and the counts", () => {
  const rendered = text(renderBoard({ dashboard: dashboard(), state: state(), size: SIZE }));
  assert.match(rendered, /» reddb-io\/red-skills v0\.4\.1/);
  assert.match(rendered, /claude·opus·high/);
  assert.match(rendered, /prs=3/);
  assert.match(rendered, /cpr=7/);
  assert.match(rendered, /iss=24/);
});

test("tinting a row changes no visible character, so the daemon's alignment survives", () => {
  const line = dashboard().rows[0].line;
  assert.equal(stripAnsi(paintRow(line)), line);
});

test("no frame is ever wider than the pane", () => {
  const lines = renderBoard({ dashboard: dashboard(), state: state(), size: { columns: 64, rows: 20 } });
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 64, `line overflows the pane: ${JSON.stringify(stripAnsi(line))}`);
  }
});

test("a state change in the daemon reaches the pane without local re-derivation", () => {
  const before = dashboard();
  const after = dashboard({
    lines: ["» reddb-io/red-skills v0.4.1 · wrk=0/0", "…"],
    rows: [],
    stale: true,
  });
  const first = text(renderBoard({ dashboard: before, state: state(), size: SIZE }));
  const second = text(renderBoard({ dashboard: after, state: state(), size: SIZE }));
  assert.match(first, /● live/);
  assert.match(first, /iss=3012/);
  assert.match(second, /● stale/);
  assert.ok(!second.includes("iss=3012"), "the pane kept a row the daemon no longer renders");
});

test("an unreachable daemon draws an absence, never a table of zeros", () => {
  const rendered = text(
    renderBoard({
      dashboard: null,
      state: state(),
      size: SIZE,
      socketPath: "/run/redskilled.sock",
      error: "redskilled is not reachable",
    }),
  );
  assert.match(rendered, /no host answered/);
  assert.match(rendered, /redskilled provision/);
  assert.ok(!/wrk=/.test(rendered), "an absence must not render counts nobody read");
});

test("the read asks statusline-dashboard, states the size, and never writes", async () => {
  await withDaemon(
    (request) =>
      request.op === "statusline-dashboard"
        ? { id: request.id, ok: true, value: dashboard() }
        : { id: request.id, ok: false, error: `unknown op ${request.op}` },
    async ({ socketPath, seen }) => {
      const client = createRedskilledClient({ socketPath });
      const read = await readBoard(client, {
        sessionProject: "reddb-io/red-skills",
        mode: "local",
        maxWidth: 118,
        maxRows: 9,
      });
      assert.equal(read.error, null);
      assert.equal(read.dashboard.version, 1);

      const [request] = seen;
      assert.equal(request.op, "statusline-dashboard");
      assert.equal(request.session_project, "reddb-io/red-skills");
      assert.deepEqual(request.dashboard, {
        mode: "local",
        project: "reddb-io/red-skills",
        max_width: 118,
        max_rows: 9,
      });
      assert.deepEqual(
        seen.filter((entry) => entry.op !== "statusline-dashboard"),
        [],
        "reach is asymmetric: the board is entirely on the reading half",
      );
    },
  );
});

test("a daemon that refuses the op yields an absence rather than a throw", async () => {
  await withDaemon(
    (request) => ({ id: request.id, ok: false, error: "this daemon predates the dashboard" }),
    async ({ socketPath }) => {
      const client = createRedskilledClient({ socketPath });
      const read = await readBoard(client, { mode: "global" });
      assert.equal(read.dashboard, null);
      assert.match(read.error, /predates the dashboard/);
    },
  );
});
