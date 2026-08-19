#!/usr/bin/env node
// A stub child coding Agent that only asks for terminals.
//
// It exists to be REFUSED: the Worker's terminal policy is a decision made on
// the far side of a real ACP connection, and a stub that calls the policy
// function directly would prove the function and not the seam. Each `run` line
// in the prompt becomes one `terminal/create`, and the outcome — allowed with
// its output, or refused with the reason it was given — comes back in `_meta`.
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const ARGUMENT_SEPARATOR = " :: ";

const app = agent({ name: "terminal policy child fixture" })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: {} },
    agentInfo: { name: "terminal policy child fixture", version: "1" },
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: "terminal-policy-child" }))
  .onRequest(methods.agent.session.prompt, async ({ params, client: parent }) => {
    const text = params.prompt
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    const terminals = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("run ")) continue;
      const [command, ...args] = line.slice(4).split(ARGUMENT_SEPARATOR);
      terminals.push(await attempt(parent, params.sessionId, command, args));
    }
    return { stopReason: "end_turn", _meta: { stub: { terminals } } };
  });

async function attempt(parent, sessionId, command, args) {
  try {
    const created = await parent.request(methods.client.terminal.create, { sessionId, command, args });
    const exit = await parent.request(methods.client.terminal.waitForExit, {
      sessionId,
      terminalId: created.terminalId,
    });
    const output = await parent.request(methods.client.terminal.output, {
      sessionId,
      terminalId: created.terminalId,
    });
    await parent.request(methods.client.terminal.release, { sessionId, terminalId: created.terminalId });
    return {
      command,
      allowed: true,
      exitCode: exit.exitCode ?? null,
      output: output.output,
    };
  } catch (error) {
    return {
      command,
      allowed: false,
      message: error?.message ?? String(error),
      data: error?.data ?? null,
    };
  }
}

app.connect(ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin),
));
