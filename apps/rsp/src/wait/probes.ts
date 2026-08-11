/**
 * probes.ts — one observation of a GitHub target, turned into a verdict.
 *
 * A probe is deliberately stateless and side-effect free: it observes once and
 * classifies. `running` means "ask again", `indeterminate` means "this
 * observation failed, but the target may still be fine" — the poll loop retries
 * both and only the deadline turns them terminal.
 */
import { indeterminate, running, verdictOf, type Verdict } from "./model.js";
import { ghJson, type GhCallOptions } from "./github.js";
import { arrayOfRecords, isRecord, parseRecord } from "./json.js";
import type { JsonObject } from "@reddb-io/toon";

export interface PrProbeOptions {
  /**
   * How long a PR with zero registered checks is treated as "checks are still
   * being created" rather than "this repo has no checks". Without the grace
   * window a wait started the instant a PR opens would call it green before CI
   * had a chance to register.
   */
  emptyChecksGraceMs: number;
}

/** Bind a PR probe to the moment the wait started, for the empty-checks grace. */
export function createPrProbe(number: string, call: GhCallOptions, options: PrProbeOptions): () => Promise<Verdict> {
  const startedAt = Date.now();
  return () => probePr(number, call, options, startedAt);
}

export async function probePr(
  number: string,
  call: GhCallOptions,
  options: PrProbeOptions,
  startedAt: number,
): Promise<Verdict> {
  if (!/^[1-9][0-9]*$/.test(number)) return indeterminate("missing PR number");
  const result = await ghJson(["pr", "view", number, "--json", "number,state,mergeable,statusCheckRollup,url"], call);
  if (result.status !== 0) return indeterminate(result.stderr || "gh pr view failed");
  const row = parseRecord(result.stdout);
  const checks = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : [];
  const mergeable = String(row.mergeable ?? "");
  const states = checks.map(checkState);
  const failing = states.filter((state) => state === "failure").length;
  const pending = states.filter((state) => state === "pending").length;

  if (String(row.state) !== "OPEN") {
    return verdictOf("failure", `PR #${number} is ${String(row.state).toLowerCase()}`, { mergeable });
  }
  // A conflicting PR cannot merge no matter how green its checks are, so this
  // outranks the check rollup.
  if (mergeable === "CONFLICTING") {
    return verdictOf("failure", `PR #${number} has merge conflicts`, { failing, pending, mergeable });
  }
  if (failing > 0) return verdictOf("failure", `PR #${number} has failing checks`, { failing, pending, mergeable });
  if (pending > 0) return running(`PR #${number} has ${pending} pending checks`);
  if (checks.length === 0) {
    const elapsedMs = Date.now() - startedAt;
    // `BLOCKED` with zero reported checks is the state GitHub uses when required
    // checks are configured but have not been created yet, so it is proof that
    // checks ARE required — the opposite of "no checks configured". It outranks
    // the grace window: no amount of elapsed time turns it into a success.
    // Only `CLEAN`/`MERGEABLE` with zero checks is the genuine no-checks repo.
    if (mergeable === "UNKNOWN" || mergeable === "BLOCKED" || elapsedMs < options.emptyChecksGraceMs) {
      return running(`PR #${number} has no registered checks yet`, {
        checks: 0,
        mergeable,
        empty_checks_elapsed_ms: elapsedMs,
      });
    }
    return verdictOf("success", `PR #${number} has no checks configured`, { checks: 0, mergeable });
  }
  // GitHub computes mergeability asynchronously; UNKNOWN is a not-yet, not a no.
  if (mergeable === "UNKNOWN") {
    return running(`PR #${number} mergeability is still unknown`, { checks: checks.length, mergeable });
  }
  return verdictOf("success", `PR #${number} checks passed`, { checks: checks.length, mergeable });
}

export async function probeRun(id: string, call: GhCallOptions): Promise<Verdict> {
  if (!id) return indeterminate("missing run id");
  const result = await ghJson(
    ["run", "view", id, "--json", "databaseId,status,conclusion,workflowName,headBranch,url"],
    call,
  );
  if (result.status !== 0) return indeterminate(result.stderr || "gh run view failed");
  const row = parseRecord(result.stdout);
  const status = String(row.status ?? "").toLowerCase();
  const conclusion = String(row.conclusion ?? "").toLowerCase();
  if (status !== "completed") return running(`run ${id} is ${status || "pending"}`);
  if (conclusion === "success") return verdictOf("success", `run ${id} succeeded`, runDetails(row));
  return verdictOf("failure", `run ${id} concluded ${conclusion || "unknown"}`, runDetails(row));
}

/** Observe one Actions job through the resident conditional-REST client. */
export async function probeJob(id: string, call: GhCallOptions): Promise<Verdict> {
  if (!/^[1-9][0-9]*$/.test(id)) return indeterminate("missing job id");
  const result = await ghJson(["job", "view", id], call);
  if (result.status !== 0) return indeterminate(result.stderr || "GitHub Actions job read failed");
  return verdictForJob(id, parseRecord(result.stdout));
}

export function verdictForJob(id: string, row: Record<string, unknown>): Verdict {
  const status = String(row.status ?? "").toLowerCase();
  const conclusion = String(row.conclusion ?? "").toLowerCase();
  if (status !== "completed") return running(`job ${id} is ${status || "pending"}`);
  const details: JsonObject = {
    job_id: typeof row.databaseId === "number" ? row.databaseId : id,
    conclusion,
    name: String(row.name ?? ""),
    url: String(row.url ?? ""),
  };
  return conclusion === "success"
    ? verdictOf("success", `job ${id} succeeded`, details)
    : verdictOf("failure", `job ${id} concluded ${conclusion || "unknown"}`, details);
}

/**
 * Resolve `--branch <b> --latest` to a concrete run ID.
 *
 * This runs ONCE, before polling starts, and the result is pinned: re-resolving
 * every poll would let a newly pushed run silently become the target mid-wait.
 */
export async function latestRunId(branch: string, call: GhCallOptions): Promise<string> {
  const result = await ghJson(["run", "list", "--branch", branch, "--limit", "1", "--json", "databaseId"], call);
  if (result.status !== 0) return "";
  const rows = JSON.parse(result.stdout) as unknown;
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return isRecord(first) && first.databaseId != null ? String(first.databaseId) : "";
}

/**
 * Wait for the NEXT matching release. Only releases published after the wait
 * started count, so an existing tag cannot resolve the wait instantly.
 */
export async function probeRelease(
  tagGlob: string | undefined,
  startedAt: Date,
  call: GhCallOptions,
  includeExisting = false,
): Promise<Verdict> {
  if (includeExisting && tagGlob && !/[?*]/.test(tagGlob)) {
    const result = await ghJson(["release", "view", tagGlob, "--json", "tagName,publishedAt,isDraft"], call);
    if (result.status !== 0) return running(`release ${tagGlob} is not published yet`);
    const release = parseRecord(result.stdout);
    if (release.isDraft === true) return running(`release ${tagGlob} is still a draft`);
    return verdictOf("success", `release ${String(release.tagName || tagGlob)} published`, {
      tag: String(release.tagName || tagGlob),
      published_at: String(release.publishedAt ?? ""),
    });
  }
  const result = await ghJson(["release", "list", "--limit", "20", "--json", "tagName,publishedAt,isDraft"], call);
  if (result.status !== 0) return indeterminate(result.stderr || "gh release list failed");
  const releases = arrayOfRecords(JSON.parse(result.stdout) as unknown);
  const match = releases.find((release) => {
    const tag = String(release.tagName ?? "");
    const publishedAt = new Date(String(release.publishedAt ?? ""));
    return release.isDraft !== true && (!tagGlob || globMatches(tagGlob, tag)) && (includeExisting || publishedAt >= startedAt);
  });
  if (!match) return running("no matching release is published yet");
  return verdictOf("success", `release ${String(match.tagName)} published`, {
    tag: String(match.tagName),
    published_at: String(match.publishedAt ?? ""),
  });
}

/**
 * Collapse GitHub's several check vocabularies (check runs, commit statuses,
 * rollup entries) into pass / fail / not-yet. `neutral` and `skipped` are
 * successes: they are checks that deliberately declined to block.
 */
export function checkState(value: unknown): "success" | "failure" | "pending" {
  const row = isRecord(value) ? value : {};
  const conclusion = String(row.conclusion ?? row.state ?? row.status ?? "").toLowerCase();
  if (["success", "successful", "passed", "completed", "neutral", "skipped"].includes(conclusion)) return "success";
  if (["failure", "failed", "error", "timed_out", "cancelled", "action_required"].includes(conclusion)) return "failure";
  return "pending";
}

function runDetails(row: Record<string, unknown>): JsonObject {
  return {
    database_id: typeof row.databaseId === "number" ? row.databaseId : String(row.databaseId ?? ""),
    conclusion: String(row.conclusion ?? ""),
    workflow: String(row.workflowName ?? ""),
    branch: String(row.headBranch ?? ""),
    url: String(row.url ?? ""),
  };
}

/** Shell-style `*`/`?` matching for release tags, anchored end to end. */
export function globMatches(glob: string, value: string): boolean {
  const pattern = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`).test(value);
}
