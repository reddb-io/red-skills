import type { SelectionFilter } from "../../core/session.js";
import { LABEL_GO_LANE, LABEL_SCOUT_LANE } from "../../core/triage-labels.js";

export interface DisposableDispatchCleanupDeps {
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
}

export interface DisposableDispatchBootFailure {
  declaredLane: string;
  consultedQueue: string;
  filter: SelectionFilter;
  failureType: "boot-error" | "session-error";
  retainedDiagnostic?: {
    /** Repo-relative path safe to publish in the Ticket comment. */
    path: string;
    retentionDays: number;
  };
}

export type DisposableDispatchCleanupResult =
  | { action: "not-disposable" }
  | { action: "closed"; issue: number; commentFailed?: true };

function disposableTarget(input: DisposableDispatchBootFailure): number | undefined {
  if (input.declaredLane !== LABEL_GO_LANE && input.declaredLane !== LABEL_SCOUT_LANE) {
    return undefined;
  }
  if (input.filter.kind !== "issues" || input.filter.numbers.length !== 1) return undefined;
  return input.filter.numbers[0];
}

/**
 * Close a disposable dispatch Ticket when its Worker dies before processing it.
 *
 * The public comment deliberately carries only routing facts and a generic
 * failure class. The detailed exception stays in the local Worker error lane,
 * where hostnames and filesystem paths cannot leak into the Issue tracker.
 */
export async function cleanupDisposableDispatchOnBootFailure(
  deps: DisposableDispatchCleanupDeps,
  input: DisposableDispatchBootFailure,
): Promise<DisposableDispatchCleanupResult> {
  const issue = disposableTarget(input);
  if (issue === undefined) return { action: "not-disposable" };

  let commentFailed = false;
  const diagnostic = input.retainedDiagnostic;
  const diagnosticLine = diagnostic === undefined
    ? "No local diagnostics were retained for this pre-lane failure."
    : `Detailed diagnostics: \`${diagnostic.path}\` (retained for ${diagnostic.retentionDays} days).`;
  try {
    await deps.comment(
      issue,
      [
        "🤖 This disposable dispatch was closed automatically because it failed during Worker boot before processing began.",
        "",
        `- declared lane: \`${input.declaredLane}\``,
        `- consulted queue: \`${input.consultedQueue}\``,
        `- failure class: \`${input.failureType}\``,
        "",
        diagnosticLine,
      ].join("\n"),
    );
  } catch {
    // Closing prevents tracker litter and outranks the explanatory comment.
    commentFailed = true;
  }
  await deps.close(issue);
  return commentFailed
    ? { action: "closed", issue, commentFailed: true }
    : { action: "closed", issue };
}
