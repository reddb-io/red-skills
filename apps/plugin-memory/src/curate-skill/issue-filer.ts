/**
 * issue-filer — thin module that turns a candidate-reader `ReadResult` into a
 * `ready-for-human` GitHub Issue. Used by `/curate --background`, the
 * non-interactive Phase 2 entry point of the consent contract.
 *
 * The mutation surface of `/curate` is unchanged: this module **never** touches
 * a Skill file. Its only side effect is `gh issue create` against the project's
 * Issue tracker. The agent (or AFK) then runs interactive `/curate` against
 * the approved set to perform the archive — that path keeps the same atomic
 * rename + hash-manifest guarantees as the tracer slice.
 *
 * Per the slice brief there is no dedicated unit test here: the formatter is
 * exercised through CLI integration and `gh` itself is a boundary module.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planGithubWrite } from "@reddb-io/github";
import { CURATE_CATEGORIES, type ArchiveCandidate, type CurateCategory } from "./types.js";

const CATEGORY_HEADERS: Record<CurateCategory, string> = {
  stale: "Stale",
  abandoned: "Abandoned",
  "frequently-failing": "Frequently failing",
  archive: "Archive",
};

export interface BackgroundReport {
  byCategory: Partial<Record<CurateCategory, ArchiveCandidate[]>>;
  totals: {
    totalSkills: number;
    curatableSkills: number;
    readOnlySkills: number;
  };
  generatedAt?: string;
}

export interface FileIssueOptions {
  /** Working directory passed to `gh` (must be inside a repo with a remote). */
  cwd: string;
  /** Label applied to the issue. Defaults to `ready-for-human`. */
  label?: string;
  /** Override the spawn for tests. */
  spawn?: typeof spawnSync;
}

export interface FileIssueReceipt {
  /** Raw stdout from `gh issue create` — typically the issue URL. */
  output: string;
  /** Title used. */
  title: string;
}

/** Pure: total number of candidates across every category in the report. */
export function totalCandidates(byCategory: BackgroundReport["byCategory"]): number {
  let n = 0;
  for (const c of CURATE_CATEGORIES) n += byCategory[c]?.length ?? 0;
  return n;
}

/** Pure: title for the filed issue. */
export function renderIssueTitle(byCategory: BackgroundReport["byCategory"]): string {
  const n = totalCandidates(byCategory);
  const noun = n === 1 ? "candidate" : "candidates";
  return `/curate: ${n} Curatable-skill ${noun} ready for human review`;
}

/**
 * Pure: render the issue body in markdown. Categories with zero candidates are
 * omitted (no empty headers), matching the interactive view's rule.
 */
export function renderIssueBody(report: BackgroundReport): string {
  const { byCategory, totals } = report;
  const lines: string[] = [];
  lines.push(
    "Filed by `/curate --background`. Each entry is a **Curatable skill** surfaced by Skill telemetry; no Skill file has been mutated.",
  );
  lines.push("");
  lines.push(
    `Totals: ${totals.curatableSkills} curatable / ${totals.totalSkills} total skills (${totals.readOnlySkills} read-only).`,
  );
  if (report.generatedAt) {
    lines.push("");
    lines.push(`Report generated at \`${report.generatedAt}\`.`);
  }
  lines.push("");
  lines.push("## Candidates");
  for (const category of CURATE_CATEGORIES) {
    const bucket = byCategory[category];
    if (!bucket || bucket.length === 0) continue;
    lines.push("");
    lines.push(`### ${CATEGORY_HEADERS[category]} (${bucket.length})`);
    lines.push("");
    for (const cand of bucket) {
      lines.push(`- **${cand.name}** \`(${cand.source_kind})\``);
      lines.push(`  - path: \`${cand.path}\``);
      lines.push(`  - evidence: ${cand.reason}`);
    }
  }
  lines.push("");
  lines.push("## How to close the loop");
  lines.push("");
  lines.push(
    "Approve by running interactive `/curate` (or `/afk` against this issue) and naming the skills to archive. The archive path is the same atomic-rename + hash-manifest flow used by the tracer slice; recover any archive with `/curate --restore <name>`.",
  );
  return lines.join("\n");
}

/**
 * Side-effecting: invoke `gh issue create` with the rendered title/body and
 * the `ready-for-human` label. The body is passed via `--body-file` to avoid
 * argv length limits on large candidate sets.
 */
export async function fileBackgroundIssue(
  report: BackgroundReport,
  opts: FileIssueOptions,
): Promise<FileIssueReceipt> {
  const label = opts.label ?? "ready-for-human";
  const spawn = opts.spawn ?? spawnSync;
  const title = renderIssueTitle(report.byCategory);
  const body = renderIssueBody(report);

  const tmp = await mkdtemp(join(tmpdir(), "curate-bg-issue-"));
  const bodyPath = join(tmp, "body.md");
  try {
    await writeFile(bodyPath, body, "utf8");
    const plan = planGithubWrite(["gh", "issue", "create", "--title", title, "--body-file", bodyPath, "--label", label]);
    const proc = spawn(
      plan.args[0]!,
      plan.args.slice(1),
      { cwd: opts.cwd, encoding: "utf8" },
    );
    if (proc.status !== 0) {
      const stderr = (proc.stderr ?? "").toString().trim();
      throw new Error(
        `curate background: gh issue create exited ${proc.status ?? "?"}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    return { output: (proc.stdout ?? "").toString().trim(), title };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
