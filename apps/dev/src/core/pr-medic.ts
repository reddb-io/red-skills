import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "@reddb-io/toon";
import { parse as decode, serialize as encode } from "@reddb-io/toon/legacy";
import type { EnginePaths } from "@reddb-io/red-castle/engine";

/**
 * PR medic (Spec #2511 slice 2, #2513): when the merge driver classifies a PR
 * `needs-medic`, run a BOUNDED mechanical healing pass before any human
 * escalation — covering exactly the failure classes hand-fixed on 2026-07-22:
 * stale generated Pi mirrors, identifier renames landed on main after the
 * branch forked, and additive merge conflicts where both sides only add lines.
 * Anything else is semantic and escalates untouched. Two failed rounds per PR
 * → escalate, never loop.
 */

export const MEDIC_MAX_ROUNDS = 2;

/** Old→new identifier renames the medic may apply mechanically. Grows only
 * with renames that landed on main and keep breaking stale branches. */
export const MEDIC_RENAME_REGISTRY: Readonly<Record<string, string>> = {
  createDevAfkMcpDependencies: "createCastleMcpDependencies",
};

export type MedicFailureClass =
  | "stale-pi"
  | "stale-rename"
  | "additive-conflict"
  | "semantic";

/** Classify one failing-CI diagnosis into a healable class. Conservative: the
 * medic only claims a failure it has a mechanical cure for. */
export function classifyMedicFailure(input: {
  /** Tail of the failing check log. */
  logTail: string;
  /** Conflicted file contents by path (empty when CI failed without conflict). */
  conflicts: Readonly<Record<string, string>>;
  /** File contents by path for rename scanning (changed files after merge). */
  files: Readonly<Record<string, string>>;
  registry?: Readonly<Record<string, string>>;
}): MedicFailureClass {
  const registry = input.registry ?? MEDIC_RENAME_REGISTRY;
  if (Object.keys(input.conflicts).length > 0) {
    const resolvable = Object.values(input.conflicts).every(
      (text) => unionResolveConflicts(text) !== null,
    );
    return resolvable ? "additive-conflict" : "semantic";
  }
  if (/staged Pi packages are stale|pi-package-builder/i.test(input.logTail)) return "stale-pi";
  const renamed = Object.keys(registry).some((old) =>
    Object.values(input.files).some((text) => text.includes(old)),
  );
  if (renamed) return "stale-rename";
  return "semantic";
}

/** Apply the rename registry to one file. Returns the rewritten text and the
 * replacement count (0 = untouched). */
export function applyRenameRegistry(
  text: string,
  registry: Readonly<Record<string, string>> = MEDIC_RENAME_REGISTRY,
): { text: string; replacements: number } {
  let out = text;
  let replacements = 0;
  for (const [old, next] of Object.entries(registry)) {
    const re = new RegExp(`\\b${old}\\b`, "g");
    out = out.replace(re, () => {
      replacements += 1;
      return next;
    });
  }
  return { text: out, replacements };
}

/** A line the union resolver accepts as "additive context": an import, a
 * quoted registry entry, a spread registration, or a bare identifier row —
 * the shapes of import blocks, tool registrations, and test-list fixtures. */
const ADDITIVE_LINE_RE =
  /^\s*(import\s.+|export \{.*|"[^"]*",?|'[^']*',?|\.\.\..+,?|[\w$]+(: [\w$().\s]+)?,?|\s*)$/;

/**
 * Union-resolve every conflict hunk in `text`, or return null when ANY hunk is
 * not provably additive. Additive means: no base overlap (each side only adds),
 * the two sides share no conflicting rewrite of a common line, and every line
 * on both sides matches the additive-context shapes. The union keeps ours-then-
 * theirs order and drops exact duplicates.
 */
export function unionResolveConflicts(text: string): string | null {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.startsWith("<<<<<<<")) {
      out.push(line);
      i += 1;
      continue;
    }
    const ours: string[] = [];
    const theirs: string[] = [];
    let cursor = i + 1;
    let section: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    for (; cursor < lines.length; cursor += 1) {
      const current = lines[cursor]!;
      if (current.startsWith("|||||||")) {
        section = "base";
        continue;
      }
      if (current.startsWith("=======")) {
        section = "theirs";
        continue;
      }
      if (current.startsWith(">>>>>>>")) {
        closed = true;
        break;
      }
      if (section === "ours") ours.push(current);
      else if (section === "theirs") theirs.push(current);
      else if (current.trim() !== "") return null; // non-empty base → both sides EDITED, not additive
    }
    if (!closed) return null;
    if (ours.length + theirs.length === 0) return null;
    if (![...ours, ...theirs].every((l) => ADDITIVE_LINE_RE.test(l))) return null;
    // Same-key rewrites are edits, not additions: when a line's key (the text
    // before `:`/`=`) appears on both sides with different content, the two
    // sides are rewriting one entity and the merge is semantic.
    const keyOf = (l: string): string => l.trim().split(/[:=]/)[0]!.trim();
    const rewritten = ours.some((l) => {
      if (l.trim() === "") return false;
      return theirs.some(
        (t) => t.trim() !== "" && t.trim() !== l.trim() && keyOf(t) === keyOf(l),
      );
    });
    if (rewritten) return null;
    const seen = new Set<string>();
    for (const l of [...ours, ...theirs]) {
      const key = l.trim();
      if (key !== "" && seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    i = cursor + 1;
  }
  return out.join("\n");
}

// ---------- durable rounds ledger ----------

export interface MedicPrRecord {
  readonly pr: number;
  readonly rounds: number;
  readonly outcome: "healing" | "healed" | "escalated";
  readonly updatedAtEpoch: number;
  readonly actions: readonly string[];
}

export interface MedicState {
  readonly version: 1;
  readonly prs: Record<string, MedicPrRecord>;
}

export interface MedicStore {
  read(): Promise<MedicState>;
  write(state: MedicState): Promise<void>;
}

export function medicStatePath(paths: EnginePaths): string {
  return join(paths.castleStateRoot, "pr-medic.toon");
}

function validateMedicState(value: unknown): MedicState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { version: 1, prs: {} };
  const raw = value as Partial<MedicState>;
  if (raw.version !== 1 || !raw.prs || typeof raw.prs !== "object") return { version: 1, prs: {} };
  const prs: Record<string, MedicPrRecord> = {};
  for (const [key, record] of Object.entries(raw.prs)) {
    if (!/^\d+$/.test(key) || !record || typeof record !== "object") continue;
    const r = record as Partial<MedicPrRecord>;
    if (!Number.isSafeInteger(r.pr)) continue;
    prs[key] = {
      pr: r.pr as number,
      rounds: Number.isSafeInteger(r.rounds) ? (r.rounds as number) : 0,
      outcome: r.outcome === "healed" || r.outcome === "escalated" ? r.outcome : "healing",
      updatedAtEpoch: Number.isSafeInteger(r.updatedAtEpoch) ? (r.updatedAtEpoch as number) : 0,
      actions: Array.isArray(r.actions) ? r.actions.filter((a): a is string => typeof a === "string") : [],
    };
  }
  return { version: 1, prs };
}

export function createFileMedicStore(paths: EnginePaths): MedicStore {
  const path = medicStatePath(paths);
  return {
    async read() {
      try {
        return validateMedicState(decode(await readFile(path, "utf8")));
      } catch {
        return { version: 1, prs: {} };
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
      await writeFile(temporary, encode(validateMedicState(state) as unknown as JsonValue, { keyedMapCollapse: true }), "utf8");
      await rename(temporary, path);
    },
  };
}

// ---------- the bounded healing pass ----------

/** IO port for one healing round, executed inside an isolated worktree the
 * host creates and destroys around the call. */
export interface MedicIo {
  /** Gather the diagnosis inputs for the PR (failing log tail, conflicted and
   * changed file contents). */
  diagnose(pr: number): Promise<{
    logTail: string;
    conflicts: Record<string, string>;
    files: Record<string, string>;
  }>;
  /** Regenerate the staged Pi mirrors (`node scripts/build-pi-packages.mjs`). */
  regenPi(pr: number): Promise<void>;
  /** Write one healed file back into the PR worktree. */
  writeFile(pr: number, path: string, text: string): Promise<void>;
  /** Commit every staged heal and push the PR branch. */
  commitPush(pr: number, message: string): Promise<void>;
  /** Remove the isolated worktree (always called, healed or not). */
  cleanup(pr: number): Promise<void>;
  log?(line: string): void;
}

export interface MedicPassResult {
  readonly pr: number;
  readonly outcome: "healed" | "escalated" | "exhausted";
  readonly clazz: MedicFailureClass | null;
  readonly actions: readonly string[];
}

/**
 * Run ONE healing round for `pr`. Rounds are ledger-bounded: the
 * `MEDIC_MAX_ROUNDS`-th failed round escalates (`exhausted` → needs-human)
 * without touching the branch again. A `semantic` classification escalates
 * immediately and leaves the worktree cleaned. Every action is logged.
 */
export async function runMedicPass(
  io: MedicIo,
  store: MedicStore,
  pr: number,
  options: { nowEpoch: number; maxRounds?: number; registry?: Readonly<Record<string, string>> },
): Promise<MedicPassResult> {
  const maxRounds = options.maxRounds ?? MEDIC_MAX_ROUNDS;
  const state = await store.read();
  const prior = state.prs[String(pr)];
  const rounds = (prior?.rounds ?? 0) + 1;
  const actions: string[] = [];
  const record = async (outcome: MedicPrRecord["outcome"]): Promise<void> => {
    await store.write({
      version: 1,
      prs: {
        ...state.prs,
        [String(pr)]: {
          pr,
          rounds,
          outcome,
          updatedAtEpoch: options.nowEpoch,
          actions: [...(prior?.actions ?? []), ...actions],
        },
      },
    });
  };

  if (rounds > maxRounds) {
    actions.push(`round ${rounds} exceeds the ${maxRounds}-round budget — escalating`);
    io.log?.(`medic #${pr}: ${actions.at(-1)}`);
    await record("escalated");
    return { pr, outcome: "exhausted", clazz: null, actions };
  }

  try {
    const diagnosis = await io.diagnose(pr);
    const clazz = classifyMedicFailure({ ...diagnosis, registry: options.registry });
    actions.push(`round ${rounds}: classified ${clazz}`);
    io.log?.(`medic #${pr}: ${actions.at(-1)}`);

    if (clazz === "semantic") {
      actions.push("semantic failure — escalated untouched");
      io.log?.(`medic #${pr}: ${actions.at(-1)}`);
      await record("escalated");
      return { pr, outcome: "escalated", clazz, actions };
    }
    if (clazz === "stale-pi") {
      await io.regenPi(pr);
      actions.push("regenerated staged Pi mirrors");
    } else if (clazz === "stale-rename") {
      for (const [path, text] of Object.entries(diagnosis.files)) {
        const healed = applyRenameRegistry(text, options.registry);
        if (healed.replacements > 0) {
          await io.writeFile(pr, path, healed.text);
          actions.push(`renamed ${healed.replacements} identifier(s) in ${path}`);
        }
      }
    } else {
      for (const [path, text] of Object.entries(diagnosis.conflicts)) {
        const resolved = unionResolveConflicts(text);
        if (resolved === null) {
          actions.push(`conflict in ${path} is not additive — escalated untouched`);
          io.log?.(`medic #${pr}: ${actions.at(-1)}`);
          await record("escalated");
          return { pr, outcome: "escalated", clazz, actions };
        }
        await io.writeFile(pr, path, resolved);
        actions.push(`union-resolved additive conflict in ${path}`);
      }
    }
    await io.commitPush(pr, `fix: PR medic round ${rounds} (${clazz}) Refs #2513`);
    actions.push("committed and pushed the heal");
    for (const a of actions) io.log?.(`medic #${pr}: ${a}`);
    await record("healed");
    return { pr, outcome: "healed", clazz, actions };
  } finally {
    try {
      await io.cleanup(pr);
    } catch {
      // best-effort — a leaked worktree is reaped by the lane janitor.
    }
  }
}
