#!/usr/bin/env node
/**
 * cli — the `redskilled` entrypoint: `serve` runs the daemon, `host-state` reads it.
 *
 * `serve` takes every path as a flag and derives none. ADR 0130 rule 3 makes
 * that a contract, not a style: the daemon must never learn repository layout,
 * because the moment it does, it stops being servable by checkouts on different
 * bundle versions. A path it needs is a path it was given.
 */
import { readFileSync } from "node:fs";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, routeCommand } from "@reddb-io/shared/args.js";
import { findUp } from "@reddb-io/shared/plugin-gate.js";
import { declaredProjectNameInConfig } from "@reddb-io/shared/project-identity.js";
import { readRedskilledHostState, readRedskilledStatuslineString } from "./client.js";
import { DEFAULT_REDSKILLED_IDLE_MS, startRedskilledDaemon } from "./daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import {
  parseRedskilledStatuslineFlags,
  resolveRedskilledStatuslineOptions,
} from "./statusline-config.js";

const SERVE_FLAGS = {
  socket: { kind: "value", coerce: (raw: string) => raw },
  lease: { kind: "value", coerce: (raw: string) => raw },
  events: { kind: "value", coerce: (raw: string) => raw },
  "session-key-hash": { kind: "value", coerce: (raw: string) => raw },
  "machine-id-hash": { kind: "value", coerce: (raw: string) => raw },
  "idle-ms": { kind: "value", coerce: (raw: string) => Number(raw) },
  "daemon-version": { kind: "value", coerce: (raw: string) => raw },
} as const;

export async function runRedskilledCli(argv: readonly string[]): Promise<number> {
  // Answered before routing, because the daemon's own version is the fact a
  // skew investigation starts from — and `serve` takes `--daemon-version` from
  // its caller, so the binary must still be able to state what IT is.
  if (argv[0] === "--version" || argv[0] === "-v") {
    const info = readBuildInfo("redskilled");
    process.stdout.write(
      argv.includes("--json") ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`,
    );
    return 0;
  }

  const { command, args } = routeCommand<"serve" | "host-state" | "statusline">(argv, {
    commands: { serve: {}, "host-state": {}, statusline: {} },
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

  if (command === "statusline") return await runStatusline(args);

  const state = await readRedskilledHostState(resolveRedskilledPaths());
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  return 0;
}

/**
 * `redskilled statusline [global] [--verbose] [--flags]` — the whole of an agent
 * host's job.
 *
 * The host runs this and prints the one line it writes; it decides nothing about
 * shape, order, width or degradation, because ADR 0130 rule 10 moves rendering
 * off every host so that a second host cannot drift from the first. Config is
 * read HERE, on the client side, and only decided values cross the socket.
 */
export async function runStatusline(
  args: readonly string[],
  io: {
    readonly cwd?: string;
    /** The session's socket; derived from the environment when absent. */
    readonly paths?: RedskilledPaths;
    readonly write?: (line: string) => void;
    readonly warn?: (line: string) => void;
  } = {},
): Promise<number> {
  const write = io.write ?? ((line: string) => process.stdout.write(line));
  const warn = io.warn ?? ((line: string) => process.stderr.write(line));

  const parsed = parseRedskilledStatuslineFlags(args);
  const project = readProjectConfig(io.cwd ?? process.cwd());
  const resolved = resolveRedskilledStatuslineOptions({
    configText: project.configText,
    project: project.name,
    flags: parsed.flags,
  });
  for (const warning of [...resolved.warnings, ...parsed.warnings]) {
    warn(`redskilled statusline: ignoring ${warning.key}=${warning.value} — ${warning.reason}\n`);
  }

  const render = await readRedskilledStatuslineString(io.paths ?? resolveRedskilledPaths(), resolved.options, {
    ...(resolved.options.project == null ? {} : { sessionProject: resolved.options.project }),
  });
  // Every line the daemon rendered, in order — one write, whatever the taste.
  // With `--verbose` that is the Worker line plus a second line per Worker; the
  // host still decides nothing about shape (ADR 0130 rule 10).
  write(`${render.lines.join("\n")}\n`);
  return 0;
}

/** The nearest `.red/config.yaml`, and the project name it declares. */
function readProjectConfig(cwd: string): { configText?: string; name: string | null } {
  const path = findUp(cwd, ".red/config.yaml");
  if (path == null) return { name: null };
  let configText: string;
  try {
    configText = readFileSync(path, "utf8");
  } catch {
    return { name: null };
  }
  return { configText, name: declaredProjectNameInConfig(configText) ?? null };
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
  events?: string;
  "session-key-hash"?: string;
  "machine-id-hash"?: string;
}): RedskilledPaths {
  const derived = resolveRedskilledPaths();
  return {
    ...derived,
    socketPath: values.socket ?? derived.socketPath,
    leasePath: values.lease ?? derived.leasePath,
    eventLanePath: values.events ?? derived.eventLanePath,
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
