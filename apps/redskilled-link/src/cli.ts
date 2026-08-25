#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createRedskillsOperatorAcpClient } from "@reddb-io/redskilled/acp-operator-client";
import { encodeInvitation, encodeInvitationUri } from "@reddb-io/red-skills-link-protocol/crypto";

import { runRedskilledLinkHost } from "./host.js";
import { runRedskilledLinkOnboarding } from "./onboarding.js";
import { showInvitationQr } from "./qr-terminal.js";
import { startRedskilledRelay } from "./relay.js";
import {
  createRedskilledLinkStateStore,
  defaultLinkStatePath,
  defaultLinkStatusPath,
  readPublicLinkStatus,
} from "./state.js";
import { renderLinkStatusReport } from "./status-report.js";
import {
  currentRedskilledLinkEntry,
  installRedskilledLinkUnit,
  planRedskilledLinkUnit,
  readRedskilledLinkUnitStatus,
  removeRedskilledLinkUnit,
} from "./supervision.js";

export const REDSKILLED_LINK_USAGE = [
  "redskilled-link onboard [--relay wss://relay.example] [--name HOST]",
  "redskilled-link relay [--host 127.0.0.1] [--port 8787]",
  "redskilled-link invite [--relay wss://relay.example] [--name HOST] [--qr]",
  "redskilled-link host [--relay wss://relay.example] [--name HOST]",
  "redskilled-link unit install|remove|status [--state PATH]",
  "redskilled-link status [--state PATH]",
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
  if (command === "unit") {
    return await runUnitCommand(args);
  }
  if (command === "status") {
    // Probe-only on purpose: this report answers about the daemon that IS
    // there; ensuring one would change the machine to describe it.
    const daemon = await createRedskillsOperatorAcpClient(undefined, { ensure: false })
      .state()
      .then((state) => ({ reachable: true as const, state }))
      .catch((error: unknown) => ({
        reachable: false as const,
        reason: error instanceof Error ? error.message : String(error),
      }));
    const statePath = value(args, "--state");
    const publishedPath = statePath == null
      ? defaultLinkStatusPath()
      : join(dirname(statePath), "status.json");
    process.stdout.write(renderLinkStatusReport({
      daemon,
      unit: readRedskilledLinkUnitStatus(),
      published: await readPublicLinkStatus(publishedPath),
      publishedPath,
    }));
    return daemon.reachable ? 0 : 1;
  }
  process.stdout.write(REDSKILLED_LINK_USAGE);
  return 0;
}

/**
 * Supervise the Host companion the way the daemon supervises itself: a
 * systemd user unit with an absolute ExecStart and Restart=always. `status`
 * answers from BOTH authorities — systemd for the process, and the public
 * `status.json` projection the state store publishes for what the link has
 * actually done — because a running unit with zero paired devices and a dead
 * unit with three are different outages.
 */
async function runUnitCommand(args: readonly string[]): Promise<number> {
  const [operation = "status"] = args;
  if (operation === "install") {
    const statePath = value(args, "--state") ?? defaultLinkStatePath();
    const unit = await installRedskilledLinkUnit(planRedskilledLinkUnit({
      entry: currentRedskilledLinkEntry(),
      statePath,
    }));
    if (!unit.installed) {
      process.stderr.write(`redskilled-link unit: ${unit.detail ?? "systemd refused the install"}\n`);
      return 1;
    }
    process.stdout.write(`Host companion installed and started: ${unit.unitPath}\n`);
    return 0;
  }
  if (operation === "remove") {
    const removal = await removeRedskilledLinkUnit();
    if (!removal.removed) {
      process.stderr.write(`redskilled-link unit: ${removal.detail ?? "systemd refused the removal"}\n`);
      return 1;
    }
    process.stdout.write(`Host companion removed: ${removal.unitPath}\n`);
    return 0;
  }
  if (operation === "status") {
    const unit = readRedskilledLinkUnitStatus();
    const statePath = value(args, "--state");
    const statusPath = statePath == null
      ? defaultLinkStatusPath()
      : join(dirname(statePath), "status.json");
    const published = await readPublicLinkStatus(statusPath);
    process.stdout.write([
      `Unit: ${unit.unitName}`,
      `Active: ${unit.active ?? "unknown (systemd did not answer)"}`,
      `Enabled: ${unit.enabled ?? "unknown (systemd did not answer)"}`,
      published == null
        ? `Published status: none at ${statusPath} (the companion has not written one yet)`
        : `Paired devices: ${published.active_paired_device_count}`,
      "",
    ].join("\n"));
    return 0;
  }
  process.stderr.write(`redskilled-link unit: unknown operation ${JSON.stringify(operation)}\n${REDSKILLED_LINK_USAGE}`);
  return 2;
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
