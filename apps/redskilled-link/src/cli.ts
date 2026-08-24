#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createRedskillsOperatorAcpClient } from "@reddb-io/redskilled/acp-operator-client";
import { encodeInvitation, encodeInvitationUri } from "@reddb-io/red-skills-link-protocol/crypto";

import { runRedskilledLinkHost } from "./host.js";
import { runRedskilledLinkOnboarding } from "./onboarding.js";
import { showInvitationQr } from "./qr-terminal.js";
import { startRedskilledRelay } from "./relay.js";
import { createRedskilledLinkStateStore } from "./state.js";

export const REDSKILLED_LINK_USAGE = [
  "redskilled-link onboard [--relay wss://relay.example] [--name HOST]",
  "redskilled-link relay [--host 127.0.0.1] [--port 8787]",
  "redskilled-link invite [--relay wss://relay.example] [--name HOST] [--qr]",
  "redskilled-link host [--relay wss://relay.example] [--name HOST]",
  "",
].join("\n");

export async function runRedskilledLinkCli(argv: readonly string[]): Promise<number> {
  const [command = "help", ...args] = argv;
  if (command === "onboard") return await runRedskilledLinkOnboarding(args);
  if (command === "relay") {
    const relay = await startRedskilledRelay({
      host: value(args, "--host") ?? "127.0.0.1",
      port: Number(value(args, "--port") ?? 8787),
    });
    process.stdout.write(`redskilled-link relay listening on ${relay.port}\n`);
    return 0;
  }
  if (command === "invite") {
    const store = stateStore(args);
    const relayUrl = value(args, "--relay")?.trim();
    const hostName = value(args, "--name")?.trim();
    if (relayUrl || hostName) await store.configure({ relayUrl, hostName });
    const invitation = await store.createInvitation();
    const code = encodeInvitation(invitation);
    const uri = encodeInvitationUri(invitation);
    if (args.includes("--qr")) await showInvitationQr(uri, invitation.expires_at);
    process.stdout.write(`Connection URI: ${uri}\nManual code: ${code}\n`);
    return 0;
  }
  if (command === "host") {
    const store = stateStore(args);
    const relayUrl = value(args, "--relay")?.trim();
    const hostName = value(args, "--name")?.trim();
    if (relayUrl || hostName) await store.configure({ relayUrl, hostName });
    await store.identity();
    await runRedskilledLinkHost({ state: store, operator: createRedskillsOperatorAcpClient() });
    return 0;
  }
  process.stdout.write(REDSKILLED_LINK_USAGE);
  return 0;
}

function stateStore(args: readonly string[]) {
  const relayUrl = value(args, "--relay")?.trim();
  const hostName = value(args, "--name")?.trim();
  return createRedskilledLinkStateStore({
    ...(relayUrl ? { relayUrl } : {}),
    ...(hostName ? { hostName } : {}),
    ...(value(args, "--state") == null ? {} : { path: value(args, "--state")! }),
  });
}

function value(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

const invokedDirectly = process.argv[1] != null &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  runRedskilledLinkCli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`redskilled-link: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
