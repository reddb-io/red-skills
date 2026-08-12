// commands/hitl-card.ts — the IO half of `dev hitl-card` (issue #927).
//
// Three subcommands:
//   render  --issue=N [--repo=R]
//       Post or update the decision card comment on a ready-for-human issue.
//   act  --issue=N --body="..." --author="..." [--repo=R]
//       Parse a human comment as a card command and execute the action.
//   refresh  --issue=N [--repo=R]
//       Update the card's status section in place (idempotent).
//
// Injection safety: the `--body` flag carries the raw comment text. It is parsed
// by parseCardCommand (first non-blank line only) and classifyNaturalLanguage
// (keyword matching). The issue body is never parsed for commands.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  createGithubAttributionLedger,
  createGithubClient,
  planGithubRestRead,
  planGithubWrite,
  routeGithubArgs,
  type GithubClient,
  type GithubWritePlan,
} from "@reddb-io/github";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { stateDir } from "@reddb-io/shared/red-paths.js";
import { execTool, type ExecFn } from "../runtime/exec.js";
import { scrubOutbound } from "../runtime/outbound-redaction.js";
import { parseTrustPolicy, resolveActorTrust } from "../core/trust-gate.js";
import { actorTrustSignals, type GhContext } from "../runtime/gh.js";
import { loadConfig } from "../core/config.js";
import { resolveConfigPath } from "./route-model-tier.js";
import { parseCurrentBlocker } from "../core/blocker-state.js";
import { applyRequeue } from "../core/requeue.js";
import { blockedLabelsIn } from "../core/state-transition.js";
import { parseClaimRecords, renderClaimComment } from "../core/claim.js";
import { LABEL_HUMAN } from "../core/triage-labels.js";
import {
  renderCard,
  updateCardStatus,
  isHitlCard,
  parseCardCommand,
  classifyNaturalLanguage,
  evaluateHitlCardActionRate,
  HITL_CARD_ACTION_LIMIT,
  HITL_CARD_ACTION_MARKER,
  HITL_CARD_ACTION_WINDOW_MS,
  HITL_CARD_STAND_DOWN_MARKER,
  parseCiChecks,
  shouldIgnoreHitlCardComment,
  type HitlCardActionComment,
  type HitlCardActorIdentity,
  type PrStatus,
  type CardCommand,
} from "../core/hitl-card.js";
import { enrichIssueReferences as enrichTicketRefs } from "../core/issue-reference.js";
import { inferGitHubRepoSlug } from "../runtime/wire/github-slug.js";
import { verifyFreshBase } from "./requeue.js";

const FLAG_SCHEMA = {
  issue: { kind: "value", coerce: (raw: string): number => Number(raw) },
  body: { kind: "value", coerce: (raw: string): string => raw },
  author: { kind: "value", coerce: (raw: string): string => raw },
  "author-type": { kind: "value", coerce: (raw: string): string => raw },
  "allowed-authors": { kind: "value", coerce: (raw: string): string => raw },
  "receipt-identities": { kind: "value", coerce: (raw: string): string => raw },
  repo: { kind: "value", aliases: ["R"], coerce: (raw: string): string => raw },
  root: { kind: "value", coerce: (raw: string): string => raw },
} satisfies FlagSchema;

export type HitlCardExec = (
  args: readonly string[],
  opts?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;

type Exec = HitlCardExec;

function makeExec(cwd: string): Exec {
  const run: ExecFn = (cmd, args, opts) =>
    execTool(cmd, args, { cwd: opts?.cwd ?? cwd, maxBuffer: 32 * 1024 * 1024 });
  return (args, opts) => run(args[0]!, args.slice(1), { cwd: opts?.cwd ?? cwd });
}

function resolveRepo(cwd: string, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  return inferGitHubRepoSlug(cwd);
}

function repoArgs(repo: string): string[] {
  return repo ? ["--repo", repo] : [];
}

const ISSUE_VIEW_OPERATION = routeGithubArgs(["issue", "view"]);
const PR_VIEW_OPERATION = routeGithubArgs(["pr", "view"]);
const PR_LIST_OPERATION = routeGithubArgs(["pr", "list"]);
const PR_CHECKS_OPERATION = routeGithubArgs(["pr", "checks"]);

function repoParts(slug: string): { owner: string; repo: string } {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) {
    throw new Error(`HITL card GitHub access needs an owner/repo slug, received ${JSON.stringify(slug)}`);
  }
  return { owner: slug.slice(0, slash), repo: slug.slice(slash + 1) };
}

function readTrackerToken(): string | null {
  const envToken = (
    process.env.REDSKILLED_HOST_TOKEN ??
    process.env.GITHUB_TOKEN ??
    process.env.GH_TOKEN ??
    ""
  ).trim();
  if (envToken !== "") return envToken;
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function createHitlGithubClient(root: string): GithubClient {
  const token = readTrackerToken();
  if (token === null) throw new Error("HITL card GitHub access requires an authenticated tracker credential");
  return createGithubClient({
    token,
    attribution: createGithubAttributionLedger({ path: join(stateDir(root), "github", "spend.toonl") }),
  });
}

async function readSingleObject(
  client: GithubClient,
  kind: "issue" | "pr",
  repo: string,
  number: number,
  fields: readonly string[],
): Promise<Record<string, unknown>> {
  const plan = planGithubRestRead({ kind, number, fields, repo });
  if (plan.outcome !== "plan") throw new Error(plan.reason);
  const parts = repoParts(repo);
  const pull = kind === "pr";
  const answer = await client.conditionalRest<unknown>({
    cacheKey: `hitl-card:${kind}:${repo}:${number}:${fields.join(",")}`,
    route: pull
      ? "GET /repos/{owner}/{repo}/pulls/{pull_number}"
      : "GET /repos/{owner}/{repo}/issues/{issue_number}",
    parameters: { ...parts, ...(pull ? { pull_number: number } : { issue_number: number }) },
    operation: pull ? PR_VIEW_OPERATION : ISSUE_VIEW_OPERATION,
    actor: "hitl-card",
  });
  return plan.decode(JSON.stringify(answer.data));
}

async function runWrite(exec: Exec, plan: GithubWritePlan): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec([...plan.args]);
}

interface IssueData {
  number: number;
  title: string;
  url: string;
  body: string;
  labels: string[];
  comments: Array<{ id: number; body: string; databaseId?: number; createdAt?: string }>;
}

async function fetchIssue(client: GithubClient, repo: string, issue: number): Promise<IssueData> {
  const parts = repoParts(repo);
  const [raw, commentsAnswer] = await Promise.all([
    readSingleObject(client, "issue", repo, issue, ["number", "title", "url", "body", "labels"]),
    client.conditionalRest<Array<{ id?: number; body?: string; created_at?: string }>>({
      cacheKey: `hitl-card:issue-comments:${repo}:${issue}`,
      route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      parameters: { ...parts, issue_number: issue, per_page: 100 },
      operation: ISSUE_VIEW_OPERATION,
      actor: "hitl-card",
    }),
  ]) as [Record<string, unknown> & {
    number?: number;
    title?: string;
    url?: string;
    body?: string;
    labels?: Array<{ name?: string }>;
  }, { data: Array<{ id?: number; body?: string; created_at?: string }> }];
  return {
    number: Number(raw.number ?? issue),
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    body: String(raw.body ?? ""),
    labels: (raw.labels ?? []).map((l) => String(l.name ?? "")).filter(Boolean),
    comments: commentsAnswer.data.map((c) => ({
      id: Number(c.id ?? 0),
      databaseId: c.id,
      body: String(c.body ?? ""),
      createdAt: c.created_at ? String(c.created_at) : undefined,
    })),
  };
}

async function fetchActionComments(
  client: GithubClient,
  repo: string,
  issue: number,
): Promise<HitlCardActionComment[]> {
  const answer = await client.conditionalPaginate<{
      body?: string;
      created_at?: string;
      user?: { login?: string; type?: string };
  }>({
    cacheKey: `hitl-card:action-comments:${repo}:${issue}`,
    route: "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    parameters: { ...repoParts(repo), issue_number: issue },
    operation: ISSUE_VIEW_OPERATION,
    actor: "hitl-card",
  });
  return answer.data.map((comment) => {
    return {
      body: String(comment.body ?? ""),
      createdAt: comment.created_at ? String(comment.created_at) : undefined,
      author: comment.user?.login ? String(comment.user.login) : undefined,
      authorType: comment.user?.type ? String(comment.user.type) : undefined,
    };
  });
}

function parseLoginList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((login) => login.trim().replace(/^@/, ""))
    .filter(Boolean);
}

function parseActorIdentities(raw: string | undefined): HitlCardActorIdentity[] {
  return (raw ?? "").split(",").flatMap((entry) => {
    const separator = entry.lastIndexOf(":");
    if (separator <= 0) return [];
    const login = entry.slice(0, separator).trim();
    const type = entry.slice(separator + 1).trim();
    return login && type ? [{ login, type }] : [];
  });
}

async function fetchIssueReference(client: GithubClient, repo: string, issue: number): Promise<{ number: number; title?: string; url?: string } | undefined> {
  try {
    const raw = await readSingleObject(client, "issue", repo, issue, ["number", "title", "url"]);
    return { number: Number(raw.number ?? issue), title: String(raw.title ?? ""), url: String(raw.url ?? "") };
  } catch {
    return undefined;
  }
}

async function fetchPrStatus(client: GithubClient, repo: string, prNumber: number): Promise<PrStatus> {
  try {
    const raw = await readSingleObject(client, "pr", repo, prNumber, ["number", "mergeable", "headRefOid"]);
    const headRefOid = String(raw.headRefOid ?? "");
    const parts = repoParts(repo);
    const [checksAnswer, statusesAnswer] = headRefOid === "" ? [{ data: { check_runs: [] } }, { data: { statuses: [] } }] : await Promise.all([
      client.conditionalRest<{ check_runs?: Array<{ conclusion?: string | null; status?: string | null }> }>({
        cacheKey: `hitl-card:checks:${repo}:${headRefOid}`,
        route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
        parameters: { ...parts, ref: headRefOid, per_page: 100 },
        operation: PR_CHECKS_OPERATION,
        actor: "hitl-card",
      }),
      client.conditionalRest<{ statuses?: Array<{ state?: string | null }> }>({
        cacheKey: `hitl-card:statuses:${repo}:${headRefOid}`,
        route: "GET /repos/{owner}/{repo}/commits/{ref}/status",
        parameters: { ...parts, ref: headRefOid, per_page: 100 },
        operation: PR_CHECKS_OPERATION,
        actor: "hitl-card",
      }),
    ]);
    const checks = [
      ...(checksAnswer.data.check_runs ?? []),
      ...(statusesAnswer.data.statuses ?? []),
    ];
    const ciResult = parseCiChecks(checks);
    return {
      number: prNumber,
      ...ciResult,
      mergeability: raw.mergeable === "MERGEABLE" ? "MERGEABLE"
        : raw.mergeable === "CONFLICTING" ? "CONFLICTING"
        : "UNKNOWN",
      headSha: headRefOid ? headRefOid.slice(0, 7) : undefined,
    };
  } catch {
    return { number: prNumber, ci: "none", ciPassed: 0, ciTotal: 0, mergeability: "UNKNOWN" };
  }
}

async function findLinkedPr(client: GithubClient, repo: string, issueNumber: number, blockerRef?: string): Promise<number | undefined> {
  if (blockerRef) {
    const n = Number.parseInt(blockerRef, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  // Fallback: search open PRs that mention this issue.
  const answer = await client.conditionalRest<Array<{ number: number; body: string | null; title: string }>>({
    cacheKey: `hitl-card:open-prs:${repo}`,
    route: "GET /repos/{owner}/{repo}/pulls",
    parameters: { ...repoParts(repo), state: "open", per_page: 50 },
    operation: PR_LIST_OPERATION,
    actor: "hitl-card",
  });
  const prs = answer.data;
  const pattern = new RegExp(`(?:Refs?|Closes?|Fixes?|Resolves?)\\s+#${issueNumber}\\b`, "i");
  const match = prs.find((pr) => pattern.test(pr.body ?? "") || pattern.test(pr.title ?? ""));
  return match?.number;
}

function findCardComment(comments: IssueData["comments"]): { id: number; databaseId?: number; body: string } | undefined {
  return comments.find((c) => isHitlCard(c.body));
}

async function upsertCardComment(exec: Exec, repo: string, issueNumber: number, card: string, existing: { databaseId?: number } | undefined): Promise<void> {
  if (existing?.databaseId) {
    // Update existing comment via gh API.
    await runWrite(exec, planGithubWrite([
      "gh", "api",
      `repos/{owner}/{repo}/issues/comments/${existing.databaseId}`,
      "--method", "PATCH",
      "--field", `body=${scrubOutbound(card)}`,
      ...repoArgs(repo),
    ]));
  } else {
    await runWrite(exec, planGithubWrite([
      "gh", "issue", "comment", String(issueNumber), ...repoArgs(repo), "--body", scrubOutbound(card),
    ]));
  }
}

function nowUtc(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * Apply the per-issue action backstop. Returns true when the caller must stop.
 * Kept at the command boundary so the regression test covers the observable
 * one-comment stand-down behavior as well as the pure rolling-window count.
 */
export async function enforceHitlCardActionRate(
  exec: HitlCardExec,
  repo: string,
  issueNumber: number,
  comments: readonly HitlCardActionComment[],
  stdout: NodeJS.WritableStream,
  now = new Date(),
  cardAuthors: readonly HitlCardActorIdentity[] = [],
): Promise<boolean> {
  const rate = evaluateHitlCardActionRate(comments, now, cardAuthors);
  if (!rate.limited) return false;

  if (rate.shouldPostStandDown) {
    const minutes = HITL_CARD_ACTION_WINDOW_MS / 60_000;
    await runWrite(exec, planGithubWrite([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body",
      scrubOutbound([
        HITL_CARD_STAND_DOWN_MARKER,
        `🤖 HITL card loop suspected: ${HITL_CARD_ACTION_LIMIT} actions already ran in ${minutes} minutes; standing down.`,
      ].join("\n")),
    ]));
  }
  stdout.write(`hitl-card act #${issueNumber}: action rate cap reached; standing down.\n`);
  return true;
}

// ---------- render ----------

async function cmdRender(
  exec: Exec,
  client: GithubClient,
  repo: string,
  issueNumber: number,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const issue = await fetchIssue(client, repo, issueNumber);
  const blocker = parseCurrentBlocker(issue.body);
  const pendingDecisionRaw = blocker?.next ?? blocker?.summary ?? "Human guidance required.";
  const pendingDecision = await enrichTicketRefs(pendingDecisionRaw, (n) => fetchIssueReference(client, repo, n));

  const prNumber = await findLinkedPr(client, repo, issueNumber, blocker?.ref);
  const prStatus: PrStatus = prNumber
    ? await fetchPrStatus(client, repo, prNumber)
    : { ci: "none", ciPassed: 0, ciTotal: 0, mergeability: "UNKNOWN" };

  const updatedAt = nowUtc();
  const card = renderCard({ issueNumber, issueTitle: issue.title, issueUrl: issue.url, pendingDecision, prStatus, updatedAt });
  const existing = findCardComment(issue.comments);
  await upsertCardComment(exec, repo, issueNumber, card, existing);

  stdout.write(`hitl-card render #${issueNumber}: card ${existing ? "updated" : "posted"}.\n`);
  return 0;
}

// ---------- refresh ----------

async function cmdRefresh(
  exec: Exec,
  client: GithubClient,
  repo: string,
  issueNumber: number,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const issue = await fetchIssue(client, repo, issueNumber);
  const existing = findCardComment(issue.comments);
  if (!existing) {
    process.stderr.write(`[afk] hitl-card refresh #${issueNumber}: no card comment found — run render first\n`);
    return 1;
  }

  const blocker = parseCurrentBlocker(issue.body);
  const prNumber = await findLinkedPr(client, repo, issueNumber, blocker?.ref);
  const prStatus: PrStatus = prNumber
    ? await fetchPrStatus(client, repo, prNumber)
    : { ci: "none", ciPassed: 0, ciTotal: 0, mergeability: "UNKNOWN" };

  const updatedAt = nowUtc();
  const updatedCard = updateCardStatus(existing.body, prStatus, updatedAt);
  if (updatedCard === existing.body) {
    stdout.write(`hitl-card refresh #${issueNumber}: status unchanged.\n`);
    return 0;
  }

  await upsertCardComment(exec, repo, issueNumber, updatedCard, existing);
  stdout.write(`hitl-card refresh #${issueNumber}: status section updated.\n`);
  return 0;
}

// ---------- act ----------

function directiveComment(action: CardCommand): string {
  const verb = action.action;
  const guidance = action.args?.trim() || "(none recorded)";
  const dispositionLine = verb === "requeue"
    ? `requeued to ready-for-agent\n\nHuman guidance:\n${guidance}`
    : verb === "reject"
    ? `rejected (PR closed without merging)\n\nReason:\n${guidance}`
    : `approved — PR merged`;
  return [
    HITL_CARD_ACTION_MARKER,
    '<details data-kind="directive">',
    `<summary>HITL card: ${verb}</summary>`,
    "",
    `Action: /${verb}`,
    "",
    `Disposition:\n${dispositionLine}`,
    "</details>",
  ].join("\n");
}

async function executeApprove(exec: Exec, client: GithubClient, repo: string, issue: IssueData, prNumber: number, waitForCi: boolean): Promise<string> {
  if (waitForCi) {
    const prStatus = await fetchPrStatus(client, repo, prNumber);
    if (prStatus.ci === "fail") return "CI checks failed — cannot approve.";
    if (prStatus.ci === "pending") return "CI checks are still pending — re-run `/approve-ci` once they complete.";
  }

  const mergeResult = await runWrite(exec, planGithubWrite([
    "gh", "pr", "merge", String(prNumber),
    ...repoArgs(repo),
    "--admin", "--merge",
  ]));
  if (mergeResult.code !== 0) {
    return `PR merge failed: ${mergeResult.stderr.trim() || mergeResult.stdout.trim()}`;
  }

  await runWrite(exec, planGithubWrite(["gh", "issue", "close", String(issue.number), ...repoArgs(repo)]));

  // NOT a state transition: the issue was just CLOSED, so it EXITS the state
  // machine and the planner (which always lands on exactly one state role)
  // cannot express this shed. Same class as the reconcile land path's
  // `landDropLabels`; the write rail is still owned by packages/github (#2663).
  const blockedLabels = blockedLabelsIn(issue.labels);
  const removeLabels = [LABEL_HUMAN, ...blockedLabels];
  const editArgs = ["gh", "issue", "edit", String(issue.number), ...repoArgs(repo)];
  for (const l of removeLabels) editArgs.push("--remove-label", l);
  await runWrite(exec, planGithubWrite(editArgs));

  return `PR #${prNumber} merged and issue #${issue.number} closed.`;
}

async function executeReject(exec: Exec, repo: string, issue: IssueData, prNumber: number, reason: string): Promise<string> {
  const closeResult = await runWrite(exec, planGithubWrite([
    "gh", "pr", "close", String(prNumber),
    ...repoArgs(repo),
    "--comment", scrubOutbound(reason ? `Rejected: ${reason}` : "Rejected by maintainer."),
  ]));
  if (closeResult.code !== 0) {
    return `PR close failed: ${closeResult.stderr.trim()}`;
  }

  // Drop ready-for-human; keep issue open for manual triage. Like the approve
  // shed above this is NOT a planner transition — a rejected card hands the
  // issue back to a maintainer with no automated next state, which is the one
  // shape the one-state-role planner cannot express (#2663).
  await runWrite(exec, planGithubWrite([
    "gh", "issue", "edit", String(issue.number), ...repoArgs(repo), "--remove-label", LABEL_HUMAN,
  ]));
  return `PR #${prNumber} closed. Issue #${issue.number} is open for manual follow-up.`;
}

async function executeRequeue(exec: Exec, repo: string, issue: IssueData, guidance: string, cwd: string): Promise<string> {
  if (!guidance) {
    return "⚠️ `/requeue` requires guidance text, e.g. `/requeue Please fix the type errors in src/foo.ts`.";
  }

  const claims = parseClaimRecords(issue.comments.map((comment) => ({
    id: comment.id,
    body: comment.body,
  })));
  const latestClaims = new Map<string, { id: number; kind: "claim" | "concede" }>();
  for (const claim of claims) {
    const prior = latestClaims.get(claim.worker);
    if (!prior || claim.commentId >= prior.id) {
      latestClaims.set(claim.worker, { id: claim.commentId, kind: claim.kind });
    }
  }

  const run = async (args: string[]): Promise<void> => {
    const result = await exec(args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim());
  };
  const applied = await applyRequeue(
    {
      verifyBaseFreshness: (body) => verifyFreshBase(cwd, body),
      releaseClaims: async (number) => {
        const owners = [...latestClaims.entries()]
          .filter(([, claim]) => claim.kind === "claim")
          .map(([worker]) => worker)
          .sort();
        for (const worker of owners) {
          await run([...planGithubWrite([
            "gh", "issue", "comment", String(number), ...repoArgs(repo),
            "--body", renderClaimComment({ worker }, "concede"),
          ]).args]);
        }
        return owners;
      },
      editBody: (number, body) => run([...planGithubWrite([
        "gh", "issue", "edit", String(number), ...repoArgs(repo),
        "--body", scrubOutbound(body),
      ]).args]),
      comment: (number, body) => run([...planGithubWrite([
        "gh", "issue", "comment", String(number), ...repoArgs(repo),
        "--body", scrubOutbound(body),
      ]).args]),
      editLabels: (number, remove, add) => {
        const args = ["gh", "issue", "edit", String(number), ...repoArgs(repo)];
        for (const label of remove) args.push("--remove-label", label);
        for (const label of add) args.push("--add-label", label);
        return run([...planGithubWrite(args).args]);
      },
    },
    {
      issue: issue.number,
      authority: "human",
      body: issue.body,
      labels: issue.labels,
      guidance,
    },
  );
  if (!applied.applied) return `Cannot requeue: ${applied.reason}`;

  return `Issue #${issue.number} requeued to ready-for-agent with guidance.`;
}

export async function cmdAct(
  exec: Exec,
  repo: string,
  issueNumber: number,
  commentBody: string,
  commentAuthor: string | undefined,
  commentAuthorType: string | undefined,
  allowedAuthors: readonly string[],
  receiptIdentities: readonly HitlCardActorIdentity[],
  cwd: string,
  stdout: NodeJS.WritableStream,
  githubClient?: GithubClient,
): Promise<number> {
  // 0. Refuse automation before trust resolution or intent parsing. A PAT can
  // make workflow comments look human, so type/login and marker checks are all
  // required layers rather than interchangeable heuristics.
  if (shouldIgnoreHitlCardComment({
    author: commentAuthor,
    authorType: commentAuthorType,
    body: commentBody,
    allowedAuthors,
  })) {
    stdout.write(`hitl-card act #${issueNumber}: ignored automation-authored comment.\n`);
    return 0;
  }

  // 1. Trust-check the author.
  const config = loadConfig(resolveConfigPath(cwd), { warn: () => undefined });
  const policy = parseTrustPolicy(config);
  const ghCtx: GhContext = { cwd, repo };
  const trust = await resolveActorTrust(policy, commentAuthor, (login) => actorTrustSignals(ghCtx, login));
  if (!trust.executable) {
    await runWrite(exec, planGithubWrite([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body", scrubOutbound(`⛔ Action denied: ${trust.reason ?? "you are not a trusted maintainer"}.`),
    ]));
    process.stderr.write(`[afk] hitl-card act #${issueNumber}: trust refused — ${trust.reason}\n`);
    return 1;
  }

  // 2. Parse the command (injection-safe: only comment body, never issue body).
  let command = parseCardCommand(commentBody);
  if (!command) command = classifyNaturalLanguage(commentBody);
  if (!command) {
    await runWrite(exec, planGithubWrite([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body",
      scrubOutbound("🤖 I couldn't identify your intent. Use `/approve`, `/approve-ci`, `/reject [reason]`, or `/requeue <guidance>`."),
    ]));
    stdout.write(`hitl-card act #${issueNumber}: unrecognised command (NL classification returned nothing).\n`);
    return 0;
  }

  // 3. Fetch issue state and find linked PR.
  const client = githubClient ?? createHitlGithubClient(cwd);
  const [issue, actionComments] = await Promise.all([
    fetchIssue(client, repo, issueNumber),
    fetchActionComments(client, repo, issueNumber),
  ]);
  if (await enforceHitlCardActionRate(
    exec,
    repo,
    issueNumber,
    actionComments,
    stdout,
    new Date(),
    receiptIdentities,
  )) return 0;

  const blocker = parseCurrentBlocker(issue.body);
  const prNumber = await findLinkedPr(client, repo, issueNumber, blocker?.ref);

  if ((command.action === "approve" || command.action === "approve-ci" || command.action === "reject") && !prNumber) {
    await runWrite(exec, planGithubWrite([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body",
      scrubOutbound(`⚠️ Could not find a linked PR for #${issueNumber}. Post the PR number explicitly or use \`/requeue\` to send back to the agent.`),
    ]));
    return 1;
  }

  // 4. Execute the action.
  let resultMessage: string;
  if (command.action === "approve") {
    resultMessage = await executeApprove(exec, client, repo, issue, prNumber!, false);
  } else if (command.action === "approve-ci") {
    resultMessage = await executeApprove(exec, client, repo, issue, prNumber!, true);
  } else if (command.action === "reject") {
    resultMessage = await executeReject(exec, repo, issue, prNumber!, command.args);
  } else {
    resultMessage = await executeRequeue(exec, repo, issue, command.args, cwd);
  }

  // 5. Post directive comment + result.
  await runWrite(exec, planGithubWrite([
    "gh", "issue", "comment", String(issueNumber),
    ...repoArgs(repo),
    "--body", scrubOutbound(directiveComment(command)),
  ]));
  await runWrite(exec, planGithubWrite([
    "gh", "issue", "comment", String(issueNumber),
    ...repoArgs(repo),
    "--body", scrubOutbound(`🤖 **${command.action}**: ${resultMessage}`),
  ]));

  stdout.write(`hitl-card act #${issueNumber}: executed /${command.action} — ${resultMessage}\n`);
  return 0;
}

// ---------- entrypoint ----------

/**
 * `dev hitl-card <render|refresh|act> --issue=N [--body=...] [--author=...] [--repo=R] [--root=R]`
 */
export async function hitlCardCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const subcommand = args[0];
  if (subcommand !== "render" && subcommand !== "refresh" && subcommand !== "act") {
    process.stderr.write(`[afk] hitl-card requires a subcommand: render | refresh | act\n`);
    return 2;
  }

  const { values } = parseFlags(args.slice(1), FLAG_SCHEMA);
  const issueNumber = Number(values.issue);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    process.stderr.write("[afk] hitl-card requires --issue <N>\n");
    return 2;
  }

  const root = (values.root as string | undefined)?.trim() || cwd;
  const exec = makeExec(root);
  const repo = resolveRepo(root, values.repo as string | undefined);

  try {
    if (subcommand === "render") {
      return await cmdRender(exec, createHitlGithubClient(root), repo, issueNumber, stdout);
    }
    if (subcommand === "refresh") {
      return await cmdRefresh(exec, createHitlGithubClient(root), repo, issueNumber, stdout);
    }
    // act
    const body = (values.body as string | undefined) ?? "";
    const author = (values.author as string | undefined)?.trim() || undefined;
    const authorType = (values["author-type"] as string | undefined)?.trim() || undefined;
    const allowedAuthors = parseLoginList(values["allowed-authors"] as string | undefined);
    const receiptIdentities = parseActorIdentities(values["receipt-identities"] as string | undefined);
    return await cmdAct(
      exec,
      repo,
      issueNumber,
      body,
      author,
      authorType,
      allowedAuthors,
      receiptIdentities,
      root,
      stdout,
    );
  } catch (error) {
    process.stderr.write(`[afk] hitl-card ${subcommand} failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
