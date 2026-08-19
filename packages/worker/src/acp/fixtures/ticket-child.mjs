#!/usr/bin/env node
// A stub child coding Agent that does the one thing the contract allows: it
// EDITS AND COMMITS.
//
// It exists so the Ticket loop can be proved across a real ACP connection with
// a real process on the far side. Every effect it has goes through
// `terminal/create`, which is the seam the Worker's policy sits on — including
// one `git push` it is refused, because the whole loop after the gate is the
// promise that refusal makes.
//
// The round is read off the handoff rather than counted, because a re-seed is
// the SAME child being re-instructed: a counter in this process would be a
// counter the loop could not reset, and the handoff is what actually changed.
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const terminals = [];

const app = agent({ name: "ticket child fixture" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: {} },
    agentInfo: { name: "ticket child fixture", version: "1" },
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: "ticket-child" }))
  .onRequest(methods.agent.session.prompt, async ({ params, client: parent }) => {
    const text = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const reseeded = text.includes("blocked round");

    if (!reseeded) {
      // The refusal comes first, so the rest of the round is what the agent
      // does AFTER being told publication is not its to perform.
      terminals.push(await run(parent, params.sessionId, "git", ["push", "origin", "HEAD"]));
      terminals.push(await run(parent, params.sessionId, "sh", ["-c", "printf 'implemented\\n' > ticket.txt"]));
      terminals.push(await run(parent, params.sessionId, "git", ["add", "--", "ticket.txt"]));
      terminals.push(await run(parent, params.sessionId, "git", ["commit", "-m", "Refs #4020: implement"]));
    } else {
      terminals.push(await run(parent, params.sessionId, "sh", ["-c", "printf 'green\\n' > gate-marker.txt"]));
      terminals.push(await run(parent, params.sessionId, "git", ["add", "--", "gate-marker.txt"]));
      terminals.push(await run(parent, params.sessionId, "git", ["commit", "-m", "Refs #4020: satisfy the gate"]));
    }

    return { stopReason: "end_turn", _meta: { stub: { reseeded, terminals } } };
  });

async function run(parent, sessionId, command, args) {
  try {
    const created = await parent.request(methods.client.terminal.create, { sessionId, command, args });
    const exit = await parent.request(methods.client.terminal.waitForExit, {
      sessionId,
      terminalId: created.terminalId,
    });
    await parent.request(methods.client.terminal.release, { sessionId, terminalId: created.terminalId });
    return { command: [command, ...args].join(" "), allowed: true, exitCode: exit.exitCode ?? null };
  } catch (error) {
    return { command: [command, ...args].join(" "), allowed: false, message: error?.message ?? String(error) };
  }
}

app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));
