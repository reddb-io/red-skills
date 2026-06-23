// commands/requeue.ts — the IO half of `dev requeue` (issue #850).
//
// The SAFE requeue path for an issue parked behind an active `## Current
// blocker`. A maintainer who only flips labels back to `ready-for-agent`
// creates a silent no-op loop: AFK preflight re-reads the active non-mechanical
// blocker and re-parks the issue. This command applies the WHOLE transition as
// one operation — clear/archive the active blocker in the body, drop the stale
// `ready-for-human` + `blocked:*` labels, add `ready-for-agent`, and record the
// human guidance as a directive comment. The pure planner lives in
// `core/requeue.ts`; `/hitl` is the interactive sibling for when the human
// decision still has to be extracted.

import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { execTool, type ExecFn } from "../runtime/exec.js";
import { planRequeue, type RequeuePlan } from "../core/requeue.js";

export interface RequeueGh {
  view(issue: number): Promise<{ state: string; body: string; labels: string[] }>;
  editBody(issue: number, body: string): Promise<void>;
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
  comment(issue: number, body: string): Promise<void>;
}

const REQUEUE_FLAG_SCHEMA = {
  guidance: { kind: "value", coerce: (raw: string): string => raw },
  repo: { kind: "value", aliases: ["R"], coerce: (raw: string): string => raw },
  json: { kind: "boolean" },
  "dry-run": { kind: "boolean" },
} satisfies FlagSchema;

function parseIssue(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw.replace(/^#/, ""), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function ghFor(cwd: string, repo: string): RequeueGh {
  const repoArgs = repo ? ["--repo", repo] : [];
  const run = (args: readonly string[]): ReturnType<ExecFn> =>
    execTool("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return {
    async view(issue) {
      const out = await run(["issue", "view", String(issue), ...repoArgs, "--json", "state,body,labels"]);
      if (out.code !== 0) throw new Error(`read issue #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
      const raw = JSON.parse(out.stdout || "{}") as { state?: string; body?: string; labels?: Array<{ name?: string }> };
      return {
        state: typeof raw.state === "string" ? raw.state : "",
        body: typeof raw.body === "string" ? raw.body : "",
        labels: Array.isArray(raw.labels) ? raw.labels.map((l) => String(l.name ?? "")).filter(Boolean) : [],
      };
    },
    async editBody(issue, body) {
      const out = await run(["issue", "edit", String(issue), ...repoArgs, "--body", body]);
      if (out.code !== 0) throw new Error(`edit body #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
    },
    async editLabels(issue, remove, add) {
      const args = ["issue", "edit", String(issue), ...repoArgs];
      for (const l of remove) args.push("--remove-label", l);
      for (const l of add) args.push("--add-label", l);
      const out = await run(args);
      if (out.code !== 0) throw new Error(`edit labels #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
    },
    async comment(issue, body) {
      await run(["issue", "comment", String(issue), ...repoArgs, "--body", body]);
    },
  };
}

function directiveComment(plan: RequeuePlan, guidance?: string): string {
  const lines = [
    "<details data-kind=\"directive\">",
    "<summary>Requeue</summary>",
    "",
    "Human guidance:",
    guidance?.trim() || "(none recorded)",
    "",
    `Disposition:\nrequeued to ready-for-agent${plan.activeBlocker ? ` (cleared active blocker: ${plan.activeBlocker.kind})` : ""}`,
    "</details>",
  ];
  return lines.join("\n");
}

async function resolveRepo(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const r = await execTool("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd });
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * `requeue <issue> [--guidance text] [--repo owner/repo] [--json] [--dry-run]`
 * — apply the one-shot requeue transition. A non-parked issue is a no-op (exit
 * 0). `--dry-run` prints the plan without mutating. The `gh` dependency is
 * injectable for tests; production wires the gh CLI.
 */
export async function requeueCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  ghOverride?: RequeueGh,
): Promise<number> {
  const { values, positionals } = parseFlags(args, REQUEUE_FLAG_SCHEMA);
  const issue = parseIssue(positionals[0]);
  if (issue === undefined) {
    process.stderr.write("[afk] requeue requires an issue number like #123\n");
    return 2;
  }
  const guidance = (values.guidance as string | undefined)?.trim();
  const json = values.json === true;
  const dryRun = values["dry-run"] === true;

  if (!guidance) {
    process.stderr.write("[afk] requeue requires --guidance with the retry decision so it can be recorded as Human guidance\n");
    return 2;
  }

  const repo = ghOverride ? "" : await resolveRepo(cwd, values.repo as string | undefined);
  const gh = ghOverride ?? ghFor(cwd, repo);

  const issueState = await gh.view(issue);
  if (issueState.state.toUpperCase() !== "OPEN") {
    process.stderr.write(`[afk] requeue #${issue}: issue is ${issueState.state || "unknown"}, not OPEN\n`);
    return 1;
  }

  const plan = planRequeue({ body: issueState.body, labels: issueState.labels, guidance });
  if (!plan.requeueable) {
    if (plan.refuseForHitl) {
      process.stderr.write(`[afk] requeue #${issue}: refused — ${plan.reason}\n`);
      return 1;
    }
    stdout.write(`Requeue #${issue}: no-op — ${plan.reason}\n`);
    return 0;
  }

  if (dryRun) {
    stdout.write(
      json
        ? `${JSON.stringify({ issue, plan }, null, 2)}\n`
        : `Requeue #${issue} (dry-run): clear blocker=${plan.bodyChanged} remove=[${plan.removeLabels.join(",")}] add=[${plan.addLabels.join(",")}]\n`,
    );
    return 0;
  }

  if (plan.bodyChanged) await gh.editBody(issue, plan.body);
  await gh.comment(issue, directiveComment(plan, guidance));
  await gh.editLabels(issue, plan.removeLabels, plan.addLabels);

  stdout.write(
    json
      ? `${JSON.stringify({ issue, plan, applied: true }, null, 2)}\n`
      : `Requeue #${issue}: cleared blocker=${plan.bodyChanged}, removed [${plan.removeLabels.join(",")}], added [${plan.addLabels.join(",")}].\n`,
  );
  return 0;
}
