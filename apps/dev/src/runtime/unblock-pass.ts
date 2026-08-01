// runtime/unblock-pass.ts — the Unblock Sweep as a STANDALONE pass (#3014).
//
// DIAGNOSIS — which clearer was expected, and why it could not fire. Three
// paths can drop a stale `blocked:dependency` label once the last `req:*`
// blocker closes:
//
//   1. the event-driven close cascade (`runCloseCascade`), reachable ONLY from a
//      worker's terminal stage or from `reconcile()` — i.e. only when the AGENT
//      is the one that closes the blocker;
//   2. the Unblock Sweep as step 7 of `runBoot`, reachable from an `/afk` boot
//      and from the castle resident's periodic janitor;
//   3. the `unblock_sweep` MCP tool, reachable only when somebody calls it.
//
// On a repo operated through live sessions only, a HUMAN closes the blocker in
// the GitHub UI, so (1) never runs — no local code observes that tracker event
// (webhook deliveries land in the singleton lane, where only `rsp wait` reads
// them). (2) IS awake there — the resident janitor runs the boot suite every
// five minutes — but it is the SEVENTH step of a suite that routinely aborts
// before reaching it: a failing precheck returns after step 1, a red operational
// probe throws `BootHaltError` at step 1a, and step 6's docs sweep halts on any
// stranded `.red/` doc, which is the ordinary state of a repo a human edits by
// hand. So the promote path was reachable in principle and starved in practice,
// and the drift outlived every session until a human pointed at it.
//
// THE FIX starts here: the sweep expressed as a pass that needs `gh` and NOTHING
// else — no probes, no git, no worktrees, no boot suite — so the resident can
// schedule it on its own belt (`resident-unblock.ts`) where no unrelated halt
// can starve it. The IO is injected, so the promote path is provable without a
// tracker.
import { executeUnblockSweep, type UnblockCandidate } from "../core/boot-sweep.js";
import { loadConfig, readHitlTypeLabels } from "../core/config.js";
import * as ghx from "./gh.js";
import { afkPaths, resolveRepoContext } from "./wire.js";

/** The whole tracker surface one Unblock pass touches: read the blocked set,
 * resolve each blocker's closed-state, rotate labels, post the audit comment.
 * Injected so the pass is testable without gh — and so a reader can see at a
 * glance that it needs no git, no worktree, and no boot probe. */
export interface UnblockPassIo {
  /** Every open issue carrying `blocked:dependency`, with body and labels. */
  listCandidates(): Promise<UnblockCandidate[]>;
  /** Whether blocker `issue` is CLOSED. A transient miss answers false, which
   * leaves the dependent blocked — the conservative direction. */
  issueClosed(issue: number): Promise<boolean>;
  /** Rotate labels — REMOVE first, ADD second (BootDeps.gh order). */
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
  /** Optional human-facing metadata for the rendered dependency refs. */
  issueReference?(
    issue: number,
  ): Promise<{ number: number; title?: string; url?: string } | undefined>;
  /** The types this repo's vocabulary declares HUMAN-ONLY, deciding the lane a
   * promotion routes to (#2966). */
  hitlTypes(): readonly string[];
}

/**
 * Run one Unblock pass over `io`: promote every `blocked:dependency` issue whose
 * declared `req:*` blockers are all CLOSED, and return the promoted numbers.
 *
 * A repo with nothing blocked costs ONE `gh issue list` and no further call —
 * that cheapness is what makes the pass affordable at every session boot. The
 * promote decision itself is unchanged: {@link executeUnblockSweep} stays the
 * single mutation path, so a boot-time sweep, the MCP tool, and this pass all
 * promote identically.
 */
export async function runUnblockPass(io: UnblockPassIo): Promise<number[]> {
  const candidates = await io.listCandidates();
  if (candidates.length === 0) return [];
  return executeUnblockSweep(
    candidates,
    async (issue) => ((await io.issueClosed(issue)) ? "CLOSED" : "OPEN"),
    {
      editLabels: (issue, remove, add) => io.editLabels(issue, remove, add),
      comment: (issue, body) => io.comment(issue, body),
      ...(io.issueReference ? { issueReference: io.issueReference.bind(io) } : {}),
    },
    io.hitlTypes(),
  );
}

/** Bind {@link UnblockPassIo} to this repo's real `gh` surface and config. */
export async function createUnblockPassIo(root: string): Promise<UnblockPassIo> {
  const context = await resolveRepoContext(root);
  const gh = { cwd: context.root, repo: context.repo };
  const hitlTypes = readHitlTypeLabels(
    loadConfig(afkPaths(root).configPath, { warn: () => undefined }),
  );
  return {
    listCandidates: () => ghx.listUnblockCandidates(gh),
    issueClosed: (issue) => ghx.issueClosed(gh, issue),
    editLabels: async (issue, remove, add) => {
      await ghx.editLabels(gh, issue, remove, add);
    },
    comment: (issue, body) => ghx.comment(gh, issue, body),
    issueReference: (issue) => ghx.issueReference(gh, issue),
    hitlTypes: () => hitlTypes,
  };
}

/** Run one Unblock pass against the real repo at `root`. */
export async function runRepoUnblockPass(root: string): Promise<number[]> {
  return runUnblockPass(await createUnblockPassIo(root));
}
