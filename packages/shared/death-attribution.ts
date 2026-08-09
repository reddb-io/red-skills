/**
 * death-attribution — the boot reaper that speaks for the deaths nothing watched.
 *
 * **A SIGKILL fires no handler, so the death record it should have written is
 * absent — and that absence is the evidence.** `death-record.ts` guarantees the
 * narrow, total thing: a process that CAN say goodbye always does. This module
 * covers the complement — SIGKILL, machine freeze, power loss — where no trap
 * ran, no parent survived to observe, and the only witness left is the host
 * itself.
 *
 * **A living process leaves an ANCHOR; a dying one takes it with it.** The
 * recorder writes a presence file on install and removes it the moment a record
 * lands, so an anchor still on disk at the next boot means exactly one thing: a
 * process left without saying how. Nothing has to be watching for that to work,
 * which is the whole point — a watcher is precisely what a freeze kills first.
 *
 * **The verdict names its sender class, its confidence and the evidence it used
 * — never a bare guess.** Five classes cover who ended it: `oomd` (the kernel or
 * systemd-oomd reclaimed memory), `user-signal` (a person or tool sent one),
 * `parent-death` (it went down with whatever started it), `teardown` (the host
 * itself stopped under it), and `unknown`. An `unknown` verdict carries the list
 * of everything consulted and what each said, because "we do not know, and here
 * is where we looked" is a finding; an invented cause is a lie that outlives the
 * incident.
 *
 * **Evidence is READ, never inferred from a running process.** Every source is a
 * path — `/proc` walked for real, journal files tailed — so a test poses a host
 * by posing its files, the way WSL2 support was proven, and the code an operator
 * runs is the code under test.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";
import { deathAttributionFileIn, deathLaneFileIn, deathPresenceDirIn } from "./red-paths.js";
import {
  compactProcessDeathLane,
  decodeProcessDeathRecords,
  readProcessDeathLane,
  type ProcessDeathKind,
  type ProcessDeathRecord,
} from "./death-record.js";
import {
  BOOT_ID_PATH,
  clearProcessPresence,
  readProcessPresences,
  type ProcessPresence,
} from "./death-presence.js";

export {
  DEATH_ATTRIBUTION_FILE,
  DEATH_PRESENCE_DIR,
  deathAttributionFile,
  deathAttributionFileIn,
  deathPresenceDir,
  deathPresenceDirIn,
} from "./red-paths.js";

// The anchor surface travels with the reaper, so a reader that cares about
// un-trap-able deaths has ONE import for both halves of the join.
export {
  PROCESS_PRESENCE_VERSION,
  buildProcessPresence,
  clearProcessPresence,
  presenceFileName,
  readProcessPresences,
  writeProcessPresence,
  type BuildProcessPresenceFacts,
  type BuildProcessPresenceOptions,
  type ProcessPresence,
} from "./death-presence.js";

/** The attribution shape's version. */
export const DEATH_ATTRIBUTION_VERSION = 1;

/** Who ended the process. Five classes, one of which is honest ignorance. */
export type DeathSenderClass =
  | "oomd"
  | "user-signal"
  | "parent-death"
  | "teardown"
  | "boot-refused"
  | "unknown";

/**
 * How far the evidence goes.
 *
 * `high` is a source naming this process under the boot it lived in. `medium` is
 * a source naming it across a boot boundary, or naming its scope rather than it.
 * `low` is a chain of inference with no line of its own. `none` belongs to
 * `unknown` alone, so a reader can filter on the verdict or on the confidence and
 * get the same set.
 */
export type AttributionConfidence = "high" | "medium" | "low" | "none";

/** The reaper's verdict for one absent-but-expected record. */
export interface DeathAttribution {
  readonly version: number;
  /** When the reaper concluded — NOT when the process died, which nobody saw. */
  readonly ts: string;
  readonly kind: ProcessDeathKind;
  readonly id: string;
  readonly pid: number;
  /** The anchor's timestamp: the last moment the process is known to have lived. */
  readonly last_seen: string;
  readonly last_phase: string;
  readonly sender_class: DeathSenderClass;
  readonly confidence: AttributionConfidence;
  /** The signal, when a source NAMED one; never inferred from the class alone. */
  readonly signal: string | null;
  readonly host_boot_changed: boolean;
  /** The facts the verdict rests on. Empty exactly when the verdict is `unknown`. */
  readonly evidence: readonly string[];
  /** Every source consulted and what it answered — the receipt for an `unknown`. */
  readonly checked: readonly string[];
}

/** What one evidence source had to say when the collector asked. */
export interface EvidenceProbe {
  readonly source: string;
  readonly result: "read" | "absent" | "unreadable" | "empty";
  readonly detail: string | null;
}

/** Everything the host could tell us, gathered once and shared by every verdict. */
export interface HostDeathEvidence {
  readonly boot_id: string | null;
  readonly live_pids: ReadonlySet<number>;
  readonly journal: readonly string[];
  readonly probes: readonly EvidenceProbe[];
}

/**
 * Where a kernel oom kill lands on an ordinary Linux host.
 *
 * Plain files rather than `journalctl`, because reading a file is a read and
 * shelling out is a birth: this module must stay callable from a process that is
 * not allowed to create one. A host that keeps its log only in the binary
 * journal reports `absent` here, and an `unknown` verdict says so out loud.
 */
export const DEFAULT_JOURNAL_PATHS = [
  "/var/log/kern.log",
  "/var/log/syslog",
  "/var/log/messages",
] as const;

/** How much of each journal file's TAIL is read; the interesting lines are last. */
export const DEFAULT_JOURNAL_TAIL_BYTES = 512 * 1024;

export interface CollectHostDeathEvidenceOptions {
  /** The process tree to walk; posed in tests, `/proc` in production. */
  readonly procRoot?: string;
  readonly journalPaths?: readonly string[];
  readonly tailBytes?: number;
}

/** Read the host's boot id, live pid set and journal tail. Never throws. */
export function collectHostDeathEvidence(
  options: CollectHostDeathEvidenceOptions = {},
): HostDeathEvidence {
  const procRoot = options.procRoot ?? "/proc";
  const journalPaths = options.journalPaths ?? DEFAULT_JOURNAL_PATHS;
  const probes: EvidenceProbe[] = [];

  const bootIdPath = join(procRoot, BOOT_ID_PATH);
  let bootId: string | null = null;
  try {
    const raw = readFileSync(bootIdPath, "utf8").trim();
    bootId = raw === "" ? null : raw;
    probes.push({ source: bootIdPath, result: bootId ? "read" : "empty", detail: bootId });
  } catch (error) {
    probes.push({ source: bootIdPath, result: probeFailure(error), detail: null });
  }

  const livePids = new Set<number>();
  try {
    for (const entry of readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue;
      livePids.add(Number(entry));
    }
    probes.push({ source: procRoot, result: "read", detail: `${livePids.size} live pids` });
  } catch (error) {
    probes.push({ source: procRoot, result: probeFailure(error), detail: null });
  }

  const journal: string[] = [];
  for (const path of journalPaths) {
    try {
      const text = readTail(path, options.tailBytes ?? DEFAULT_JOURNAL_TAIL_BYTES);
      const lines = text.split("\n").filter((line) => line.trim() !== "");
      journal.push(...lines);
      probes.push({
        source: path,
        result: lines.length === 0 ? "empty" : "read",
        detail: `${lines.length} lines`,
      });
    } catch (error) {
      probes.push({ source: path, result: probeFailure(error), detail: null });
    }
  }

  return { boot_id: bootId, live_pids: livePids, journal, probes };
}

function probeFailure(error: unknown): EvidenceProbe["result"] {
  return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
}

function readTail(path: string, limit: number): string {
  const size = statSync(path).size;
  const text = readFileSync(path, "utf8");
  return size <= limit ? text : text.slice(text.length - limit);
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** `Out of memory: Killed process 4242 (node)` — the kernel's own oom killer. */
const KERNEL_OOM = /(?:Out of memory|Memory cgroup out of memory)[^\n]*?Killed process (\d+)/;
/** `oom-kill:constraint=…,task=node,pid=4242` — the structured kernel variant. */
const KERNEL_OOM_KV = /oom[-_]kill:[^\n]*?\bpid=(\d+)/;
/** `systemd-oomd[9]: Killed /user.slice/… due to memory pressure` — a SCOPE kill. */
const OOMD_CGROUP = /Killed (\/\S*) due to memory pressure/;
/** auditd's signal record: `opid=4242 sig=9 uid=1000`, in either field order. */
const AUDIT_SIGNAL_PID = /\bopid=(\d+)\b/;
const AUDIT_SIGNAL_SIG = /\bsig=(\d+)\b/;
const AUDIT_SIGNAL_UID = /\buid=(\d+)\b/;
/** The host announcing that it is going down on purpose. */
const CLEAN_SHUTDOWN = /systemd-shutdown|Powering off|System is powering down|Reboot: |Unmounting file systems/;

const SIGNAL_NAMES: Record<number, string> = { 2: "SIGINT", 9: "SIGKILL", 15: "SIGTERM" };

/**
 * Attribute one absent-but-expected death. PURE — every input is a value.
 *
 * The order is specific-before-general: a source that names THIS process beats
 * one that names its scope, which beats one that names only the host. A boot
 * boundary demotes any pid-keyed match to `medium`, because pids are reused
 * across boots and a confident wrong answer is worse than a hedged right one.
 */
export function attributeDeath(
  presence: ProcessPresence,
  evidence: HostDeathEvidence,
  deaths: readonly ProcessDeathRecord[],
  ts: string,
): DeathAttribution {
  const bootChanged =
    presence.boot_id !== null && evidence.boot_id !== null && presence.boot_id !== evidence.boot_id;
  const checked: string[] = [
    ...evidence.probes.map((probe) => `${probe.source}: ${probe.result}${probe.detail ? ` (${probe.detail})` : ""}`),
    `boot id: anchored under ${presence.boot_id ?? "unknown"}, host now ${evidence.boot_id ?? "unknown"}` +
      ` (${bootChanged ? "changed" : "same"})`,
    `parent account: ppid ${presence.ppid}`,
    `cgroup: ${presence.cgroup ?? "unknown"}`,
  ];
  const verdict = (
    sender_class: DeathSenderClass,
    confidence: AttributionConfidence,
    signal: string | null,
    lines: readonly string[],
  ): DeathAttribution => ({
    version: DEATH_ATTRIBUTION_VERSION,
    ts,
    kind: presence.kind,
    id: presence.id,
    pid: presence.pid,
    last_seen: presence.ts,
    last_phase: presence.last_phase,
    sender_class,
    confidence,
    signal,
    host_boot_changed: bootChanged,
    evidence: lines,
    checked,
  });
  const across = bootChanged
    ? [`the host rebooted since the anchor, so this line may name a reused pid`]
    : [];

  const kernelOom = evidence.journal.find((line) => matchesPid(line, presence.pid, KERNEL_OOM) || matchesPid(line, presence.pid, KERNEL_OOM_KV));
  if (kernelOom !== undefined) {
    return verdict("oomd", bootChanged ? "medium" : "high", "SIGKILL", [kernelOom, ...across]);
  }

  if (presence.cgroup !== null) {
    for (const line of evidence.journal) {
      const scope = OOMD_CGROUP.exec(line)?.[1];
      if (scope === undefined) continue;
      if (scope === presence.cgroup) {
        return verdict("oomd", bootChanged ? "medium" : "high", "SIGKILL", [line, ...across]);
      }
      if (presence.cgroup.startsWith(`${scope}/`)) {
        return verdict("oomd", "medium", "SIGKILL", [
          line,
          `the killed scope ${scope} is an ancestor of this process's ${presence.cgroup}`,
          ...across,
        ]);
      }
    }
  }

  const audit = evidence.journal.find(
    (line) => Number(AUDIT_SIGNAL_PID.exec(line)?.[1]) === presence.pid && AUDIT_SIGNAL_SIG.test(line),
  );
  if (audit !== undefined) {
    const signo = Number(AUDIT_SIGNAL_SIG.exec(audit)?.[1]);
    const uid = AUDIT_SIGNAL_UID.exec(audit)?.[1];
    return verdict("user-signal", bootChanged ? "medium" : "high", SIGNAL_NAMES[signo] ?? null, [
      audit,
      ...(uid === undefined ? [] : [`sent by uid ${uid}`]),
      ...across,
    ]);
  }

  const parentDeath = deaths.find((death) => death.pid === presence.ppid);
  if (parentDeath !== undefined && !evidence.live_pids.has(presence.ppid)) {
    return verdict("parent-death", "medium", null, [
      `parent pid ${presence.ppid} (${parentDeath.kind} ${parentDeath.id}) recorded its own death at` +
        ` ${parentDeath.ts} via ${parentDeath.exit_path}${parentDeath.signal ? ` ${parentDeath.signal}` : ""}`,
    ]);
  }

  if (bootChanged) {
    const shutdown = evidence.journal.find((line) => CLEAN_SHUTDOWN.test(line));
    if (shutdown !== undefined) {
      return verdict("teardown", "high", null, [
        `host boot id changed from ${presence.boot_id} to ${evidence.boot_id}`,
        shutdown,
      ]);
    }
    return verdict("teardown", "medium", null, [
      `host boot id changed from ${presence.boot_id} to ${evidence.boot_id}`,
      `no shutdown record on any journal read: the host stopped without announcing it` +
        ` (a freeze or a power loss, not an orderly teardown)`,
    ]);
  }

  return verdict("unknown", "none", null, []);
}

function matchesPid(line: string, pid: number, pattern: RegExp): boolean {
  return Number(pattern.exec(line)?.[1]) === pid;
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

/**
 * The separator that folds `evidence` and `checked` onto one TOONL cell.
 *
 * TOONL rows hold scalars, and splitting one verdict across rows would let a
 * partial write present half an attribution as a whole one. The pipe is stripped
 * from every part before joining, so the round trip is total.
 */
export const ATTRIBUTION_LIST_SEPARATOR = " | ";

function joinList(values: readonly string[]): string {
  return values.map((value) => value.replace(/[|\n\r]+/g, " ").trim()).join(ATTRIBUTION_LIST_SEPARATOR);
}

function splitList(value: string): string[] {
  return value === "" ? [] : value.split(ATTRIBUTION_LIST_SEPARATOR);
}

function attributionRow(attribution: DeathAttribution): ToonlRecord {
  return {
    version: attribution.version,
    ts: attribution.ts,
    kind: attribution.kind,
    id: attribution.id,
    pid: attribution.pid,
    last_seen: attribution.last_seen,
    last_phase: attribution.last_phase,
    sender_class: attribution.sender_class,
    confidence: attribution.confidence,
    signal: attribution.signal,
    host_boot_changed: attribution.host_boot_changed,
    evidence: joinList(attribution.evidence),
    checked: joinList(attribution.checked),
  };
}

/** Encode verdicts as TOONL lines. PURE. */
export function encodeDeathAttributions(attributions: readonly DeathAttribution[]): string {
  const writer = encodeLines({ trailer: false });
  return attributions.map((attribution) => writer.push(attributionRow(attribution))).join("");
}

/** Decode a verdict lane. An unterminated tail line is dropped, as on the death lane. */
export function decodeDeathAttributions(raw: string): DeathAttribution[] {
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  if (complete === "") return [];
  return parseRecords(complete).map((row) => {
    const kind = row.kind;
    if (kind !== "launcher" && kind !== "worker" && kind !== "daemon") {
      throw new Error(`attribution has unknown kind ${String(kind)}`);
    }
    return {
      version: num(row.version),
      ts: String(row.ts),
      kind,
      id: String(row.id),
      pid: num(row.pid),
      last_seen: String(row.last_seen),
      last_phase: String(row.last_phase),
      sender_class: String(row.sender_class) as DeathSenderClass,
      confidence: String(row.confidence) as AttributionConfidence,
      signal: row.signal == null ? null : String(row.signal),
      host_boot_changed: row.host_boot_changed === true || row.host_boot_changed === "true",
      evidence: splitList(String(row.evidence ?? "")),
      checked: splitList(String(row.checked ?? "")),
    };
  });
}

export interface BootDeathReaperOptions {
  /** The durable state root holding the death lane — a checkout's or the daemon's. */
  readonly stateRoot: string;
  /** Pre-collected evidence; omitted, the real host is read. */
  readonly evidence?: HostDeathEvidence;
  readonly now?: () => string;
  readonly procRoot?: string;
  readonly journalPaths?: readonly string[];
}

export interface BootDeathReaperResult {
  /** One verdict per absent-but-expected record, in anchor order. */
  readonly attributions: readonly DeathAttribution[];
  /** Anchors whose process is still running — left exactly where they are. */
  readonly alive: readonly ProcessPresence[];
  /** Anchors whose process already explained itself; cleared without a verdict. */
  readonly self_recorded: readonly ProcessPresence[];
  /** Anchor files that would not decode, named so the corruption is visible. */
  readonly skipped: readonly string[];
  /** The verdict lane as it now stands on disk. */
  laneText(): string;
}

/**
 * Reap at boot: attribute every anchor left behind, append the verdicts, clear
 * the anchors.
 *
 * Runs from a cold start with nothing else alive, so it takes no locks and asks
 * no daemon — the host's own files are the only authority it needs. An anchor
 * whose process still runs is left untouched, because clearing it would erase
 * the only thing that will explain that process if it is killed next.
 */
export function runBootDeathReaper(options: BootDeathReaperOptions): BootDeathReaperResult {
  const presenceDir = deathPresenceDirIn(options.stateRoot);
  const attributionPath = deathAttributionFileIn(options.stateRoot);
  const now = options.now ?? (() => new Date().toISOString());
  const reapedAt = now();
  const evidence =
    options.evidence ??
    collectHostDeathEvidence({ procRoot: options.procRoot, journalPaths: options.journalPaths });

  const skipped: string[] = [];
  const presences = readProcessPresences(presenceDir, (file) => skipped.push(file));
  const deaths = readProcessDeathLane(deathLaneFileIn(options.stateRoot));

  const attributions: DeathAttribution[] = [];
  const alive: ProcessPresence[] = [];
  const selfRecorded: ProcessPresence[] = [];

  for (const presence of presences) {
    if (evidence.live_pids.has(presence.pid)) {
      alive.push(presence);
      continue;
    }
    const own = deaths.find((death) => death.pid === presence.pid && death.id === presence.id);
    if (own !== undefined) {
      selfRecorded.push(presence);
      clearProcessPresence(presenceDir, presence);
      continue;
    }
    attributions.push(attributeDeath(presence, evidence, deaths, reapedAt));
    clearProcessPresence(presenceDir, presence);
  }

  const reapedAtMs = Date.parse(reapedAt);
  if (Number.isFinite(reapedAtMs)) compactProcessDeathLane(deathLaneFileIn(options.stateRoot), reapedAtMs);
  if (attributions.length > 0) appendAttributions(attributionPath, attributions);

  return {
    attributions,
    alive,
    self_recorded: selfRecorded,
    skipped,
    laneText: () => {
      try {
        return readFileSync(attributionPath, "utf8");
      } catch {
        return "";
      }
    },
  };
}

/**
 * One line an operator can read in a boot log. PURE.
 *
 * Names the class, the confidence and the FIRST piece of evidence per verdict,
 * because a summary that only counted deaths would send the reader to the lane to
 * learn the one thing they came for. A boot with nothing to attribute says so
 * rather than staying silent: silence is what an un-run reaper also looks like.
 */
export function formatDeathAttributions(result: BootDeathReaperResult): string {
  const skipped = result.skipped.length === 0 ? "" : ` | unreadable anchors=${result.skipped.join(",")}`;
  if (result.attributions.length === 0) {
    return (
      `death reaper: no un-recorded deaths` +
      ` (live=${result.alive.length} self-recorded=${result.self_recorded.length})${skipped}`
    );
  }
  const verdicts = result.attributions
    .map(
      (attribution) =>
        ` | ${attribution.kind} ${attribution.id} pid=${attribution.pid}` +
        ` ${attribution.sender_class}/${attribution.confidence}` +
        ` phase=${attribution.last_phase}` +
        (attribution.evidence[0] ? ` evidence="${attribution.evidence[0]}"` : ""),
    )
    .join("");
  return `death reaper: attributed ${result.attributions.length}${verdicts}${skipped}`;
}

function appendAttributions(path: string, attributions: readonly DeathAttribution[]): void {
  try {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const existing = readOrEmpty(path);
    const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${existing}${prefix}${encodeDeathAttributions(attributions)}`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Best effort by contract: a lane that cannot be written must not turn a
    // boot-time investigation into a boot-time failure.
  }
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Re-exported so a reader decodes both lanes from one import. */
export { decodeProcessDeathRecords };
