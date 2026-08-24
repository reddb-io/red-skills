import { encodeInvitation, encodeInvitationUri } from "@reddb-io/red-skills-link-protocol/crypto";

import { showInvitationQr } from "./qr-terminal.js";
import { createRedskilledLinkStateStore, defaultLinkStatePath } from "./state.js";
import {
  currentRedskilledLinkEntry,
  installRedskilledLinkUnit,
  planRedskilledLinkUnit,
  type RedskilledLinkEntry,
  type RedskilledLinkUnitIO,
} from "./supervision.js";

export interface RedskilledLinkOnboardingIO {
  readonly entry?: RedskilledLinkEntry;
  readonly unitIO?: RedskilledLinkUnitIO;
  readonly write?: (value: string) => void;
  readonly showQr?: typeof showInvitationQr;
}

export async function runRedskilledLinkOnboarding(
  args: readonly string[],
  io: RedskilledLinkOnboardingIO = {},
): Promise<number> {
  const write = io.write ?? ((value: string) => process.stdout.write(value));
  const transport = value(args, "--transport")?.trim().toLowerCase() ?? "wss";
  if (transport === "wireguard") {
    write([
      "WireGuard transport is not available in this build.",
      "Redskilled Mobile will request Android VPN permission itself when the embedded WireGuard transport ships;",
      "opening this PC's VPN settings would not configure the phone. Use the WSS transport for now.",
      "",
    ].join("\n"));
    return 2;
  }
  if (transport !== "wss") throw new Error(`unsupported link transport ${JSON.stringify(transport)}: expected wss or wireguard`);

  const statePath = value(args, "--state") ?? defaultLinkStatePath();
  const relayUrl = value(args, "--relay")?.trim();
  const hostName = value(args, "--name")?.trim();
  const store = createRedskilledLinkStateStore({
    path: statePath,
    ...(relayUrl ? { relayUrl } : {}),
    ...(hostName ? { hostName } : {}),
  });
  if (relayUrl || hostName) await store.configure({ relayUrl, hostName });
  const identity = await store.identity();
  if (!/^wss:\/\//.test(identity.relay_url) && !args.includes("--allow-insecure-relay")) {
    throw new Error(
      `refusing insecure relay ${identity.relay_url}; production pairing requires wss:// ` +
      "(--allow-insecure-relay is only for a local development relay)",
    );
  }

  const unit = await installRedskilledLinkUnit(planRedskilledLinkUnit({
    entry: io.entry ?? currentRedskilledLinkEntry(),
    statePath,
  }), io.unitIO);
  if (!unit.installed) throw new Error(`could not start ${unit.unitPath}: ${unit.detail ?? "unknown systemd failure"}`);

  const invitation = await store.createInvitation();
  const code = encodeInvitation(invitation);
  const uri = encodeInvitationUri(invitation);
  let qrWarning: string | undefined;
  try {
    await (io.showQr ?? showInvitationQr)(uri, invitation.expires_at);
  } catch (error) {
    qrWarning = error instanceof Error ? error.message : String(error);
  }
  write([
    "Redskilled Link is ready.",
    `Host: ${identity.host_name}`,
    `Relay: ${identity.relay_url}`,
    "Transport: WSS (encrypted TOON payloads)",
    `Service: ${unit.installed ? "active" : "unavailable"}`,
    `Expires: ${invitation.expires_at}`,
    ...(qrWarning ? [`QR: unavailable (${qrWarning})`] : []),
    `Connection URI: ${uri}`,
    `Manual code: ${code}`,
    "WireGuard: not available in this build; the mobile app uses WSS.",
    "",
  ].join("\n"));
  return 0;
}

function value(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
