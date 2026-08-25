import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";
import type {
  RedskilledGithubCredential,
  RedskilledGithubProjectAuthority,
} from "./github-gateway.js";

export type RedskilledGithubForgeState =
  | "unknown"
  | "open-clean"
  | "open-pending"
  | "open-blocked"
  | "merged"
  | "closed"
  | "unavailable";

export interface RedskilledGithubCustodyHandoff {
  readonly pull_request: number;
  readonly owner_ticket: number;
  readonly branch: string;
  readonly base: string;
  /**
   * The head SHA the landing validated and armed (#4130). Optional only for
   * records written before it existed; every new handoff carries it, and a
   * driver pass whose observed head differs reports the mismatch instead of
   * arming a commit nobody validated.
   */
  readonly armed_head?: string;
}

export interface RedskilledGithubCustodyForgeView {
  readonly forge_state: Exclude<RedskilledGithubForgeState, "unknown" | "unavailable">;
  readonly native_intent: boolean;
  /** The pull request's CURRENT head, for the armed-head comparison (#4130). */
  readonly head_sha?: string;
}

export interface RedskilledGithubCustodyUpstreamInput {
  readonly project: RedskilledGithubProjectAuthority;
  readonly credential: RedskilledGithubCredential;
  readonly pullRequest: number;
}

export interface RedskilledGithubCustodyUpstream {
  observe(input: RedskilledGithubCustodyUpstreamInput): Promise<RedskilledGithubCustodyForgeView>;
  arm(input: RedskilledGithubCustodyUpstreamInput): Promise<RedskilledGithubCustodyForgeView>;
}

export interface RedskilledGithubCustodyFault {
  readonly kind: "inert-custodian";
  readonly threshold_ms: number;
  readonly age_ms: number;
  readonly repair: {
    readonly method: typeof REDSKILLS_ACP_METHODS.githubCustodyHandoff;
    readonly params: RedskilledGithubCustodyHandoff;
  };
}

export interface RedskilledGithubCustodyRecord extends RedskilledGithubCustodyHandoff {
  readonly project_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly credential_profile: string;
  readonly handed_off_at: string;
  readonly state: "active" | "terminal";
  readonly last_tick_at: string | null;
  readonly last_forge_state: RedskilledGithubForgeState;
  readonly next_action:
    | "observe-forge"
    | "await-forge"
    | "retry-forge"
    | "repair-custodian"
    | "report-moved-head"
    | "none";
  readonly terminal_outcome: "merged" | "closed" | null;
  readonly fault?: RedskilledGithubCustodyFault;
}

export interface RedskilledGithubCustodyStatus {
  readonly version: 1;
  readonly project_id: string;
  readonly inert_after_ms: number;
  readonly records: readonly RedskilledGithubCustodyRecord[];
}

interface GithubCustodySnapshot {
  readonly version: 1;
  readonly records: RedskilledGithubCustodyRecord[];
}

interface ProjectExecution {
  readonly project: RedskilledGithubProjectAuthority;
  readonly credential: RedskilledGithubCredential;
}

export interface GithubCustodian {
  register(project: RedskilledGithubProjectAuthority, credential: RedskilledGithubCredential): Promise<void>;
  handoff(
    project: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
    request: RedskilledGithubCustodyHandoff,
  ): Promise<RedskilledGithubCustodyRecord>;
  status(
    project: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
  ): Promise<RedskilledGithubCustodyStatus>;
  close(): void;
}

export interface CreateGithubCustodianOptions {
  readonly path: string;
  readonly upstream: RedskilledGithubCustodyUpstream;
  readonly clock: () => string;
  readonly tickMs: number;
  readonly inertMs: number;
}

/**
 * One gateway-owned driver for every durable Project/PR obligation.
 * Connections only register daemon-owned execution authority; disconnecting a
 * connection never removes it. The host singleton is therefore the sole live
 * owner while the TOON snapshot lets its replacement recover the obligation.
 */
/** Terminal custody records kept as receipts; older ones are shed on load and on append. */
export const GITHUB_CUSTODY_TERMINAL_RETENTION = 100;

/**
 * Terminal records are history, not obligations: keep the newest few as the
 * operator's receipts and shed the rest — every custody record ever handed
 * off was retained for the daemon's life, and every mutation re-encoded the
 * whole array (leak audit 2026-08-25, finding #4). Active records are never
 * compacted. PURE.
 */
export function compactGithubCustodySnapshot(value: GithubCustodySnapshot): GithubCustodySnapshot {
  const terminal = value.records.filter((record) => record.state === "terminal");
  if (terminal.length <= GITHUB_CUSTODY_TERMINAL_RETENTION) return value;
  const keep = new Set(terminal.slice(-GITHUB_CUSTODY_TERMINAL_RETENTION));
  return {
    ...value,
    records: value.records.filter((record) => record.state !== "terminal" || keep.has(record)),
  };
}

export function createGithubCustodian(options: CreateGithubCustodianOptions): GithubCustodian {
  let snapshot: GithubCustodySnapshot | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let closed = false;
  const executions = new Map<string, ProjectExecution>();
  const timers = new Map<string, NodeJS.Timeout>();
  const driving = new Set<string>();

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation, operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };

  const load = async (): Promise<GithubCustodySnapshot> => {
    if (snapshot != null) return snapshot;
    try {
      snapshot = compactGithubCustodySnapshot(parseSnapshot(decode((await readFile(options.path, "utf8")).trim())));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      snapshot = { version: 1, records: [] };
    }
    return snapshot;
  };

  const persist = async (value: GithubCustodySnapshot): Promise<void> => {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
    const temporary = `${options.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${encode(value as unknown as JsonValue)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, options.path);
  };

  const schedule = (key: string, delay = options.tickMs): void => {
    if (closed || timers.has(key)) return;
    const timer = setTimeout(() => {
      timers.delete(key);
      void drive(key);
    }, Math.max(0, delay));
    timer.unref?.();
    timers.set(key, timer);
  };

  const updateRecord = async (
    key: string,
    update: (record: RedskilledGithubCustodyRecord) => RedskilledGithubCustodyRecord,
  ): Promise<RedskilledGithubCustodyRecord | undefined> => serialized(async () => {
    const current = await load();
    const index = current.records.findIndex((record) => custodyKey(record.project_id, record.pull_request) === key);
    if (index < 0) return undefined;
    const record = update(current.records[index]!);
    const records = [...current.records];
    records[index] = record;
    snapshot = { version: 1, records };
    await persist(snapshot);
    return record;
  });

  const drive = async (key: string): Promise<void> => {
    if (closed || driving.has(key)) return;
    const execution = executions.get(key);
    if (execution == null) return;
    driving.add(key);
    try {
      const tickAt = options.clock();
      const ticking = await updateRecord(key, (record) => record.state === "terminal" ? record : {
        ...record,
        last_tick_at: tickAt,
        next_action: "observe-forge",
      });
      if (ticking == null || ticking.state === "terminal") return;
      const input = {
        project: execution.project,
        credential: execution.credential,
        pullRequest: ticking.pull_request,
      };
      let view = validateForgeView(await options.upstream.observe(input));
      const open = view.forge_state !== "merged" && view.forge_state !== "closed";
      // #4130: an armed head that moved is a commit nobody validated. The pass
      // reports the mismatch instead of proceeding — it neither arms nor
      // pretends the obligation is on track — and keeps watching, because the
      // head may be forced back or a new landing may restate it.
      const movedHead = open && ticking.armed_head != null && view.head_sha != null &&
        view.head_sha !== ticking.armed_head;
      if (open && !movedHead && !view.native_intent) {
        view = validateForgeView(await options.upstream.arm(input));
      }
      const terminal = view.forge_state === "merged" || view.forge_state === "closed";
      await updateRecord(key, (record) => ({
        ...record,
        state: terminal ? "terminal" : "active",
        last_forge_state: view.forge_state,
        next_action: terminal ? "none" : movedHead ? "report-moved-head" : "await-forge",
        terminal_outcome: view.forge_state === "merged"
          ? "merged"
          : view.forge_state === "closed" ? "closed" : null,
      }));
      if (!terminal) schedule(key);
    } catch {
      await updateRecord(key, (record) => record.state === "terminal" ? record : {
        ...record,
        last_forge_state: "unavailable",
        next_action: "retry-forge",
      }).catch(() => undefined);
      schedule(key);
    } finally {
      driving.delete(key);
    }
  };

  const register = async (
    project: RedskilledGithubProjectAuthority,
    credential: RedskilledGithubCredential,
  ): Promise<void> => {
    const current = await serialized(load);
    for (const record of current.records) {
      if (record.project_id !== project.projectId || record.state === "terminal") continue;
      const key = custodyKey(record.project_id, record.pull_request);
      executions.set(key, { project, credential });
      schedule(key, 0);
    }
  };

  return {
    register,
    async handoff(project, credential, request) {
      const valid = validateHandoff(request);
      await register(project, credential);
      const record = await serialized(async () => {
        const current = await load();
        const key = custodyKey(project.projectId, valid.pull_request);
        const existing = current.records.find((candidate) =>
          custodyKey(candidate.project_id, candidate.pull_request) === key);
        if (existing != null) {
          if (
            existing.owner_ticket !== valid.owner_ticket || existing.branch !== valid.branch ||
            existing.base !== valid.base || existing.credential_profile !== project.credentialProfile
          ) {
            throw new Error("one pull request cannot have two merge custody owners");
          }
          // #4130: a re-landing after a re-publish restates the validated
          // head; the newest validated commit is the one custody defends.
          if (valid.armed_head != null && valid.armed_head !== existing.armed_head) {
            const index = current.records.indexOf(existing);
            const restated = { ...existing, armed_head: valid.armed_head };
            const records = [...current.records];
            records[index] = restated;
            snapshot = { version: 1, records };
            await persist(snapshot);
            return restated;
          }
          return existing;
        }
        const next: RedskilledGithubCustodyRecord = {
          ...valid,
          project_id: project.projectId,
          project_label: project.projectLabel,
          workspace_path: project.workspacePath,
          credential_profile: project.credentialProfile,
          handed_off_at: options.clock(),
          state: "active",
          last_tick_at: null,
          last_forge_state: "unknown",
          next_action: "observe-forge",
          terminal_outcome: null,
        };
        snapshot = compactGithubCustodySnapshot({ version: 1, records: [...current.records, next] });
        await persist(snapshot);
        return next;
      });
      const key = custodyKey(project.projectId, valid.pull_request);
      executions.set(key, { project, credential });
      if (record.state !== "terminal") schedule(key, 0);
      return publicRecord(record, options.clock(), options.tickMs, options.inertMs);
    },
    async status(project, credential) {
      await register(project, credential);
      const current = await serialized(load);
      const now = options.clock();
      return {
        version: 1,
        project_id: project.projectId,
        inert_after_ms: options.inertMs,
        records: current.records
          .filter((record) => record.project_id === project.projectId)
          .sort((left, right) => left.pull_request - right.pull_request)
          .map((record) => publicRecord(record, now, options.tickMs, options.inertMs)),
      };
    },
    close() {
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      executions.clear();
    },
  };
}

function publicRecord(
  record: RedskilledGithubCustodyRecord,
  now: string,
  tickMs: number,
  inertMs: number,
): RedskilledGithubCustodyRecord {
  if (record.state === "terminal") return withoutFault(record);
  const lastActivity = record.last_tick_at ?? record.handed_off_at;
  const age = Date.parse(now) - Date.parse(lastActivity);
  const threshold = record.last_tick_at == null ? Math.min(tickMs, inertMs) : inertMs;
  if (!Number.isFinite(age) || age < threshold) return withoutFault(record);
  return {
    ...record,
    next_action: "repair-custodian",
    fault: {
      kind: "inert-custodian",
      threshold_ms: threshold,
      age_ms: Math.max(0, age),
      repair: {
        method: REDSKILLS_ACP_METHODS.githubCustodyHandoff,
        params: {
          pull_request: record.pull_request,
          owner_ticket: record.owner_ticket,
          branch: record.branch,
          base: record.base,
          ...(record.armed_head == null ? {} : { armed_head: record.armed_head }),
        },
      },
    },
  };
}

function withoutFault(record: RedskilledGithubCustodyRecord): RedskilledGithubCustodyRecord {
  const { fault: _fault, ...answer } = record;
  return answer;
}

function custodyKey(projectId: string, pullRequest: number): string {
  return `${projectId}:${pullRequest}`;
}

function validateHandoff(value: RedskilledGithubCustodyHandoff): RedskilledGithubCustodyHandoff {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("merge custody needs one pull request handoff");
  }
  if (!Number.isSafeInteger(value.pull_request) || value.pull_request <= 0) {
    throw new Error("merge custody needs one positive pull request number");
  }
  if (!Number.isSafeInteger(value.owner_ticket) || value.owner_ticket <= 0) {
    throw new Error("merge custody needs one positive owner Ticket number");
  }
  const armedHead = value.armed_head;
  if (armedHead != null && (typeof armedHead !== "string" || !/^[0-9a-f]{40}$/.test(armedHead))) {
    throw new Error("merge custody needs the armed head as one full commit object name");
  }
  return {
    pull_request: value.pull_request,
    owner_ticket: value.owner_ticket,
    branch: branch(value.branch, "branch"),
    base: branch(value.base, "base"),
    ...(armedHead == null ? {} : { armed_head: armedHead }),
  };
}

function branch(value: unknown, label: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (
    name === "" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) || name.includes("..") ||
    name.includes("//") || name.endsWith(".") || name.endsWith("/") || name.includes("@{")
  ) {
    throw new Error(`merge custody needs one ordinary ${label}`);
  }
  return name;
}

function validateForgeView(value: RedskilledGithubCustodyForgeView): RedskilledGithubCustodyForgeView {
  if (
    value == null || typeof value !== "object" ||
    !["open-clean", "open-pending", "open-blocked", "merged", "closed"].includes(value.forge_state) ||
    typeof value.native_intent !== "boolean" ||
    (value.head_sha != null && (typeof value.head_sha !== "string" || !/^[0-9a-f]{40}$/.test(value.head_sha)))
  ) {
    throw new Error("the GitHub custody upstream returned an invalid forge view");
  }
  return value;
}

function parseSnapshot(value: unknown): GithubCustodySnapshot {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("redskilled GitHub custody is not a snapshot");
  }
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !Array.isArray(root.records)) {
    throw new Error("redskilled GitHub custody has an unsupported version");
  }
  return { version: 1, records: root.records.map(parseRecord) };
}

function parseRecord(value: unknown): RedskilledGithubCustodyRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("redskilled GitHub custody contains an invalid record");
  }
  const record = value as Record<string, unknown>;
  const request = validateHandoff({
    pull_request: record.pull_request as number,
    owner_ticket: record.owner_ticket as number,
    branch: record.branch as string,
    base: record.base as string,
    ...(record.armed_head == null ? {} : { armed_head: record.armed_head as string }),
  });
  const state = record.state === "active" || record.state === "terminal" ? record.state : invalidState();
  const forge = typeof record.last_forge_state === "string" && [
    "unknown", "open-clean", "open-pending", "open-blocked", "merged", "closed", "unavailable",
  ].includes(record.last_forge_state)
    ? record.last_forge_state as RedskilledGithubForgeState
    : invalidForgeState();
  const terminal = record.terminal_outcome === null || record.terminal_outcome === "merged" || record.terminal_outcome === "closed"
    ? record.terminal_outcome
    : invalidTerminal();
  return {
    ...request,
    project_id: scalar(record.project_id),
    project_label: scalar(record.project_label),
    workspace_path: scalar(record.workspace_path),
    credential_profile: scalar(record.credential_profile),
    handed_off_at: scalar(record.handed_off_at),
    state,
    last_tick_at: record.last_tick_at === null ? null : scalar(record.last_tick_at),
    last_forge_state: forge,
    next_action: nextAction(record.next_action),
    terminal_outcome: terminal,
  };
}

function scalar(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("redskilled GitHub custody contains an invalid scalar");
  }
  return value;
}

function nextAction(value: unknown): RedskilledGithubCustodyRecord["next_action"] {
  if (
    ["observe-forge", "await-forge", "retry-forge", "repair-custodian", "report-moved-head", "none"]
      .includes(String(value))
  ) {
    return value as RedskilledGithubCustodyRecord["next_action"];
  }
  throw new Error("redskilled GitHub custody contains an invalid next action");
}

function invalidState(): never {
  throw new Error("redskilled GitHub custody contains an invalid state");
}

function invalidForgeState(): never {
  throw new Error("redskilled GitHub custody contains an invalid forge state");
}

function invalidTerminal(): never {
  throw new Error("redskilled GitHub custody contains an invalid terminal outcome");
}
