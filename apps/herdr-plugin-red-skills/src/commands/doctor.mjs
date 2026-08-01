/**
 * doctor — why this plugin sees what it sees.
 *
 * It is asked under exactly one condition: a pane showed "no host answered" and
 * the operator does not believe it. So every check names the value it used AND
 * the rule that produced it — a report that said "socket: not found" without
 * saying which of three derivations produced the path leaves the reader exactly
 * where they started.
 *
 * It probes and never spawns, for the same reason `/red-doctor` does: a doctor
 * that started the daemon it is reporting on cannot report on it.
 */
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";

import { createRedskilledClient } from "../redskilled/client.mjs";
import { resolveRedskilledPaths } from "../redskilled/paths.mjs";
import { resolveProjectLabel } from "../redskilled/project-identity.mjs";
import { configDir, stateDir } from "../config.mjs";
import { herdrBin, insideHerdr, invocationCwd, pluginId } from "../herdr.mjs";
import { style } from "../ui/ansi.mjs";

function verdict(ok, text) {
  return `${ok ? style.brightGreen("ok  ") : style.brightRed("fail")} ${text}`;
}

function note(text) {
  return `${style.gray("--  ")} ${text}`;
}

export async function runDoctor({ config, flags = {} }) {
  const socket = resolveRedskilledPaths({ socketPath: flags.socket ?? config.socketPath });
  const lines = [];

  lines.push(style.bold("herdr"));
  lines.push(verdict(insideHerdr(), `HERDR_ENV=1 — this process ${insideHerdr() ? "is" : "is NOT"} inside a herdr pane`));
  lines.push(note(`binary       ${herdrBin()}`));
  lines.push(note(`plugin id    ${pluginId()}`));
  lines.push(note(`config dir   ${configDir()}`));
  lines.push(note(`state dir    ${stateDir()}`));
  lines.push(note(`config file  ${config.path}${config.present ? "" : style.gray(" (absent — running on declared defaults)")}`));

  lines.push("");
  lines.push(style.bold("redskilled"));
  lines.push(note(`socket       ${socket.socketPath}`));
  lines.push(note(`resolved by  ${socket.source}`));
  lines.push(note(`runtime dir  ${socket.runtimeDir}`));
  lines.push(note(`event lane   ${socket.eventLanePath}`));

  let present = false;
  try {
    await access(socket.socketPath, constants.R_OK | constants.W_OK);
    present = true;
  } catch (error) {
    lines.push(verdict(false, `the socket file is not usable: ${error.code ?? error.message}`));
  }
  if (present) lines.push(verdict(true, "the socket file exists and is readable"));

  const client = createRedskilledClient({ socketPath: socket.socketPath, timeoutMs: config.timeoutMs });
  let reachable = false;
  try {
    const pong = await client.ping();
    reachable = true;
    lines.push(verdict(true, `the daemon answered: v${pong.daemon_version} · pid ${pong.pid} · protocol ${pong.protocol_version}`));
  } catch (error) {
    lines.push(verdict(false, error.message));
    lines.push(note(style.gray("nothing here starts the daemon — run `redskilled provision` or `redskilled provision --check`")));
  }

  if (reachable) {
    try {
      const payload = await client.statuslinePayload();
      lines.push(
        verdict(
          true,
          `statusline-payload: ${payload.host.worker_count} Worker(s) · ${payload.host.project_count} project(s) · ` +
            `${payload.repository_activity?.projects?.length ?? 0} repository(ies) polled${payload.staleness.stale ? style.yellow(" · STALE") : ""}`,
        ),
      );
    } catch (error) {
      lines.push(verdict(false, `statusline-payload refused: ${error.message}`));
    }
  }

  try {
    const lane = await stat(socket.eventLanePath);
    lines.push(verdict(true, `the event lane is ${lane.size} bytes`));
  } catch {
    lines.push(note("no event lane on disk — a daemon writes one the first time it births a Worker"));
  }

  lines.push("");
  lines.push(style.bold("this directory"));
  // Run as a herdr action, `process.cwd()` is the PLUGIN checkout — herdr runs
  // runtime commands there — so reporting it alone would answer a question
  // nobody asked. The invocation cwd is the operator's, and both are named.
  const invoked = await invocationCwd().catch(() => null);
  const target = invoked ?? process.cwd();
  lines.push(note(`process cwd  ${process.cwd()}${invoked ? style.gray(" (the plugin checkout, as herdr runs actions)") : ""}`));
  if (invoked) lines.push(note(`invoked from ${invoked}`));

  const label = await resolveProjectLabel(target).catch(() => null);
  lines.push(
    label
      ? verdict(true, `project label ${style.brightCyan(label)} — local mode scopes to this`)
      : note("no project label resolves here, so local mode has nothing to scope to"),
  );

  process.stdout.write(`${lines.join("\n")}\n`);
  return reachable ? 0 : 1;
}
