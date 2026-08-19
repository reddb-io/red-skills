/**
 * provision-command — `redskilled provision`, the ONE route to a ready machine.
 *
 * It sits beside the CLI rather than inside it for the same reason
 * `dashboard-command` and `statusline-command` do: the verb owns a whole
 * sequence — read what the host needs, install the OS service, start the daemon
 * through it, audit the result — and a router is a place to dispatch from, not a
 * place to keep a sequence.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import { parseFlags } from "@reddb-io/shared/args.js";
import { readBuildInfo } from "@reddb-io/build-info";
import { birthRedskilledDaemon } from "./daemon-birth.js";
import type { RedskilledClientConfig } from "./client.js";
import { isResolvedRedskilledEntry } from "./daemon-entry.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "./paths.js";
import {
  auditRedskilledProvisioning,
  installRedskilledUserUnit,
  provisionRedskilledHome,
  readRedskilledHomeNeed,
  readRedskilledProvisionFacts,
  renderRedskilledUserUnit,
} from "./provision.js";
import { stabilizeRedskilledEntry } from "./stable-bundle.js";

const PROVISION_FLAGS = {
  "no-start": { kind: "boolean" },
  "no-unit": { kind: "boolean" },
  check: { kind: "boolean" },
  /** The repository whose declared workspace target decides whether the home is needed. */
  project: { kind: "value", coerce: (raw: string) => raw },
  /** A workspace target stated outright — the moment an operator selects one. */
  workspace: { kind: "value", coerce: (raw: string) => raw },
} as const;

/**
 * `redskilled provision` — a machine with no prior state, made ready.
 *
 * **It installs the always-on OS service and starts the daemon through it**
 * (ADR 0150 §4), prints the audit, and creates the host-scoped state home
 * **when a declared workspace target reads it**
 * (`--workspace host`, or a repository whose config declares it). The home is not
 * a precondition for a daemon — the daemon never resolves that state directory
 * (host policy is the sibling `~/.red/config.yaml`) — so creating it
 * unconditionally left most machines with a directory nothing would ever open
 * (#2958).
 *
 * **Idempotent**: a second run creates nothing, rewrites nothing and reports the
 * same verdicts, which is what makes it safe for `/red-setup` to run on every
 * pass rather than only when something looks wrong.
 *
 * `--check` is the read-only half — the shape `/red-doctor` consumes — and never
 * creates or starts anything.
 */
export async function runProvision(
  args: readonly string[],
  io: {
    readonly write?: (text: string) => void;
    /** The session to provision; derived from the environment when absent. */
    readonly paths?: RedskilledPaths;
    readonly homeDir?: string;
    readonly configHome?: string;
    /** The repository in view when no `--project` is stated. */
    readonly projectRoot?: string;
    /** Client options for the start, so a test can pose as another host. */
    readonly client?: RedskilledClientConfig;
  } = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  const { values } = parseFlags(args, PROVISION_FLAGS);
  const paths = io.paths ?? resolveRedskilledPaths();
  const homeDir = io.homeDir ?? homedir();

  // The need is read BEFORE anything is created: `provisionRedskilledHome` stays
  // the ONE creator (ADR 0130 Amendment 2) and this only decides whether to call
  // it — a home no declared lane reads is never brought into being.
  const need = await readRedskilledHomeNeed({
    homeDir,
    declaredTarget: values.workspace,
    projectRoot: values.project ?? io.projectRoot ?? process.cwd(),
  });
  const home = values.check || !need.needed ? undefined : await provisionRedskilledHome(homeDir);

  const readFacts = async () => await readRedskilledProvisionFacts({
    paths,
    homeNeed: need,
    ...(io.homeDir == null ? {} : { homeDir: io.homeDir }),
    ...(io.configHome == null ? {} : { configHome: io.configHome }),
    ...(io.client?.serverCommand == null
      ? {}
      : { entryOverride: { serverCommand: io.client.serverCommand, serverArgs: io.client.serverArgs } }),
  });

  // The service is installed BEFORE the start, so the daemon this run leaves
  // behind is the one the service manager owns — a start that raced its own unit
  // would put the machine back on a process nothing supervises.
  const preStart = await readFacts();
  // Stabilized when possible (#3554 closure): the installed unit outlives every
  // cache, so its ExecStart points at the daemon-home copy when the resolved
  // bundle's name states its version; anything else installs as resolved.
  const unitEntry = isResolvedRedskilledEntry(preStart.entry)
    // Same reason as `planRedskilledUnit`: the version comes from the build
    // stamp because an npx-resolved entry carries none in its name, and a unit
    // pointing into a prunable cache is a daemon that stops starting.
    ? stabilizeRedskilledEntry(preStart.entry, {
        homeDir,
        version: readBuildInfo("redskilled").version,
      })
    : undefined;
  const unit = !values.check && !values["no-unit"] && unitEntry != null
    ? await installRedskilledUserUnit({
        configHome: io.configHome ?? configHome(),
        unit: renderRedskilledUserUnit({
          command: [unitEntry.command, ...unitEntry.args].join(" "),
          socketPath: paths.socketPath,
        }),
      })
    : undefined;

  // **This is the ONE start on the machine** (ADR 0150 §4): the installed unit
  // when there is one, and a direct launch only where no user service can be
  // installed at all. Every client route fails closed and points back here.
  let startError: string | undefined;
  if (!values.check && !values["no-start"]) {
    try {
      await birthRedskilledDaemon(paths, io.client ?? {});
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    }
  }

  const facts = await readFacts();
  const report = auditRedskilledProvisioning(facts);
  write(`${encodeToon({
    verdict: report.verdict,
    home: {
      path: home?.path ?? facts.homePath,
      created: home?.created ?? false,
      tightened: home?.tightened ?? false,
      // Stated on every run, so "why is it empty / why is it absent?" is answered
      // by the receipt instead of by an operator guessing.
      needed: need.needed,
      needed_by: need.declaredBy,
    },
    socket: facts.socketPath,
    ...(startError == null ? {} : { start_error: startError }),
    ...(unit == null ? {} : { unit: { path: unit.path, status: unit.status } }),
    checks: report.rows.map((row) => ({ check: row.check, verdict: row.verdict, evidence: row.evidence })),
    fixes: report.findings.map((finding) => ({ check: finding.check, fix: finding.fix })),
  })}\n`);
  return report.verdict === "ok" ? 0 : 1;
}

function configHome(): string {
  const declared = process.env.XDG_CONFIG_HOME?.trim();
  return declared && declared !== "" ? declared : join(homedir(), ".config");
}
