#!/usr/bin/env node
/**
 * cli — the `redskilled` entrypoint: `serve` runs the daemon, `host-state` reads it.
 *
 * `serve` takes every path as a flag and derives none. ADR 0130 rule 3 makes
 * that a contract, not a style: the daemon must never learn repository layout,
 * because the moment it does, it stops being servable by checkouts on different
 * bundle versions. A path it needs is a path it was given.
 */
import { parseFlags, routeCommand } from "@reddb-io/shared/args.js";
import { readRedskilledHostState } from "./client.js";
import { DEFAULT_REDSKILLED_IDLE_MS, startRedskilledDaemon } from "./daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";

const SERVE_FLAGS = {
  socket: { kind: "value", coerce: (raw: string) => raw },
  lease: { kind: "value", coerce: (raw: string) => raw },
  "session-key-hash": { kind: "value", coerce: (raw: string) => raw },
  "machine-id-hash": { kind: "value", coerce: (raw: string) => raw },
  "idle-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
  "daemon-version": { kind: "value", coerce: (raw: string) => raw },
} as const;

export async function runRedskilledCli(argv: readonly string[]): Promise<number> {
  const { command, args } = routeCommand<"serve" | "host-state">(argv, {
    commands: { serve: {}, "host-state": {} },
    default: "host-state",
  });

  if (command === "serve") {
    const { values } = parseFlags(args, SERVE_FLAGS);
    const daemon = await startRedskilledDaemon({
      paths: servePaths(values),
      idleMs: values["idle-ms"] ?? DEFAULT_REDSKILLED_IDLE_MS,
      daemonVersion: values["daemon-version"],
    });
    await daemon.closed;
    return 0;
  }

  const state = await readRedskilledHostState(resolveRedskilledPaths());
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
}

/**
 * The serve paths: flags first, the session derivation only for what is absent.
 *
 * A supervisor unit passes everything; a hand-run `redskilled serve` passes
 * nothing and still lands on the same session socket as its clients.
 */
function servePaths(values: {
  socket?: string;
  lease?: string;
  "session-key-hash"?: string;
  "machine-id-hash"?: string;
}): RedskilledPaths {
  const derived = resolveRedskilledPaths();
  return {
    ...derived,
    socketPath: values.socket ?? derived.socketPath,
    leasePath: values.lease ?? derived.leasePath,
    sessionKeyHash: values["session-key-hash"] ?? derived.sessionKeyHash,
    machineIdHash: values["machine-id-hash"] ?? derived.machineIdHash,
  };
}

const invokedDirectly = process.argv[1] != null &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  runRedskilledCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`redskilled: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
