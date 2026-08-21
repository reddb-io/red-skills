/**
 * land-entry-points — every way a change reaches the trunk, written down (#4138).
 *
 * Spec #4129 states the risk in one sentence: **enumerate all land entry points
 * rather than discovering them.** A land precondition applied to the paths
 * somebody remembered is not a precondition — it is a suggestion with four
 * exceptions, and the exceptions are exactly where an unjudged change gets in.
 * The naive alternative is just as bad in the other direction: a blanket "no
 * Countersign, no land" bricks the legitimate no-agent paths, so the
 * enumeration has to say what each entry point's Countersign SOURCE is, not just that it has
 * one.
 *
 * So the deliverable is this table, and the ratchet beside it
 * (`tests/land-entry-points-guard.test.ts`) pins it in BOTH directions:
 *
 *   - **Nothing declared is fiction.** A declared module must exist, must
 *     export the entry it names, and — where it enforces — must actually
 *     reference the symbol that enforces. A table nobody consults is green by
 *     accident.
 *   - **Nothing undeclared merges.** Every file under the swept roots that
 *     reaches a land primitive is either declared here or exempt with a stated
 *     reason, so a NEW entry point inherits the obligation the moment its first
 *     `landPr` or `handoffMergeCustody` lands, rather than the next time
 *     somebody remembers to look.
 *
 * ## Why an entry point may enforce differently
 *
 * The five paths sit in four layers, and only the runtime layer can read a
 * project's Countersign lane. That is not an oversight to route around: a daemon
 * that read per-project Countersigns would hold the per-issue policy ADR 0144 keeps
 * out of it, and an engine that did would be a Worker body that knows what a
 * `.red/` is. {@link LandEntryPointEnforcement} names the three honest answers,
 * and each entry says which one it is and what pays for it.
 */
import { stripComments } from "./extinct-source-guard.js";

/**
 * How one entry point satisfies the land precondition.
 *
 * `delegated` is a real answer, not a dodge — a tool that only ever reaches a
 * merge through another declared entry inherits that entry's refusal, and
 * declaring it as such is what keeps the table total.
 */
export type LandEntryPointEnforcement =
  /** Reads the Countersign ledger itself; only the runtime layer can. */
  | "ledger"
  /** Holds the gate as an injected port because its layer may not reach the lane. */
  | "port"
  /** Reaches a merge only through another declared entry, and inherits its refusal. */
  | "delegated"
  /**
   * Reaches a merge and asks NOTHING — a hole, declared as one. The list of
   * these is pinned and only ever shrinks, because a gap written down is a gap
   * somebody closes and a gap nobody wrote down is one the next reader inherits
   * as architecture.
   */
  | "unenforced";

/** One way a change reaches the trunk, and what stops it when nothing judged it. */
export interface LandEntryPoint {
  /** Stable id, used by `delegatesTo` and by the ratchet's messages. */
  readonly id: string;
  /** Repo-relative module that holds the entry. */
  readonly module: string;
  /** The exported symbol callers enter through. */
  readonly entry: string;
  readonly enforcement: LandEntryPointEnforcement;
  /**
   * Where the `(pr, head_sha, patch_id)` this entry is judged on COMES FROM —
   * the sentence a reader needs to know whether the judged tree is the merged
   * tree. This is the deliverable the Spec asks for; a table of ids without it
   * would name the doors and say nothing about the locks.
   */
  readonly countersignSource: string;
  /**
   * The symbol the module must reference for its enforcement to be real.
   * Required for `ledger` and `port`; a `delegated` entry proves nothing of its
   * own and names the entry it inherits from instead.
   */
  readonly proof?: string;
  /** The declared entry whose refusal a `delegated` entry inherits. */
  readonly delegatesTo?: string;
  /** What is MISSING, for an `unenforced` entry. Required there, absent elsewhere. */
  readonly gap?: string;
  /** Repo-relative test that names this entry AND its Countersign source. */
  readonly test: string;
  /** Why this path exists at all — read by whoever wonders if it can go. */
  readonly why: string;
}

/**
 * The five paths Spec #4129 names, plus the Worker land request that is the ACP
 * method's only caller. Six rows, because splitting the ACP path in two is what
 * lets each half state the truth: the Worker holds the ledger question, and the
 * daemon holds the head it was handed.
 */
export const LAND_ENTRY_POINTS: readonly LandEntryPoint[] = [
  {
    id: "afk-lifecycle-landing",
    module: "apps/plugin-dev/src/core/landing.ts",
    entry: "doLanding",
    enforcement: "ledger",
    countersignSource:
      "the head is `LandingInput.validatedBranchTip` when the caller pinned the tip its gate validated, else the freshly resolved `<remote>/<branch>` tip; `landHeadPrecondition` asks the injected gate about that exact object name and refuses `unverified-head` before the pre_merge hook fires.",
    proof: "landHeadPrecondition",
    test: "apps/plugin-dev/tests/landing-countersign.test.ts",
    why: "the flag-toggled landing every AFK path funnels through — PR admin-merge or direct merge, both from here.",
  },
  {
    id: "reconcile-adopt-branch",
    module: "apps/plugin-dev/src/core/reconcile.ts",
    entry: "reconcile",
    enforcement: "ledger",
    countersignSource:
      "the head is the fetched `origin/<branch>` tip this lane just validated; a human adopting the branch signs `human:<login>` through `recordAdoptionCountersign` BEFORE the landing, so the no-agent path holds a row rather than an exemption, and the same gate then judges it.",
    proof: "recordAdoptionCountersign",
    test: "apps/plugin-dev/tests/reconcile.test.ts",
    why: "the no-agent reland: validate a parked branch and land it without re-running the agent (ADR 0055), and the lane `/retake --adopt-branch` enters.",
  },
  {
    id: "land-tool",
    module: "apps/plugin-dev/src/mcp-tools/landing.ts",
    entry: "createLandingTools",
    enforcement: "delegated",
    delegatesTo: "afk-lifecycle-landing",
    countersignSource:
      "none of its own: `land_branch` carries `{issue, branch, base?, title?, openPr?}` and no SHA, and its host dependency reaches a merge only through `doLanding`, whose gate judges the head it resolves.",
    test: "apps/plugin-dev/tests/land-entry-points-guard.test.ts",
    why: "the operator-facing MCP verb for landing one validated worker branch.",
  },
  {
    id: "merge-driver",
    module: "packages/worker/src/engine/merge-driver.ts",
    entry: "runMergeDriverPass",
    enforcement: "port",
    countersignSource:
      "the pull request number on the armed record; the gate resolves the live head itself, and is asked immediately before `io.merge` rather than at arming, because the head may move between the two.",
    proof: "countersignGate",
    test: "packages/worker/src/engine/merge-driver.test.ts",
    why: "the castle-owned loop that lands armed PRs without the forge's native auto-merge (Spec #2511).",
  },
  {
    id: "worker-land-request",
    module: "packages/worker/src/acp/ticket-loop.ts",
    entry: "runTicketLoop",
    enforcement: "port",
    countersignSource:
      "the commit its own publish stage produced (`published.publication.commit`, #4130) — the exact object name the land request is about to carry, asked before the request is sent.",
    proof: "landCountersignGate",
    test: "packages/worker/src/acp/ticket-loop.test.ts",
    why: "the only thing in the tree that issues an ACP land request.",
  },
  {
    id: "acp-custody-handoff-method",
    module: "apps/redskilled/src/acp-github.ts",
    entry: "bindAcpProjectGithubCustodyHandoff",
    enforcement: "unenforced",
    countersignSource:
      "none. `githubCustodyHandoffParams` accepts EXACTLY `{pull_request, owner_ticket, branch, base}` and refuses any other key, so the armed head #4130 threads through the in-process door cannot travel through this one — two doors to the same custodian with different contracts.",
    gap: "the public custody-handoff method carries no head and consults no ledger; closing it means the handoff wire carrying `armed_head` here too, which is a protocol change this ticket does not make.",
    test: "apps/plugin-dev/tests/land-entry-points-guard.test.ts",
    why: "the public ACP method by which a Project hands an already-open pull request's merge to custody.",
  },
  {
    id: "acp-land-method",
    module: "apps/redskilled/src/acp-publication.ts",
    entry: "bindAcpWorkerLand",
    enforcement: "delegated",
    delegatesTo: "worker-land-request",
    countersignSource:
      "the `commit` field the request carries, validated as one full object name and pinned as the custody record's `armed_head` (#4130) so a head that moves after arming is reported rather than merged; the ledger question belongs to the caller, because a daemon that read per-project Countersigns would hold the per-issue policy ADR 0144 keeps out of it.",
    test: "apps/redskilled/tests/github-custody-armed-head.test.ts",
    why: "the daemon method that opens the pull request and hands its merge to custody.",
  },
];

/**
 * The identifiers that REACH a merge. Not "the word merge" — that appears in
 * every third comment — but the named surfaces through which a change actually
 * arrives on a base branch.
 */
export const LAND_MERGE_PRIMITIVES: readonly string[] = [
  "landPr",
  "landMerge",
  "handoffMergeCustody",
  "runMergeDriverPass",
  "runCastleLanding",
];

/** A file that names a primitive without being a way in, and why it is not. */
export interface LandPrimitiveExemption {
  readonly path: string;
  readonly why: string;
}

/**
 * The files that hold a primitive without being an entrance to one.
 *
 * Every entry is one file with one reason, never a directory or a glob: a
 * pattern exemption is how the next entry point slips in wearing a familiar
 * path.
 */
export const LAND_PRIMITIVE_EXEMPTIONS: readonly LandPrimitiveExemption[] = [
  {
    path: "apps/plugin-dev/src/core/merge.ts",
    why: "declares `landPr` and `landMerge` themselves — the executors every landing runs, reached only through a declared entry point.",
  },
  {
    path: "apps/plugin-dev/src/core/land-entry-points.ts",
    why: "this table itself: it must SPELL every primitive to refuse an undeclared reach to one, the same way an extinction inventory spells the noun it forbids.",
  },
  {
    path: "apps/redskilled/src/github-gateway.ts",
    why: "constructs the custodian and forwards the handoff; the Project authority it resolves is not a landing decision.",
  },
  {
    path: "packages/worker/src/engine/landing.ts",
    why: "declares `runCastleLanding`, whose `land()` port is abstract and has no implementation anywhere in the tree — it merges nothing itself. The exemption is what makes the port visible: any file that ever binds it names `runCastleLanding` and is refused here until it declares its Countersign source.",
  },
];

export type LandEntryPointFindingKind =
  | "undeclared-entry-point"
  | "missing-module"
  | "missing-entry"
  | "unproven-enforcement"
  | "unknown-delegation"
  | "unstated-gap"
  | "stale-exemption";

export interface LandEntryPointFinding {
  readonly kind: LandEntryPointFindingKind;
  readonly path: string;
  readonly reason: string;
}

/** One swept source file: its repo-relative path and its whole text. */
export interface LandSweptFile {
  readonly path: string;
  readonly text: string;
}

function reachesPrimitive(text: string): string | null {
  const source = stripComments(text);
  return LAND_MERGE_PRIMITIVES.find((token) => new RegExp(`\\b${token}\\b`).test(source)) ?? null;
}

/**
 * Judge the declared table against the tree. PURE — the caller reads the files.
 *
 * The two directions are deliberately asymmetric in what they cost: proving a
 * declaration real is a token match on one file, while proving nothing is
 * undeclared is a sweep of every file. Both run in the invariants aggregate,
 * so both stay cheap: no parse, no type information, one pass per file.
 */
export function auditLandEntryPoints(
  files: readonly LandSweptFile[],
  entries: readonly LandEntryPoint[] = LAND_ENTRY_POINTS,
  exemptions: readonly LandPrimitiveExemption[] = LAND_PRIMITIVE_EXEMPTIONS,
): LandEntryPointFinding[] {
  const findings: LandEntryPointFinding[] = [];
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  const declaredPaths = new Set(entries.map((entry) => entry.module));
  const exemptPaths = new Map(exemptions.map((exemption) => [exemption.path, exemption.why]));
  const ids = new Set(entries.map((entry) => entry.id));

  for (const entry of entries) {
    const text = byPath.get(entry.module);
    if (text === undefined) {
      findings.push({
        kind: "missing-module",
        path: entry.module,
        reason: `LAND_ENTRY_POINTS declares "${entry.id}" at ${entry.module}, which the sweep did not find. A declared door nobody can open is fiction — drop the entry or fix its path.`,
      });
      continue;
    }
    const source = stripComments(text);
    if (!new RegExp(`export\\s+(async\\s+)?function\\s+${entry.entry}\\b`).test(source)) {
      findings.push({
        kind: "missing-entry",
        path: entry.module,
        reason: `"${entry.id}" names ${entry.entry} as its entry, and ${entry.module} exports no such function. Rename the declaration to the symbol callers actually enter through.`,
      });
    }
    if (entry.enforcement === "unenforced") {
      if ((entry.gap ?? "").trim().length < 40) {
        findings.push({
          kind: "unstated-gap",
          path: entry.module,
          reason: `"${entry.id}" declares no enforcement and states no gap. An unenforced entrance nobody described is a hole the next reader inherits as architecture.`,
        });
      }
      continue;
    }
    if (entry.enforcement === "delegated") {
      if (entry.delegatesTo === undefined || !ids.has(entry.delegatesTo)) {
        findings.push({
          kind: "unknown-delegation",
          path: entry.module,
          reason: `"${entry.id}" delegates its refusal to ${JSON.stringify(entry.delegatesTo)}, which LAND_ENTRY_POINTS does not declare. A delegation to nothing is an unguarded entrance.`,
        });
      }
      continue;
    }
    if (entry.proof === undefined || !new RegExp(`\\b${entry.proof}\\b`).test(source)) {
      findings.push({
        kind: "unproven-enforcement",
        path: entry.module,
        reason: `"${entry.id}" claims ${entry.enforcement} enforcement through ${JSON.stringify(entry.proof)}, and ${entry.module} never references it. An enforcement point that imports nothing enforces nothing.`,
      });
    }
  }

  for (const file of files) {
    if (declaredPaths.has(file.path) || exemptPaths.has(file.path)) continue;
    const token = reachesPrimitive(file.text);
    if (token === null) continue;
    findings.push({
      kind: "undeclared-entry-point",
      path: file.path,
      reason: `${file.path} reaches the land primitive ${token} and LAND_ENTRY_POINTS does not declare it. Every way a change reaches the trunk states its Countersign source (Spec #4129, ADR 0156) — declare it in apps/plugin-dev/src/core/land-entry-points.ts, or exempt the file there with the reason it merges nothing.`,
    });
  }

  for (const exemption of exemptions) {
    const text = byPath.get(exemption.path);
    if (text !== undefined && reachesPrimitive(text) !== null) continue;
    findings.push({
      kind: "stale-exemption",
      path: exemption.path,
      reason: `${exemption.path} is exempted from LAND_ENTRY_POINTS and no longer reaches a land primitive. An exemption nobody needs is one the next reader trusts for the wrong file — drop it.`,
    });
  }

  return findings;
}
