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

import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
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

async function resolveRepo(exec: Exec, explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit.trim();
  const r = await exec(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

function repoArgs(repo: string): string[] {
  return repo ? ["--repo", repo] : [];
}

interface IssueData {
  number: number;
  title: string;
  url: string;
  body: string;
  labels: string[];
  comments: Array<{ id: number; body: string; databaseId?: number; createdAt?: string }>;
}

async function fetchIssue(exec: Exec, repo: string, issue: number): Promise<IssueData> {
  const r = await exec([
    "gh", "issue", "view", String(issue),
    ...repoArgs(repo),
    "--json", "number,title,url,body,labels,comments",
  ]);
  if (r.code !== 0) throw new Error(`fetch issue #${issue} failed: ${r.stderr.trim()}`);
  const raw = JSON.parse(r.stdout) as {
    number?: number;
    title?: string;
    url?: string;
    body?: string;
    labels?: Array<{ name?: string }>;
    comments?: Array<{ id?: number; body?: string; databaseId?: number; createdAt?: string }>;
  };
  return {
    number: Number(raw.number ?? issue),
    title: String(raw.title ?? ""),
    url: String(raw.url ?? ""),
    body: String(raw.body ?? ""),
    labels: (raw.labels ?? []).map((l) => String(l.name ?? "")).filter(Boolean),
    comments: (raw.comments ?? []).map((c) => ({
      id: Number(c.id ?? 0),
      databaseId: c.databaseId,
      body: String(c.body ?? ""),
      createdAt: c.createdAt ? String(c.createdAt) : undefined,
    })),
  };
}

async function fetchActionComments(
  exec: Exec,
  repo: string,
  issue: number,
): Promise<HitlCardActionComment[]> {
  const repoPath = repo || "{owner}/{repo}";
  const r = await exec([
    "gh", "api",
    `repos/${repoPath}/issues/${issue}/comments?per_page=100`,
    "--paginate", "--slurp",
  ]);
  if (r.code !== 0) throw new Error(`fetch issue #${issue} comment identities failed: ${r.stderr.trim()}`);
  const parsed = JSON.parse(r.stdout) as unknown;
  const pages = Array.isArray(parsed) && parsed.every(Array.isArray)
    ? parsed.flat()
    : Array.isArray(parsed) ? parsed : [];
  return pages.map((value) => {
    const comment = value as {
      body?: string;
      created_at?: string;
      user?: { login?: string; type?: string };
    };
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

async function fetchIssueReference(exec: Exec, repo: string, issue: number): Promise<{ number: number; title?: string; url?: string } | undefined> {
  const r = await exec([
    "gh", "issue", "view", String(issue),
    ...repoArgs(repo),
    "--json", "number,title,url",
  ]);
  if (r.code !== 0) return undefined;
  try {
    const raw = JSON.parse(r.stdout) as { number?: number; title?: string; url?: string };
    return { number: Number(raw.number ?? issue), title: String(raw.title ?? ""), url: String(raw.url ?? "") };
  } catch {
    return undefined;
  }
}

async function fetchPrStatus(exec: Exec, repo: string, prNumber: number): Promise<PrStatus> {
  const r = await exec([
    "gh", "pr", "view", String(prNumber),
    ...repoArgs(repo),
    "--json", "number,mergeable,statusCheckRollup,headRefOid",
  ]);
  if (r.code !== 0) {
    return { number: prNumber, ci: "none", ciPassed: 0, ciTotal: 0, mergeability: "UNKNOWN" };
  }
  const raw = JSON.parse(r.stdout) as {
    number?: number;
    mergeable?: string;
    statusCheckRollup?: Array<{ conclusion?: string | null; state?: string | null }>;
    headRefOid?: string;
  };
  const checks = raw.statusCheckRollup ?? [];
  const ciResult = parseCiChecks(checks);
  return {
    number: prNumber,
    ...ciResult,
    mergeability: raw.mergeable === "MERGEABLE" ? "MERGEABLE"
      : raw.mergeable === "CONFLICTING" ? "CONFLICTING"
      : "UNKNOWN",
    headSha: raw.headRefOid ? raw.headRefOid.slice(0, 7) : undefined,
  };
}

async function findLinkedPr(exec: Exec, repo: string, issueNumber: number, blockerRef?: string): Promise<number | undefined> {
  if (blockerRef) {
    const n = Number.parseInt(blockerRef, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  // Fallback: search open PRs that mention this issue.
  const r = await exec([
    "gh", "pr", "list",
    ...repoArgs(repo),
    "--state", "open",
    "--json", "number,body,title",
    "--limit", "50",
  ]);
  if (r.code !== 0) return undefined;
  const prs = JSON.parse(r.stdout) as Array<{ number: number; body: string; title: string }>;
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
    await exec([
      "gh", "api",
      `repos/{owner}/{repo}/issues/comments/${existing.databaseId}`,
      "--method", "PATCH",
      "--field", `body=${scrubOutbound(card)}`,
      ...repoArgs(repo),
    ]);
  } else {
    await exec(["gh", "issue", "comment", String(issueNumber), ...repoArgs(repo), "--body", scrubOutbound(card)]);
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
    await exec([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body",
      scrubOutbound([
        HITL_CARD_STAND_DOWN_MARKER,
        `🤖 HITL card loop suspected: ${HITL_CARD_ACTION_LIMIT} actions already ran in ${minutes} minutes; standing down.`,
      ].join("\n")),
    ]);
  }
  stdout.write(`hitl-card act #${issueNumber}: action rate cap reached; standing down.\n`);
  return true;
}

// ---------- render ----------

async function cmdRender(
  exec: Exec,
  repo: string,
  issueNumber: number,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const issue = await fetchIssue(exec, repo, issueNumber);
  const blocker = parseCurrentBlocker(issue.body);
  const pendingDecisionRaw = blocker?.next ?? blocker?.summary ?? "Human guidance required.";
  const pendingDecision = await enrichTicketRefs(pendingDecisionRaw, (n) => fetchIssueReference(exec, repo, n));

  const prNumber = await findLinkedPr(exec, repo, issueNumber, blocker?.ref);
  const prStatus: PrStatus = prNumber
    ? await fetchPrStatus(exec, repo, prNumber)
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
  repo: string,
  issueNumber: number,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const issue = await fetchIssue(exec, repo, issueNumber);
  const existing = findCardComment(issue.comments);
  if (!existing) {
    process.stderr.write(`[afk] hitl-card refresh #${issueNumber}: no card comment found — run render first\n`);
    return 1;
  }

  const blocker = parseCurrentBlocker(issue.body);
  const prNumber = await findLinkedPr(exec, repo, issueNumber, blocker?.ref);
  const prStatus: PrStatus = prNumber
    ? await fetchPrStatus(exec, repo, prNumber)
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

async function executeApprove(exec: Exec, repo: string, issue: IssueData, prNumber: number, waitForCi: boolean): Promise<string> {
  if (waitForCi) {
    const prStatus = await fetchPrStatus(exec, repo, prNumber);
    if (prStatus.ci === "fail") return "CI checks failed — cannot approve.";
    if (prStatus.ci === "pending") return "CI checks are still pending — re-run `/approve-ci` once they complete.";
  }

  const mergeResult = await exec([
    "gh", "pr", "merge", String(prNumber),
    ...repoArgs(repo),
    "--admin", "--merge",
  ]);
  if (mergeResult.code !== 0) {
    return `PR merge failed: ${mergeResult.stderr.trim() || mergeResult.stdout.trim()}`;
  }

  await exec(["gh", "issue", "close", String(issue.number), ...repoArgs(repo)]);

  // NOT a state transition: the issue was just CLOSED, so it EXITS the state
  // machine and the planner (which always lands on exactly one state role)
  // cannot express this shed. Same class as the reconcile land path's
  // `landDropLabels` — deliberately left raw (#2663).
  const blockedLabels = blockedLabelsIn(issue.labels);
  const removeLabels = [LABEL_HUMAN, ...blockedLabels];
  const editArgs = ["gh", "issue", "edit", String(issue.number), ...repoArgs(repo)];
  for (const l of removeLabels) editArgs.push("--remove-label", l);
  await exec(editArgs);

  return `PR #${prNumber} merged and issue #${issue.number} closed.`;
}

async function executeReject(exec: Exec, repo: string, issue: IssueData, prNumber: number, reason: string): Promise<string> {
  const closeResult = await exec([
    "gh", "pr", "close", String(prNumber),
    ...repoArgs(repo),
    "--comment", scrubOutbound(reason ? `Rejected: ${reason}` : "Rejected by maintainer."),
  ]);
  if (closeResult.code !== 0) {
    return `PR close failed: ${closeResult.stderr.trim()}`;
  }

  // Drop ready-for-human; keep issue open for manual triage. Like the approve
  // shed above this is NOT a planner transition — a rejected card hands the
  // issue back to a maintainer with no automated next state, which is the one
  // shape the one-state-role planner cannot express (#2663).
  await exec(["gh", "issue", "edit", String(issue.number), ...repoArgs(repo), "--remove-label", LABEL_HUMAN]);
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
          await run([
            "gh", "issue", "comment", String(number), ...repoArgs(repo),
            "--body", renderClaimComment({ worker }, "concede"),
          ]);
        }
        return owners;
      },
      editBody: (number, body) => run([
        "gh", "issue", "edit", String(number), ...repoArgs(repo),
        "--body", scrubOutbound(body),
      ]),
      comment: (number, body) => run([
        "gh", "issue", "comment", String(number), ...repoArgs(repo),
        "--body", scrubOutbound(body),
      ]),
      editLabels: (number, remove, add) => {
        const args = ["gh", "issue", "edit", String(number), ...repoArgs(repo)];
        for (const label of remove) args.push("--remove-label", label);
        for (const label of add) args.push("--add-label", label);
        return run(args);
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
    await exec([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body", scrubOutbound(`⛔ Action denied: ${trust.reason ?? "you are not a trusted maintainer"}.`),
    ]);
    process.stderr.write(`[afk] hitl-card act #${issueNumber}: trust refused — ${trust.reason}\n`);
    return 1;
  }

  // 2. Parse the command (injection-safe: only comment body, never issue body).
  let command = parseCardCommand(commentBody);
  if (!command) command = classifyNaturalLanguage(commentBody);
  if (!command) {
    await exec([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body",
      scrubOutbound("🤖 I couldn't identify your intent. Use `/approve`, `/approve-ci`, `/reject [reason]`, or `/requeue <guidance>`."),
    ]);
    stdout.write(`hitl-card act #${issueNumber}: unrecognised command (NL classification returned nothing).\n`);
    return 0;
  }

  // 3. Fetch issue state and find linked PR.
  const [issue, actionComments] = await Promise.all([
    fetchIssue(exec, repo, issueNumber),
    fetchActionComments(exec, repo, issueNumber),
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
  const prNumber = await findLinkedPr(exec, repo, issueNumber, blocker?.ref);

  if ((command.action === "approve" || command.action === "approve-ci" || command.action === "reject") && !prNumber) {
    await exec([
      "gh", "issue", "comment", String(issueNumber),
      ...repoArgs(repo),
      "--body",
      scrubOutbound(`⚠️ Could not find a linked PR for #${issueNumber}. Post the PR number explicitly or use \`/requeue\` to send back to the agent.`),
    ]);
    return 1;
  }

  // 4. Execute the action.
  let resultMessage: string;
  if (command.action === "approve") {
    resultMessage = await executeApprove(exec, repo, issue, prNumber!, false);
  } else if (command.action === "approve-ci") {
    resultMessage = await executeApprove(exec, repo, issue, prNumber!, true);
  } else if (command.action === "reject") {
    resultMessage = await executeReject(exec, repo, issue, prNumber!, command.args);
  } else {
    resultMessage = await executeRequeue(exec, repo, issue, command.args, cwd);
  }

  // 5. Post directive comment + result.
  await exec([
    "gh", "issue", "comment", String(issueNumber),
    ...repoArgs(repo),
    "--body", scrubOutbound(directiveComment(command)),
  ]);
  await exec([
    "gh", "issue", "comment", String(issueNumber),
    ...repoArgs(repo),
    "--body", scrubOutbound(`🤖 **${command.action}**: ${resultMessage}`),
  ]);

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
  const repo = await resolveRepo(exec, values.repo as string | undefined);

  try {
    if (subcommand === "render") {
      return await cmdRender(exec, repo, issueNumber, stdout);
    }
    if (subcommand === "refresh") {
      return await cmdRefresh(exec, repo, issueNumber, stdout);
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
