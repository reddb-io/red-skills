import type { SelectionFilter } from "../../core/session.js";
import { LABEL_GO_LANE, LABEL_SCOUT_LANE } from "../../core/triage-labels.js";
import { scrubOutbound } from "../../runtime/outbound-redaction.js";

export interface DisposableDispatchCleanupDeps {
  comment(issue: number, body: string): Promise<void>;
  close(issue: number): Promise<void>;
}

export interface DisposableDispatchBootFailure {
  declaredLane: string;
  consultedQueue: string;
  filter: SelectionFilter;
  failureType: "boot-error" | "session-error";
  failureReason?: string;
  retainedDiagnostic?: {
    /** Repo-relative path safe to publish in the Ticket comment. */
    path: string;
    retentionDays: number;
  };
}

export type DisposableDispatchCleanupResult =
  | { action: "not-disposable" }
  | { action: "closed"; issue: number; commentFailed?: true };

type DisposableDispatchContext = Omit<
  DisposableDispatchBootFailure,
  "failureType" | "retainedDiagnostic"
>;

export function createDisposableBootFailureCleanup(
  deps: DisposableDispatchCleanupDeps,
  context: DisposableDispatchContext,
  reportFailure: (error: unknown) => void,
): (
  failureType: DisposableDispatchBootFailure["failureType"],
  retainedDiagnostic?: DisposableDispatchBootFailure["retainedDiagnostic"],
  failureReason?: string,
) => Promise<void> {
  return async (failureType, retainedDiagnostic, failureReason) => {
    try {
      await cleanupDisposableDispatchOnBootFailure(deps, {
        ...context,
        failureType,
        ...(failureReason === undefined ? {} : { failureReason }),
        ...(retainedDiagnostic === undefined ? {} : { retainedDiagnostic }),
      });
    } catch (error) {
      reportFailure(error);
    }
  };
}

function publishableDiagnostic(
  diagnostic: DisposableDispatchBootFailure["retainedDiagnostic"],
): NonNullable<DisposableDispatchBootFailure["retainedDiagnostic"]> | undefined {
  if (diagnostic === undefined) return undefined;
  if (!/^\.red\/tmp\/diagnostics\/[A-Za-z0-9._-]+$/.test(diagnostic.path)) return undefined;
  if (!Number.isSafeInteger(diagnostic.retentionDays) || diagnostic.retentionDays < 1) return undefined;
  return diagnostic;
}

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
 * The public comment carries routing facts, a generic failure class, and only
 * the validated repository-relative path of a bounded retained diagnosis.
 */
export async function cleanupDisposableDispatchOnBootFailure(
  deps: DisposableDispatchCleanupDeps,
  input: DisposableDispatchBootFailure,
): Promise<DisposableDispatchCleanupResult> {
  const issue = disposableTarget(input);
  if (issue === undefined) return { action: "not-disposable" };

  let commentFailed = false;
  const diagnostic = publishableDiagnostic(input.retainedDiagnostic);
  const diagnosticLine = diagnostic === undefined
    ? "No local diagnostics were retained for this pre-lane failure."
    : `Detailed diagnostics: \`${diagnostic.path}\` (retained for ${diagnostic.retentionDays} days).`;
  const failureReason = input.failureReason === undefined
    ? undefined
    : scrubOutbound(input.failureReason)
        .replace(/[\r\n]+/g, " ")
        .replace(/`/g, "'")
        .trim()
        .slice(0, 500);
  try {
    await deps.comment(
      issue,
      [
        "🤖 This disposable dispatch was marked failed and closed automatically because it failed during Worker boot before processing began.",
        "",
        `- declared lane: \`${input.declaredLane}\``,
        `- consulted queue: \`${input.consultedQueue}\``,
        `- failure class: \`${input.failureType}\``,
        ...(failureReason ? [`- refusal reason: \`${failureReason}\``] : []),
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
