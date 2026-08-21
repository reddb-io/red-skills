#!/usr/bin/env node
/**
 * red-skills-herdr — the herdr plugin's single entrypoint.
 *
 * `--help` and `--version` are asked under exactly the conditions everything
 * else here is broken under: no daemon, no socket, a config file nobody can
 * read. So both answer from constants on the static path, before a socket, a
 * config file or the filesystem is touched.
 *
 * The binary is `red-skills-herdr` rather than `red-skills`: this monorepo
 * already ships `@reddb-io/red-skills`, and two packages claiming one bin name
 * is a collision resolved by whichever installed last (ADR 0131).
 */
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { fileURLToPath } from "node:url";

import { loadConfig, writeDefaultConfig } from "../src/config.mjs";

/** The name this binary is installed and reported as. */
const BINARY = "red-skills-herdr";

/**
 * The plugin version this file was shipped as.
 *
 * The stamp is the authority when there is one; a checkout run has none, and a
 * version answer of `0.0.0-dev` from a plugin whose manifest says `0.1.0` reads
 * as a broken install rather than as an unbundled one. `scripts/check-manifest.py`
 * asserts this constant still equals the manifest's version.
 */
const CHECKOUT_VERSION = "4.1.21";

const USAGE = `Usage: red-skills-herdr <command> [options]

A herdr plugin that reads the redskilled host daemon: Workers, logs, open pull
requests, and the notifications behind them. It reads and never writes.

Commands:
  board                the statusline as a table: header plus one row per Worker
  dashboard            the live pane: host, Workers, projects, pull requests
  logs                 tail one Worker's log, or the host event lane
  status               print the daemon's own status line
  watch                poll the daemon and raise herdr notifications
  pane <action>        open | close | focus | toggle a plugin pane
  doctor               where the socket resolved from, and what answered
  init-config          write the default config file, if there is none

Options:
  --socket <path>      pin the daemon socket, ahead of every derivation
  --mode <local|global>  this project, or the whole machine
  --project <label>    scope logs to one project's newest Worker
  --worker <id>        scope logs to one Worker
  --events             read the host event lane instead of a Worker's log
  --local              resolve the project label from the working directory
  --refresh-ms <n>     how often a pane re-reads the daemon
  --verbose            show each Worker's last published line
  --json               machine-readable output, where a command has one
  --notify             also raise the answer as a herdr notification
  --once               one poll, then exit (watch, board)
  --max-width <n>      the width budget the daemon renders to (board)
  --detach             start the watcher as a detached child, then return
  --placement <p>      overlay | split | tab | zoomed (pane)
  --direction <d>      right | down (pane)
  --no-focus           leave the operator's focus where it is (pane)

  --version, -v        print the version; answers offline
  --help, -h           print this usage; answers offline
`;

/** Split argv into a command, its flags and its positionals. PURE. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      if (arg === "-h") {
        flags.help = true;
        continue;
      }
      if (arg === "-v") {
        flags.version = true;
        continue;
      }
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (name.startsWith("no-")) {
      flags[name.slice(3).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = false;
      continue;
    }
    const next = argv[index + 1];
    if (inline !== undefined) {
      flags[key] = inline;
    } else if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  const numeric = ["refreshMs", "maxWidth"];
  for (const key of numeric) {
    if (typeof flags[key] === "string") flags[key] = Number(flags[key]);
  }
  return { command: positional[0] ?? null, positional: positional.slice(1), flags };
}

/**
 * The version line, off the build stamp and nothing else. PURE.
 *
 * Unbundled the stamp is absent and every field reads as a default; the plugin's
 * own constant stands in for the version so the answer names a real release,
 * marked `+checkout` so nobody mistakes a working tree for one.
 */
export function versionLine() {
  const info = readBuildInfo(BINARY);
  if (info.version === "0.0.0-dev") info.version = `${CHECKOUT_VERSION}+checkout`;
  return renderVersion(info);
}

async function main(argv) {
  const { command, positional, flags } = parseArgs(argv);

  if (flags.help || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (flags.version) {
    process.stdout.write(`${versionLine()}\n`);
    return 0;
  }

  const config = await loadConfig();

  switch (command ?? "dashboard") {
    case "board": {
      const { runBoard } = await import("../src/commands/board.mjs");
      return await runBoard({ config, flags });
    }
    case "dashboard": {
      const { runDashboard } = await import("../src/commands/dashboard.mjs");
      await runDashboard({ config, flags });
      return 0;
    }
    case "logs": {
      const { runLogs } = await import("../src/commands/logs.mjs");
      await runLogs({ config, flags });
      return 0;
    }
    case "events": {
      const { runLogs } = await import("../src/commands/logs.mjs");
      await runLogs({ config, flags: { ...flags, events: true } });
      return 0;
    }
    case "status": {
      const { runStatus } = await import("../src/commands/status.mjs");
      return await runStatus({ config, flags });
    }
    case "watch": {
      const { runWatch } = await import("../src/commands/watch.mjs");
      return await runWatch({ config, flags });
    }
    case "pane": {
      const { runPane } = await import("../src/commands/pane.mjs");
      return await runPane({
        action: positional[0] ?? "toggle",
        entrypoint: flags.entrypoint ?? positional[1] ?? "dashboard",
        flags,
      });
    }
    case "doctor": {
      const { runDoctor } = await import("../src/commands/doctor.mjs");
      return await runDoctor({ config, flags });
    }
    case "init-config": {
      const path = await writeDefaultConfig();
      process.stdout.write(`red-skills-herdr: config at ${path}\n`);
      return 0;
    }
    default:
      process.stderr.write(`red-skills-herdr: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
      return 2;
  }
}

// Only run when invoked as a program: the tests import `parseArgs` from here.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2))
    .then((code) => {
      if (typeof code === "number" && code !== 0) process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`red-skills-herdr: ${error?.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
