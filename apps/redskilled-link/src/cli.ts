import { createRedskillsOperatorAcpClient } from "@reddb-io/redskilled/acp-operator-client";

import { encodeInvitation } from "@reddb-io/red-skills-link-protocol/crypto";
import { runRedskilledLinkHost } from "./host.js";
import { startRedskilledRelay } from "./relay.js";
import { createRedskilledLinkStateStore } from "./state.js";

const [command = "help", ...args] = process.argv.slice(2);

if (command === "relay") {
  const relay = await startRedskilledRelay({
    host: value(args, "--host") ?? "127.0.0.1",
    port: Number(value(args, "--port") ?? 8787),
  });
  process.stdout.write(`redskilled-link relay listening on ${relay.port}\n`);
} else if (command === "invite") {
  const relayUrl = required(args, "--relay");
  const store = createRedskilledLinkStateStore({
    relayUrl,
    ...(value(args, "--state") == null ? {} : { path: value(args, "--state")! }),
    ...(value(args, "--name") == null ? {} : { hostName: value(args, "--name")! }),
  });
  process.stdout.write(`${encodeInvitation(await store.createInvitation())}\n`);
} else if (command === "host") {
  const relayUrl = required(args, "--relay");
  const store = createRedskilledLinkStateStore({
    relayUrl,
    ...(value(args, "--state") == null ? {} : { path: value(args, "--state")! }),
    ...(value(args, "--name") == null ? {} : { hostName: value(args, "--name")! }),
  });
  await runRedskilledLinkHost({ state: store, operator: createRedskillsOperatorAcpClient() });
} else {
  process.stdout.write([
    "redskilled-link relay [--host 127.0.0.1] [--port 8787]",
    "redskilled-link invite --relay wss://relay.example [--name HOST]",
    "redskilled-link host --relay wss://relay.example [--name HOST]",
    "",
  ].join("\n"));
}

function value(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function required(args: readonly string[], name: string): string {
  const found = value(args, name)?.trim();
  if (!found) throw new Error(`${name} is required`);
  return found;
}
