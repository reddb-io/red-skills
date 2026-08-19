// declared-wait-guard — every engine wait is declared: subject, deadline,
// escalation (issue #3024, Spec #3022).
//
// A wait loop is the cheapest thing in the engine to write and the most
// expensive thing to diagnose. It creates no child process, opens no socket,
// writes no file: it is `sleep(pollMs)` in a loop, which is byte-for-byte the
// shape an orchestrator hang wears (#2985). Every liveness surface reads the
// waiting process as a healthy `live=true` worker, because from the outside a
// patient wait and a wedged one are the same observation.
//
// #2985 cured that for ONE stage — the gate's two host-wide locks announce
// themselves and announce their end. The cure did not generalize, because
// nothing in the tree knew how many other waits there were. **AN UNDECLARED
// WAIT IS AN ETERNAL POLL NOBODY HAS AGREED TO.** So the list below names every
// wait loop in the engine and, for each, three facts a human triaging a stall
// needs and cannot get from the source in a hurry:
//
//   1. SUBJECT — what is being waited FOR, in the words the heartbeat says.
//   2. DEADLINE — when the wait stops waiting. `"unbounded"` is a legal answer
//      and a loud one: it is the shape #2985 was about, declared out loud.
//   3. ESCALATION — what happens when the deadline passes. A wait whose
//      escalation is "nothing" is a hang with extra steps.
//
// Four rules:
//
//  1. THE GUARD ENUMERATES, THE LIST DECLARES. A wait loop found in the scanned
//     source and absent from the list FAILS. That is the whole ratchet: the next
//     undeclared eternal poll cannot land.
//  2. A DECLARED WAIT THAT IS GONE ALSO FAILS. A stale entry means the list is
//     no longer an inventory, and an inventory nobody prunes is one nobody
//     trusts. Delete the entry in the same slice that deletes the loop.
//  3. EVERY WAIT SPEAKS, OR DECLARES ITS SILENCE. A declared wait names the
//     heartbeat sink that says its subject on each poll. A wait that needs none
//     — a sub-second drain whose return value is the report, a probe that
//     already writes what it saw — says so with `silent` and gives the reason,
//     so silence is a stated decision instead of an omission.
//  4. PROSE IS NOT A WAIT. Comments describing a poll — including this one — are
//     documentation, so comments are stripped before matching.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** How a wait announces itself on each poll — or why it does not. */
export type WaitHeartbeat =
  | {
      /**
       * The sink symbol the wait fires before each sleep, named so the guard can
       * see it is actually wired in the same module (`onWait`, `notifyWait`, a
       * logger call). The heartbeat must carry the subject; a bare "still
       * waiting" is the silence this guard exists to end.
       */
      sink: string;
      silent?: never;
    }
  | {
      /** Why this wait needs no heartbeat. Required — silence must be argued. */
      silent: string;
      sink?: never;
    };

/** One declared wait loop in the engine. */
export interface DeclaredWait {
  /** Repo-relative path of the module holding the loop. */
  path: string;
  /**
   * The enclosing function or method name, which is what makes an entry survive
   * an edit above it: a line number would go stale on every insertion, and a
   * bare path could not tell three loops in one module apart.
   */
  fn: string;
  /** What is being waited FOR, in the words the heartbeat says. */
  subject: string;
  /** When the wait stops waiting. `"unbounded"` is legal and deliberately loud. */
  deadline: string;
  /** What happens when the deadline passes. */
  escalation: string;
  /** How the wait announces itself on each poll — or why it does not. */
  heartbeat: WaitHeartbeat;
}

/**
 * The engine trees the guard enumerates.
 *
 * Scoped to the trees that hold the orchestrator, its substrate and the shared
 * ACP wire, because those are the waits a stalled AFK run is stuck inside. A
 * tree added here is a tree whose waits must all be declared in the same slice.
 */
export const WAIT_SCAN_ROOTS: readonly string[] = [
  "apps/dev/src",
  "apps/redskilled/src",
  "packages/protocol-acp",
  "packages/shared/kill-tree.ts",
  "packages/worker/src",
];

/**
 * Every way a loop body can hand control to the clock.
 *
 * Written as reaches rather than one `sleep` pattern, because the failure mode
 * is a slice picking a DIFFERENT api: `setTimeout` wrapped in a promise, an
 * injected `clock.sleep`, `Effect.sleep`, or a `delay` import all wait exactly
 * the same way and none of them contain the word the others do.
 */
export const WAIT_REACHES: readonly RegExp[] = [
  /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:sleep|sleepMs|delay)\s*\(/,
  /\bsetTimeout\s*\(/,
  // A wait helper hides the sleep behind a name: the supervisor's main loop
  // holds no `sleep` at all, it holds `waitForNextWake`, and a scan that reads
  // only clock apis would call the engine's LONGEST-lived poll loop not a wait.
  // Each entry here is a helper whose whole job is to block until something
  // happens; adding one means declaring every loop that calls it.
  /\bwaitForNextWake\s*\(/,
];

/** One wait loop found in the scanned source. */
export interface WaitLoopSite {
  /** Repo-relative path, POSIX-separated. */
  readonly path: string;
  /** Enclosing function or method name, or `"<module>"` at top level. */
  readonly fn: string;
  /** 1-based line of the clock reach inside the loop. */
  readonly line: number;
  /** The matched reach text. */
  readonly match: string;
  /** The reach's line, trimmed. */
  readonly snippet: string;
}

/** A source file handed to the scan, already read. */
export interface WaitScanFile {
  readonly path: string;
  readonly sourceText: string;
}

const SNIPPET_LIMIT = 160;
const SOURCE_EXTENSION = ".ts";

/** True for a path the guard does not enumerate: a test, a type-only decl, or itself. */
export function isExcludedWaitPath(path: string): boolean {
  if (path.endsWith(".d.ts")) return true;
  if (/(?:^|\/)tests?\//.test(path)) return true;
  if (/\.(?:test|spec)\.ts$/.test(path)) return true;
  // The guard's own module holds the reach patterns; matching itself would make
  // the ratchet a self-report.
  return path.endsWith("core/declared-wait-guard.ts");
}

/** Read every scannable source file under the declared roots. */
export function readWaitScanFiles(
  root: string,
  roots: readonly string[] = WAIT_SCAN_ROOTS,
): WaitScanFile[] {
  const files: WaitScanFile[] = [];
  for (const scanRoot of roots) {
    if (scanRoot.endsWith(SOURCE_EXTENSION)) {
      files.push({ path: scanRoot, sourceText: readFileSync(join(root, scanRoot), "utf8") });
      continue;
    }
    walk(join(root, scanRoot), (absolute) => {
      const path = relative(root, absolute).split(sep).join("/");
      if (isExcludedWaitPath(path)) return;
      files.push({ path, sourceText: readFileSync(absolute, "utf8") });
    });
  }
  return files;
}

function walk(dir: string, visit: (absolute: string) => void): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(absolute, visit);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(SOURCE_EXTENSION)) visit(absolute);
  }
}

/**
 * Enumerate every wait loop in `files`: a clock reach lexically inside a loop.
 *
 * The scan is a brace walk rather than a regex over lines, because the whole
 * question is CONTAINMENT — `sleep(ms)` at the top of a module is a helper and
 * the same call inside `for (;;)` is a poll, and no line-local pattern can tell
 * them apart. Comments and string literals are blanked first, so a comment
 * describing a poll and an error message naming one are both text. PURE.
 */
export function collectWaitLoopSites(files: readonly WaitScanFile[]): WaitLoopSite[] {
  const sites: WaitLoopSite[] = [];
  for (const file of files) {
    const source = blankCommentsAndStrings(file.sourceText);
    const rawLines = file.sourceText.split("\n");
    for (const found of scanFileForWaitLoops(source)) {
      sites.push({
        path: file.path,
        fn: found.fn,
        line: found.line,
        match: found.match,
        snippet: (rawLines[found.line - 1] ?? "").trim().slice(0, SNIPPET_LIMIT),
      });
    }
  }
  return sites;
}

interface Frame {
  /** This block is a loop body, or sits inside one within the same function. */
  readonly isLoop: boolean;
  /** Function name this block introduces, when it introduces one. */
  readonly fn: string | null;
  /**
   * The pending statement header this block INTERRUPTED, restored when it closes.
   *
   * Only set for a block opened inside parentheses, which is where a brace is
   * usually not a body at all: `options: { pollMs?: number } = {}` in a
   * parameter list opens and closes two blocks in the middle of the signature,
   * and dropping the header there costs the function its name — which is
   * exactly the key this guard declares waits by.
   */
  readonly resumeHeader: string | null;
  /** The paren nesting this block interrupted, restored when it closes. */
  readonly resumeParenDepth: number;
}

/**
 * One file's wait loops, deduplicated to one per (function, loop) pair.
 *
 * A loop that sleeps on three branches is ONE wait with three exits, and
 * reporting it three times would make the declaration a line-number census.
 */
function scanFileForWaitLoops(source: string): { fn: string; line: number; match: string }[] {
  const found = new Map<string, { fn: string; line: number; match: string }>();
  const frames: Frame[] = [];
  const lines = source.split("\n");

  let line = 1;
  // Text of the current statement since the last boundary — the header a `{`
  // belongs to (`function foo(...)`, `for (;;)`, `const bar = async () =>`). A
  // `;` closes a statement only OUTSIDE parentheses: the two semicolons in
  // `for (;;)` are part of the header, and treating them as boundaries is what
  // made the engine's most common wait shape invisible.
  let header = "";
  let parenDepth = 0;
  // The last line already tested for a reach. One test per line is enough, and
  // testing per character would run the patterns hundreds of times a line.
  let testedLine = 0;

  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index]!;
    if (ch === "\n") {
      line += 1;
      header += " ";
      continue;
    }
    if (ch === "(" || ch === "[") parenDepth += 1;
    else if (ch === ")" || ch === "]") parenDepth = Math.max(0, parenDepth - 1);

    if (ch === "{") {
      const opensLoop = LOOP_HEADER.test(header);
      const fn = functionNameFromHeader(header);
      const inheritedLoop = fn === null && (frames.at(-1)?.isLoop ?? false);
      frames.push({
        isLoop: opensLoop || inheritedLoop,
        fn,
        resumeHeader: parenDepth > 0 ? header : null,
        resumeParenDepth: parenDepth,
      });
      header = "";
      // A brace opens a fresh statement context: a callback body sits inside its
      // call's parentheses, and carrying that depth in would make every `;` in
      // the body a non-boundary and the whole body one runaway header.
      parenDepth = 0;
      continue;
    }
    if (ch === "}") {
      const closed = frames.pop();
      header = closed?.resumeHeader ?? "";
      parenDepth = closed?.resumeParenDepth ?? 0;
      continue;
    }
    if (ch === ";" && parenDepth === 0) {
      header = "";
      continue;
    }
    header += ch;

    if (line === testedLine) continue;
    if (!(frames.at(-1)?.isLoop ?? false)) continue;
    testedLine = line;
    const reach = firstReach(lines[line - 1] ?? "");
    if (reach === null) continue;
    const fn = enclosingFunctionName(frames);
    const key = `${fn} ${loopDepthKey(frames)}`;
    if (!found.has(key)) found.set(key, { fn, line, match: reach });
  }

  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** A loop header: `for`/`while`/`do` as a keyword, not as part of a longer name. */
const LOOP_HEADER = /(?:^|[^\w$])(?:for|while|do)\s*(?:\(|$|\s)/;

const FUNCTION_HEADERS: readonly RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function|\()/,
  // A method signature. The lookbehind refuses a MEMBER call: `Effect.runFork(`
  // ends in the same shape and naming a wait after the combinator that wrapped
  // it would key the declaration to the least meaningful word on the line.
  /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^=]*)?$/,
  /(?<![.\w$])([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/,
];

/** The function name a block header introduces, or `null` when it introduces none. */
function functionNameFromHeader(header: string): string | null {
  const collapsed = header.replace(/\s+/g, " ").trim();
  if (collapsed === "" || LOOP_HEADER.test(collapsed)) return null;
  for (const pattern of FUNCTION_HEADERS) {
    const hit = pattern.exec(collapsed);
    if (hit?.[1] !== undefined && !RESERVED.has(hit[1])) return hit[1];
  }
  return null;
}

const RESERVED = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "try",
  "return",
  "await",
  "typeof",
  "new",
  "else",
  "do",
]);

/** The innermost named function around the current block, or `"<module>"`. */
function enclosingFunctionName(frames: readonly Frame[]): string {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const fn = frames[i]!.fn;
    if (fn !== null) return fn;
  }
  return "<module>";
}

/** How many loop frames are open — one wait per distinct nesting, per function. */
function loopDepthKey(frames: readonly Frame[]): number {
  return frames.filter((frame) => frame.isLoop).length;
}

function firstReach(line: string): string | null {
  for (const pattern of WAIT_REACHES) {
    const hit = pattern.exec(line);
    if (hit !== null) return hit[0].trim();
  }
  return null;
}

/** One disagreement between the source and the declaration. */
export type WaitDeclarationViolation =
  | {
      kind: "undeclared";
      path: string;
      fn: string;
      line: number;
      snippet: string;
    }
  | {
      kind: "stale";
      path: string;
      fn: string;
      subject: string;
    }
  | {
      kind: "voiceless";
      path: string;
      fn: string;
      subject: string;
      /** The sink the declaration promises and the module does not reference. */
      sink: string;
    };

/**
 * Compare the enumerated wait loops against the declaration. PURE.
 *
 * Three ways they can disagree, and all three matter: an `undeclared` loop is
 * the next silent poll landing, a `stale` entry is an inventory drifting into
 * fiction, and a `voiceless` wait is one whose declared heartbeat is not wired
 * in the module that waits — a promise of a voice, kept nowhere.
 */
export function findWaitDeclarationViolations(
  sites: readonly WaitLoopSite[],
  declared: readonly DeclaredWait[] = DECLARED_WAITS,
  files: readonly WaitScanFile[] = [],
): WaitDeclarationViolation[] {
  const violations: WaitDeclarationViolation[] = [];
  const declaredByKey = new Map(declared.map((wait) => [waitKey(wait.path, wait.fn), wait]));
  const seen = new Set<string>();

  for (const site of sites) {
    const key = waitKey(site.path, site.fn);
    seen.add(key);
    if (!declaredByKey.has(key)) {
      violations.push({
        kind: "undeclared",
        path: site.path,
        fn: site.fn,
        line: site.line,
        snippet: site.snippet,
      });
    }
  }

  const sourceByPath = new Map(files.map((file) => [file.path, file.sourceText]));
  for (const wait of declared) {
    const key = waitKey(wait.path, wait.fn);
    if (!seen.has(key)) {
      violations.push({ kind: "stale", path: wait.path, fn: wait.fn, subject: wait.subject });
      continue;
    }
    const sink = wait.heartbeat.sink;
    if (sink === undefined) continue;
    const source = sourceByPath.get(wait.path);
    if (source === undefined) continue;
    if (!new RegExp(`\\b${escapeRegExp(sink)}\\b`).test(blankCommentsAndStrings(source))) {
      violations.push({ kind: "voiceless", path: wait.path, fn: wait.fn, subject: wait.subject, sink });
    }
  }

  return violations;
}

function waitKey(path: string, fn: string): string {
  return `${path} ${fn}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The failure message the ratchet carries.
 *
 * A count would name neither the loop nor what to do about it, so a worker
 * reading its own gate output would learn only that something broke. Each
 * violation prints the line AND the three facts the declaration must supply, so
 * the fix is a copyable entry rather than a search. PURE.
 */
export function formatWaitDeclarationFailure(
  violations: readonly WaitDeclarationViolation[],
): string {
  if (violations.length === 0) return "";
  const lines: string[] = [
    `declared-wait ratchet (#3024): ${violations.length} disagreement(s) between the engine's` +
      " wait loops and `DECLARED_WAITS` in apps/dev/src/core/declared-wait-guard.ts.",
  ];
  for (const violation of violations) {
    if (violation.kind === "undeclared") {
      lines.push(
        `  - UNDECLARED ${violation.path}:${violation.line} in \`${violation.fn}\` — ${violation.snippet}`,
      );
      continue;
    }
    if (violation.kind === "stale") {
      lines.push(
        `  - STALE ${violation.path} \`${violation.fn}\` (${violation.subject}) — declared, but no wait loop` +
          " is there any more; delete the entry with the loop.",
      );
      continue;
    }
    lines.push(
      `  - VOICELESS ${violation.path} \`${violation.fn}\` (${violation.subject}) — declares heartbeat sink` +
        ` \`${violation.sink}\`, which the module never references.`,
    );
  }
  if (violations.some((violation) => violation.kind === "undeclared")) {
    lines.push(
      "Declare each one with its SUBJECT (what it waits for), its DEADLINE (when it stops waiting;" +
        " `unbounded` is legal and loud) and its ESCALATION (what happens when the deadline passes)," +
        " plus a heartbeat `sink` that names the subject on each poll — or a `silent` reason saying why" +
        " this wait is too short to be worth one.",
      "A wait nobody declared is an eternal poll nobody agreed to: no child, no socket, no write, and" +
        " every liveness surface reading the stall as a healthy live worker (#2985).",
    );
  }
  return lines.join("\n");
}

/**
 * Blank comments and string literals, preserving line structure.
 *
 * Both must go: a comment describing a poll is prose (rule 4), and a message
 * naming `sleep(` is text. Regex literals are left alone — blanking them would
 * need a full lexer, and a `/sleep/` pattern inside a loop is close enough to a
 * wait that a false declaration is the cheap error.
 */
export function blankCommentsAndStrings(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (two === "/*") {
      while (index < source.length && source.slice(index, index + 2) !== "*/") {
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += "  ";
      index += 2;
      continue;
    }
    const quote = source[index]!;
    if (quote === '"' || quote === "'" || quote === "`") {
      out += " ";
      index += 1;
      while (index < source.length) {
        const ch = source[index]!;
        if (ch === "\\") {
          out += "  ";
          index += 2;
          continue;
        }
        out += ch === "\n" ? "\n" : " ";
        index += 1;
        if (ch === quote) break;
      }
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

/**
 * THE INVENTORY. Every wait loop in the engine, with its subject, deadline and
 * escalation. Sorted by path so a new entry lands where a reader looks for it.
 *
 * Read the `deadline` column top to bottom before adding an entry: the engine's
 * waits are overwhelmingly bounded, and the two that are not say so.
 */
export const DECLARED_WAITS: readonly DeclaredWait[] = [
  {
    path: "apps/dev/src/commands/redact-sweep.ts",
    fn: "request",
    subject: "a GitHub API call the redact sweep is retrying past a 403",
    deadline: "6 attempts, backing off 1s→32s or the response's `retry-after`",
    escalation: "throws `failed after retries`, ending the sweep with the status in the message",
    heartbeat: {
      silent:
        "a bounded six-attempt retry inside ONE api call, under a minute end to end; the throw names the call",
    },
  },
  {
    path: "apps/dev/src/core/mcp-lane-canary.ts",
    fn: "awaitHost",
    subject: "the daemon's own answer for a project reaching the shape this step requires",
    deadline: "`demandDeadlineMs` from the first probe",
    escalation: "goes `inert` with `timeoutDetail`, naming what never arrived and for how long it watched",
    heartbeat: {
      silent:
        "the canary IS the observability probe: its whole output is the step table it is about to write, and a mid-walk heartbeat would report the same fact twice",
    },
  },
  {
    path: "apps/dev/src/core/mcp-lane-canary.ts",
    fn: "runMcpLaneCanary",
    subject: "the quiet window in which a Worker the daemon does not name would appear",
    deadline: "`quietDeadlineMs` from registration",
    escalation:
      "the window closing IS the pass; a stray seen inside it goes `inert` as an unbudgeted birth",
    heartbeat: { silent: "same probe, same reason: the step record is the report" },
  },
  {
    path: "apps/dev/src/core/mcp-lane-canary.ts",
    fn: "stopProject",
    subject: "the project's Workers exiting after `project_stop` deregistered it",
    deadline: "`teardownDeadlineMs`",
    escalation: "returns `inert` naming the survivors and how long they outlived the teardown",
    heartbeat: { silent: "same probe, same reason: the step record is the report" },
  },
  {
    path: "apps/dev/src/core/merge.ts",
    fn: "waitForReviewCheck",
    subject: "the configured review check reaching a terminal state on the PR",
    deadline: "`maxPolls` × `intervalMs`, default 30 × 10s = 5 minutes",
    escalation:
      "returns `timeout` or `absent` and the caller merges ANYWAY — the review is advisory (ADR 0048) and a never-concluding reviewer must not wedge the landing",
    heartbeat: { sink: "onPoll" },
  },
  {
    path: "apps/dev/src/core/merge.ts",
    fn: "waitForMergeReadyWithEvidence",
    subject: "the PR settling to a terminal readiness — merge, conflict or ci-failed",
    deadline: "`maxPolls` × `intervalMs`, default 60 × 10s = 10 minutes",
    escalation:
      "returns `pending`; the caller hands off the OPEN PR to a human rather than re-running the agent (#812)",
    heartbeat: { sink: "onPoll" },
  },
  {
    path: "apps/dev/src/core/merge.ts",
    fn: "waitForQueuedMerge",
    subject:
      "the native merge queue merging the PR, dequeuing it without merging, or the PR settling to a conflict no queue can accept",
    deadline:
      "`maxPolls` × `intervalMs`, default 120 × 15s = 30 minutes, shared with the post-rebase retry so the whole tail costs ONE deadline; ONE probe when no clock is injected",
    escalation:
      "returns `pending`, leaving the PR queued for the next sweep to re-read; a settled conflict returns `unqueueable` early (#3030) and the caller rebases ONCE, then parks the branch, the PR and the issue for a human; four CONSECUTIVE unreadable probes return `probe-failing` early (#3160), which parks as `infra` because a confirmation that cannot see is a broken client rather than a slow queue",
    heartbeat: { sink: "onPoll" },
  },
  {
    path: "apps/dev/src/core/operational-probes/fleet-truth.ts",
    fn: "terminateSupervisorPid",
    subject: "the supervisor pid leaving the process table after SIGTERM",
    deadline: "`timeoutMs`, default 5s at 50ms polls",
    escalation: "returns the pid's final liveness; the probe reports the termination as unapplied",
    heartbeat: {
      silent: "a five-second same-host pid drain inside a probe whose return value is the verdict",
    },
  },
  {
    path: "apps/dev/src/runtime/gh/candidates.ts",
    fn: "readTargetIssue",
    subject: "a just-created, explicitly targeted GitHub issue becoming readable",
    deadline: "4 point reads across 2.5s (250ms + 750ms + 1.5s)",
    escalation: "returns the final 404 so the caller excludes the unreadable target instead of polling forever",
    heartbeat: {
      silent: "a bounded 2.5s read-after-write bridge whose returned candidate result is the report",
    },
  },
  {
    path: "apps/dev/src/runtime/exec.ts",
    fn: "terminateProcessGroup",
    subject: "the process group leaving the process table after SIGTERM, then after SIGKILL",
    deadline: "`PROCESS_GROUP_GRACE_TRIES` then `PROCESS_GROUP_KILL_TRIES`, at `PROCESS_GROUP_POLL_MS`",
    escalation: "returns false — the group survived, and the caller must not tear down what it still holds",
    heartbeat: { silent: "a sub-second drain bounded by two fixed try counts; the boolean IS the report" },
  },
  {
    path: "apps/dev/src/runtime/exec.ts",
    fn: "monitorCpuStall",
    subject: "the validation process group consuming CPU after its normal wall-time envelope",
    deadline:
      "one `sampleIntervalMs` window after `minWallTimeMs`; production defaults to 30 seconds after 20 minutes",
    escalation:
      "terminates the process group and returns typed `stall` infrastructure evidence to the validation sidecar",
    heartbeat: {
      silent:
        "the enclosing gate-child wait already publishes the pid and subject; this sampler publishes its terminal stall evidence through that same sink",
    },
  },
  {
    path: "apps/dev/src/runtime/gh/quota.ts",
    fn: "withGhQuotaBackoff",
    subject: "the GitHub rate-limit window reopening",
    deadline: "`capMs`, default 30 minutes",
    escalation:
      "returns the last rate-limited result unchanged, so the caller parks with an explicit quota reason instead of looping forever",
    heartbeat: { sink: "onWait" },
  },
  {
    path: "packages/shared/kill-tree.ts",
    fn: "killTreeAndWait",
    subject: "the worker process tree dying — after SIGTERM, then SIGKILL, then a group SIGKILL",
    deadline: "`graceTries` (20) then `killTries` (10) twice, at `pollMs` (100) — about 4 seconds",
    escalation:
      "returns false; the caller must NOT tear down the worktree an uninterruptible-sleep worker still sits in",
    heartbeat: { silent: "a seconds-long drain whose boolean return is the report" },
  },
  {
    path: "apps/redskilled/src/acp-workflow-turn.ts",
    fn: "runAcpWorkflowTurn",
    subject: "the targeted Worker's admission becoming observable before its first prompt is forwarded",
    deadline: "one fixed 25ms event-loop turn after targeted admission or replacement",
    escalation: "forwards the exact journaled prompt to the admitted Worker",
    heartbeat: { silent: "a single 25ms pre-work window; the surrounding ACP lifecycle events are the report" },
  },
  {
    path: "apps/redskilled/src/acp-workflow-turn.ts",
    fn: "waitForWorkerDeparture",
    subject: "the dead targeted Worker leaving the daemon's live admission set before its replacement is born",
    deadline: "2 seconds at 10ms local host-state probes",
    escalation: "returns to replacement admission; a still-held Worker gets one terminal ACP refusal without another retry",
    heartbeat: { silent: "a two-second host drain followed immediately by replacement or bounded refusal" },
  },
  {
    path: "packages/protocol-acp/transport.ts",
    fn: "connectWithDeadline",
    subject: "the daemon ACP socket or assigned native Worker ACP socket accepting a local connection",
    deadline: "the caller's `timeoutMs`, 10 seconds for both public and Worker rendezvous",
    escalation: "throws a bounded endpoint-specific connection error; no local Worker fallback is permitted",
    heartbeat: { silent: "a 25ms local socket rendezvous whose terminal throw names the endpoint boundary" },
  },
  {
    path: "apps/redskilled/src/client-rendezvous.ts",
    fn: "waitForSupervisedDaemon",
    subject: "the installed supervisor's daemon answering on its same-user client socket",
    deadline: "`readyTimeoutMs`, or the client's bounded default ready window",
    escalation: "throws that the installed unit did not expose a daemon inside the ready window",
    heartbeat: { silent: "a 25ms local socket rendezvous whose terminal throw names the socket" },
  },
  {
    path: "apps/redskilled/src/client.ts",
    fn: "waitOutTheLeaseHolder",
    subject: "the live daemon named by the existing lease beginning to answer its socket",
    deadline: "`readyTimeoutMs`, default `DEFAULT_REDSKILLED_READY_TIMEOUT_MS`",
    escalation:
      "re-probes the holder, then returns when it exited or throws `RedskilledDaemonHeldError` without spawning a rival",
    heartbeat: { silent: "a 25ms local socket rendezvous whose typed terminal result is the report" },
  },
  {
    path: "apps/redskilled/src/daemon-termination.ts",
    fn: "<module>",
    subject: "the stopping daemon releasing its socket, lease and external pid",
    deadline: "the caller's `settleTimeoutMs`, default 5 seconds",
    escalation: "returns `complete: false` with the deadline and every anchor still pending",
    heartbeat: { silent: "a five-second local teardown drain whose returned pending list is the report" },
  },
  {
    path: "apps/redskilled/src/client.ts",
    fn: "waitForDaemon",
    subject: "the spawned or concurrently starting daemon answering its socket",
    deadline: "`readyTimeoutMs`, default `DEFAULT_REDSKILLED_READY_TIMEOUT_MS`",
    escalation: "throws the spawn failure, the held spawn-lock owner, or the daemon's missed ready window",
    heartbeat: { silent: "a 25ms local socket rendezvous whose terminal throw names what did not start" },
  },
  {
    path: "apps/redskilled/src/project-hook.ts",
    fn: "waitForSyncHook",
    subject: "the admitted project hook process reaching a terminal Worker event",
    deadline: "the registering project's mandatory finite, positive `deadline_ms`",
    escalation:
      "records the expiry on the host event lane, stops waiting, and proceeds with Worker birth for every project",
    heartbeat: {
      silent:
        "the wait is per admitted hook, polls at most every 10ms, and its terminal expiry is the durable lane record",
    },
  },
  {
    path: "packages/worker/src/Orchestrator.ts",
    fn: "startWarningInterval",
    subject: "the agent's idle minutes while no output arrives",
    deadline:
      "unbounded — this fiber IS the heartbeat, and the sibling idle timer owns the deadline it reports against",
    escalation:
      "the idle timer fails the run with `AgentIdleTimeoutError`; this fiber is interrupted the moment output resumes",
    heartbeat: { sink: "onIdleWarning" },
  },
  {
    path: "packages/worker/src/engine/land-lock.ts",
    fn: "acquire",
    subject: "the contended land or gate lock, named with its path, its holder and how long it has held",
    deadline: "`waitTimeoutMs`, default 15 minutes",
    escalation: "returns null; the caller parks rather than landing unserialized",
    heartbeat: { sink: "onWait" },
  },
  {
    path: "packages/worker/src/engine/tracker/claim.ts",
    fn: "listVerifiedClaims",
    subject: "our own claim marker becoming visible in the issue's comments",
    deadline: "`verifyAttempts` × `verifyDelayMs`, default 1s apart",
    escalation:
      "throws `ClaimVerificationError` rather than returning a list without our marker — that ambiguity is what made a sole claimant concede its own issue (#2385)",
    heartbeat: { silent: "a few one-second reads inside one claim acquisition; the throw names what never appeared" },
  },
  {
    path: "packages/worker/src/sandboxes/no-sandbox.ts",
    fn: "terminateProcessGroup",
    subject: "the sandboxed process group leaving the process table after SIGTERM, then after SIGKILL",
    deadline: "`PROCESS_GROUP_GRACE_TRIES` then `PROCESS_GROUP_KILL_TRIES`, at `PROCESS_GROUP_POLL_MS`",
    escalation: "returns false — the group survived its own SIGKILL and the caller must treat the sandbox as live",
    heartbeat: { silent: "a sub-second drain bounded by two fixed try counts; the boolean IS the report" },
  },
];
