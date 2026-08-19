// pin-reader — read the branch a work item is pinned to (ADR 0008).
//
// A Spec or Ticket body may carry a canonical `branch:` line declaring the branch
// `/afk` should base its worktree on and merge back into. The inheritance chain
// is small:
//
//   1. the Ticket's own `branch:` line wins;
//   2. else the parent Spec's `branch:` line (the Ticket inherits it);
//   3. else `main` (no pin anywhere).
//
// The parsing functions are pure text predicates: no gh, no git, no network.
// `resolvePin` is an orchestration function that takes injected lookups
// (fetchIssueBody / resolveParentSpec) so the inheritance precedence stays
// unit-testable against fixed strings.

// A canonical `branch:` line: optional leading whitespace, an optional markdown
// list marker (`-`/`*` plus whitespace), the literal lowercase key `branch:`,
// whitespace, then a single non-whitespace branch token, then only optional
// trailing spaces/tabs and an optional `#…` comment before end-of-line. Prose
// like "branch: when the PR lands" never matches because trailing words
// (non-`#` content) fail the anchor; "this branch: foo" never matches because
// the key must start the line.
const BRANCH_LINE = /^[ \t]*(?:[-*][ \t]+)?branch:[ \t]+(\S+)[ \t]*(?:#.*)?$/;

// The first `Spec #<n>` reference (the `## Parent` convention from /to-tickets).
// Not anchored — it matches anywhere on a line and tolerates spaces around `#`.
const PARENT_SPEC = /Spec[ \t]*#[ \t]*(\d+)/;

export const DEFAULT_BRANCH = "main";

function stripWrapper(value: string, open: string, close: string): string {
  let result = value;
  if (result.startsWith(open)) result = result.slice(open.length);
  if (result.endsWith(close)) result = result.slice(0, result.length - close.length);
  return result;
}

/**
 * Extract the branch from the first canonical `branch:` line in `body`.
 * Returns the branch token (a single layer of wrapping backticks or matched
 * quotes stripped), or `undefined` when no canonical line is present.
 */
export function parseBranchPin(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const match = BRANCH_LINE.exec(line);
    if (!match) continue;
    let value = match[1]!;
    value = stripWrapper(value, "`", "`");
    value = stripWrapper(value, '"', '"');
    value = stripWrapper(value, "'", "'");
    if (value.length === 0) continue;
    return value;
  }
  return undefined;
}

/**
 * Extract the number from the first `Spec #<n>` reference in `body`, or
 * `undefined` when no reference is present.
 */
export function parseParentSpec(body: string): number | undefined {
  const match = PARENT_SPEC.exec(body);
  return match ? Number(match[1]) : undefined;
}

export interface ResolvePinDeps {
  /** Fetch the raw body for Ticket/Spec number `n`, or `undefined` if missing. */
  fetchIssueBody: (n: number) => Promise<string | undefined>;
  /**
   * The branch a pinless item collapses to — the configured Trunk
   * (`plugins.dev.trunk`, ADR 0083). Empty/undefined falls back to
   * `DEFAULT_BRANCH` (`main`), preserving pre-trunk behaviour.
   */
  defaultBranch?: string;
}

export interface ResolvePinInput {
  /** The raw body of the issue whose pin is being resolved. */
  issueBody: string;
}

export type ResolvePinSource = "pin" | "trunk";

export interface ResolvedPin {
  branch: string;
  source: ResolvePinSource;
}

/**
 * Apply the inheritance chain and always resolve to a branch:
 *   the Ticket's own pin, else its parent Spec's pin, else the Trunk
 *   (`deps.defaultBranch`, falling back to `main` when unset — ADR 0083).
 *
 * The parent Spec body is fetched lazily via the injected `fetchIssueBody`,
 * keyed off the Ticket body's `Spec #<n>` reference.
 */
export async function resolvePinWithSource(input: ResolvePinInput, deps: ResolvePinDeps): Promise<ResolvedPin> {
  const own = parseBranchPin(input.issueBody);
  if (own) return { branch: own, source: "pin" };

  const parent = parseParentSpec(input.issueBody);
  if (parent !== undefined) {
    const specBody = await deps.fetchIssueBody(parent);
    if (specBody !== undefined) {
      const inherited = parseBranchPin(specBody);
      if (inherited) return { branch: inherited, source: "pin" };
    }
  }

  const trunk = deps.defaultBranch?.trim();
  return { branch: trunk !== undefined && trunk.length > 0 ? trunk : DEFAULT_BRANCH, source: "trunk" };
}

export async function resolvePin(input: ResolvePinInput, deps: ResolvePinDeps): Promise<string> {
  return (await resolvePinWithSource(input, deps)).branch;
}
