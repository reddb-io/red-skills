#!/usr/bin/env node
// A stub child coding Agent shaped like the one that leaked: a WRAPPER.
//
// The real endpoint is `npx`, which spawns the platform Agent binary as its own
// child, so the pid the Worker holds is never the process holding the session.
// This fixture reproduces that shape with nothing but node: it spawns a
// grandchild that sleeps forever, writes BOTH pids to the file named in argv so
// the test can watch them, and only then serves ACP.
//
// Writing the pids before the connection is what makes the test race-free: the
// Worker's own handshake cannot complete until this process is already past the
// spawn, so a test that got an answer has a pid file on disk.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

const pidFile = process.argv[2];

// Nothing to reap here on purpose: this fixture must NOT tidy up after itself,
// because the orphan it leaves is exactly what the Worker is supposed to kill.
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
grandchild.unref();

writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));

const app = agent({ name: "orphan child fixture" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: {} },
    agentInfo: { name: "orphan child fixture", version: "1" },
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: "orphan-child" }))
  .onRequest(methods.agent.session.prompt, () => ({
    stopReason: "end_turn",
    _meta: { stub: { child: process.pid, grandchild: grandchild.pid } },
  }));

app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));
