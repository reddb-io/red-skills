// always-on-daemon-guard — the ratchet that keeps the daemon always on and the
// client unable to start one (ADR 0150 §4, ADR 0130 rule 6, issue #4022).
//
// ADR 0143 named the failure it closes: **resident by accident**. The daemon was
// born on demand by whichever client reached the socket first and left after five
// idle minutes, so the bundle a project happened to carry decided which daemon a
// whole machine ran, and the next quiet five minutes handed the choice to someone
// else. Deleting the idle timer and the client spawn is the crossing; keeping
// them deleted is the harder job, because **both are always the convenient
// answer**. A slice that wants a daemon reaches for `spawn`, a slice that wants a
// quiet host reaches for a timeout, and nothing in the tree fails.
//
// Three rules, mirroring the extinction ratchet of ADR 0125:
//
//  1. THE LIST ONLY GROWS. A module declared here is one that has stopped
//     carrying the reach. Removing an entry admits the reach back.
//  2. PROSE IS NOT A REACH. Comments describing what was removed — including
//     this one, and the ADR references in the daemon's own header — are
//     documentation, so comments are stripped before matching.
//  3. THE SITE MUST EXIST. A declared module renamed out from under this list
//     would empty the ratchet with nothing failing, so a missing file is itself
//     a finding.
//
// **The Worker's own idle reaping is deliberately not swept.** ADR 0150 §4 is
// about the DAEMON's lifetime; a workflow Worker that goes quiet is still reaped
// on a timer, and a ratchet that reddened `acp-worker-lifecycle.ts` would teach
// the next slice to delete the wrong thing.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./extinct-source-guard.js";

/** One module that must hold no idle-exit or client-spawn reach. */
export interface AlwaysOnDaemonSite {
  /** Repo-relative path of the module the crossing emptied. */
  path: string;
  /** What it used to carry, in one noun phrase. */
  what: string;
  /** What answers instead, named concretely enough to act on. */
  replacement: string;
}

/**
 * The modules that no longer carry an idle exit or a client-side birth.
 *
 * `daemon/lifecycle.ts` is the whole point: it held `armIdleTimer`,
 * `evaluateIdle` and `leaveIdleSession`, the three that decided a quiet host's
 * daemon should go home. `client.ts` is its mirror — it held the spawn that made
 * the daemon appear again, and therefore the version skew.
 */
export const ALWAYS_ON_DAEMON_SITES: readonly AlwaysOnDaemonSite[] = [
  {
    path: "apps/redskilled/src/daemon/lifecycle.ts",
    what: "the idle timer, the idle evaluation and the exit they led to",
    replacement:
      "nothing — the daemon runs until an operator, a signal or a published replacement takes the session",
  },
  {
    path: "apps/redskilled/src/daemon/tunables.ts",
    what: "`DEFAULT_REDSKILLED_IDLE_MS`, the five-minute window a quiet daemon left on",
    replacement:
      "`DEFAULT_REDSKILLED_REPLACE_CHECK_MS` plus the boot look — the whole of the upgrade path now that no idle boundary is reached",
  },
  {
    path: "apps/redskilled/src/daemon/types.ts",
    what: "the `idleMs` daemon option and the `evaluateIdle` probe it exposed",
    replacement: "`workerCount()` and `hostState().registrations` — what the idle check was reading",
  },
  {
    path: "apps/redskilled/src/daemon-entry.ts",
    what: "the `--idle-ms` flag in the one serve argv every start path shares",
    replacement: "no flag at all: a serve argv carries nothing that could make the daemon leave",
  },
  {
    path: "apps/redskilled/src/host-config.ts",
    what: "the `idle_ms` host policy knob and its `REDSKILLED_IDLE_MS` environment override",
    replacement: "no knob: an operator cannot tune a lifetime the ADR fixes at 'always'",
  },
  {
    path: "apps/redskilled/src/daemon-stop.ts",
    what: "the `idle` stop reason a successor could read off the event lane",
    replacement: "`requested`, `signal` and `replaced` — the three ways a daemon still leaves",
  },
  {
    path: "apps/redskilled/src/provision.ts",
    what: "the `idle_ms` line in the host config template setup writes",
    replacement: "a template with no lifetime knob to copy",
  },
  {
    path: "apps/redskilled/src/client.ts",
    what: "the client-side daemon spawn, its spawn lock and its ready wait",
    replacement:
      "`daemon-birth.ts` — the provisioner's own start; a client that finds no daemon raises `RedskilledNotProvisionedError`",
  },
  {
    path: "apps/redskilled/src/client-rendezvous.ts",
    what: "the spawn lock path a racing client used to take",
    replacement: "the installed unit, asked through systemd, which is the one birth authority",
  },
];

/**
 * Every way a module can bring the idle exit back.
 *
 * Named as reaches rather than as one pattern, because the failure mode is a
 * slice picking a DIFFERENT spelling — a bare `setTimeout(stop, ms)` reads as
 * harmless and is the same departure. The identifiers are the ones the removed
 * code used, so a revert reintroduces them verbatim.
 */
export const IDLE_EXIT_REACHES: readonly RegExp[] = [
  /\bidleMs\b/,
  /\bidleTimer\b/,
  /\barmIdleTimer\b/,
  /\bevaluateIdle\b/,
  /\bleaveIdleSession\b/,
  /\bDEFAULT_REDSKILLED_IDLE_MS\b/,
  /\bREDSKILLED_IDLE_MS\b/,
  /\bidle_ms\b/,
  /--idle-ms/,
  /reason:\s*["']idle["']/,
];

/**
 * Every way a CLIENT module can put a daemon on the machine.
 *
 * The whole surface of `node:child_process` plus the specifiers that reach it,
 * for the same reason the birth ratchet lists them: `execFile` reads as harmless
 * and starts a process exactly the same way. Applied ONLY to the client sites,
 * because the provisioner is supposed to be able to do this.
 */
export const CLIENT_SPAWN_REACHES: readonly RegExp[] = [
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
  /(?:from|require\(|import\()\s*["'](?:node:)?child_process["']/,
];

/** The declared sites whose subject is a CLIENT, and so may spawn nothing. */
export const CLIENT_SITE_PATHS: readonly string[] = ["apps/redskilled/src/client.ts"];

/** One reach found where the always-on rule forbids it. */
export interface AlwaysOnDaemonFinding {
  readonly path: string;
  readonly line: number;
  readonly match: string;
  readonly snippet: string;
  readonly what: string;
  readonly replacement: string;
}

const SNIPPET_LIMIT = 160;

/**
 * Scan every declared site. PURE over `read`.
 *
 * Comments are stripped first (rule 2), then each surviving line is matched
 * against the idle reaches — and, for a client site, the spawn reaches too. A
 * site that does not exist is a finding rather than a silent pass (rule 3).
 */
export function collectAlwaysOnDaemonFindings(
  root: string,
  sites: readonly AlwaysOnDaemonSite[] = ALWAYS_ON_DAEMON_SITES,
  read: (path: string) => string | null = defaultRead,
): AlwaysOnDaemonFinding[] {
  const findings: AlwaysOnDaemonFinding[] = [];
  for (const site of sites) {
    const text = read(join(root, site.path));
    if (text === null) {
      findings.push({
        path: site.path,
        line: 0,
        match: "<missing>",
        snippet: "the declared site no longer exists at this path",
        what: site.what,
        replacement: site.replacement,
      });
      continue;
    }
    const patterns = CLIENT_SITE_PATHS.includes(site.path)
      ? [...IDLE_EXIT_REACHES, ...CLIENT_SPAWN_REACHES]
      : IDLE_EXIT_REACHES;
    const lines = stripComments(text).split("\n");
    for (const [index, line] of lines.entries()) {
      for (const pattern of patterns) {
        const matched = pattern.exec(line);
        if (matched == null) continue;
        findings.push({
          path: site.path,
          line: index + 1,
          match: matched[0],
          snippet: line.trim().slice(0, SNIPPET_LIMIT),
          what: site.what,
          replacement: site.replacement,
        });
        break;
      }
    }
  }
  return findings;
}

/** The failure an author reads: what came back, and what to reach for instead. */
export function formatAlwaysOnDaemonFailure(findings: readonly AlwaysOnDaemonFinding[]): string {
  if (findings.length === 0) return "";
  const lines = findings.map(
    (finding) =>
      `  ${finding.path}:${finding.line} — ${JSON.stringify(finding.match)} in ${finding.snippet}\n` +
      `      this module gave up ${finding.what}; reach for ${finding.replacement}`,
  );
  return (
    "the daemon is always on and no client starts one (ADR 0150 §4):\n" +
    `${lines.join("\n")}\n` +
    "An idle exit hands the next client's bundle the choice of which daemon this machine runs (ADR 0143).\n"
  );
}

/**
 * A systemd unit that could stop the daemon on its own, or start it on a timer.
 *
 * The directives are systemd's own lifetime knobs: `RuntimeMaxSec` kills a
 * running service, and `OnIdle`/`OnUnitInactiveSec` belong to a `.timer` that
 * would start the daemon as an occasional job rather than as a service. An
 * always-on unit carries none of them, and carries `Restart=always` so a death
 * is a restart. PURE.
 */
export function unitLifetimeViolations(unitText: string): string[] {
  const violations: string[] = [];
  for (const directive of ["RuntimeMaxSec", "RuntimeMaxJitterSec", "OnIdle", "OnUnitInactiveSec"]) {
    if (new RegExp(`^\\s*${directive}\\s*=`, "m").test(unitText)) {
      violations.push(`the unit carries ${directive}=, which is a lifetime the daemon is not allowed to have`);
    }
  }
  for (const reach of IDLE_EXIT_REACHES) {
    if (reach.test(unitText)) violations.push(`the unit's ExecStart carries an idle knob (${reach.source})`);
  }
  if (!/^\s*Restart\s*=\s*always\s*$/m.test(unitText)) {
    violations.push("the unit does not state Restart=always, so a death is not a restart");
  }
  return violations;
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
