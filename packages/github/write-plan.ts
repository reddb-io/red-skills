// write-plan.ts — how a mutation is actually ISSUED, owned by the client.
//
// {@link GITHUB_OPERATIONS} declares which rail a write rides; that declaration
// is worth nothing while call sites hand-build `gh api` argv, because the next
// caller copies whichever spelling it saw last and the routing table drifts
// into prose (#3663). A call site states the CANONICAL gh CLI argv; this module
// answers the argv that actually runs and the rail it rides.
//
// **A mutation with no REST equivalent keeps its CLI form.** `pr merge --auto`
// arms native merge-queue intent through a GraphQL-only mutation — the one
// merge operation that has EARNED its rail — so the plan returns it untouched
// rather than approximating it with a PUT the branch protection would refuse.

/** A realized write: the argv to run, and the rail it rides. */
export interface GithubWritePlan {
  readonly args: readonly string[];
  readonly surface: "rest" | "graphql";
}

export interface GithubWriteContext {
  /** Complete labels currently on an issue, needed to preserve add/remove semantics. */
  readonly currentIssueLabels?: readonly string[];
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
}

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1] !== undefined) values.push(args[i + 1]!);
  }
  return values;
}

function usesOnlyValueFlags(
  args: readonly string[],
  start: number,
  allowed: ReadonlySet<string>,
): boolean {
  for (let i = start; i < args.length; i += 2) {
    if (!allowed.has(args[i]!) || args[i + 1] === undefined) return false;
  }
  return true;
}

function repoOf(args: readonly string[]): string | undefined {
  return flagValue(args, "-R") ?? flagValue(args, "--repo");
}

/** The `gh <group> <verb>` path, skipping the binary and global flags. */
function commandPath(args: readonly string[]): string[] {
  const path: string[] = [];
  for (let i = 1; i < args.length && path.length < 2; i += 1) {
    const arg = args[i]!;
    if (arg === "-R" || arg === "--repo") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    path.push(arg);
  }
  return path;
}

/**
 * Realize one canonical gh write argv on its declared rail. PURE.
 *
 * Covered spellings — exactly the ones the engine's landing emits:
 * - `gh -R o/r issue edit <n> --body b [--add-label/--remove-label ...]`
 *   → REST `PATCH issues/{n}` (label edits require the current complete set)
 * - `gh -R o/r issue close <n> --reason completed` → REST `PATCH issues/{n}`
 * - `gh -R o/r pr merge <n> --merge [--subject t]` → REST `PUT pulls/{n}/merge`
 * - `gh -R o/r pr merge <n> --merge --auto [...]`  → unchanged (GraphQL enqueue)
 * - `gh -R o/r pr create --base b --head h --title t --body y [--draft]`
 *   → REST `POST pulls`
 * - `gh -R o/r pr edit <n> --body b` → REST `PATCH pulls/{n}`
 * - `gh -R o/r pr edit <n> --add-label l` → REST `POST issues/{n}/labels`
 * - `gh -R o/r pr ready <n>` → unchanged (GraphQL-only mutation)
 * - `gh -R o/r pr update-branch <n>` → REST `PUT pulls/{n}/update-branch`
 * - `gh issue|pr comment <n> -R o/r --body y`
 *   → REST `POST issues/{n}/comments`
 * - `gh api <rest-path> --method <verb> ...`
 *   → unchanged on the explicitly selected REST rail
 *
 * Any other argv passes through unchanged on the GraphQL rail the gh CLI
 * defaults to — an unrouted write is the caller's existing behavior, never a
 * silent rewrite.
 */
export function planGithubWrite(
  args: readonly string[],
  context: GithubWriteContext = {},
): GithubWritePlan {
  const repo = repoOf(args);
  const [group, verb] = commandPath(args);
  if (repo && group === "issue" && verb === "edit") {
    const editAt = args.indexOf("edit");
    const issueNumber = args[editAt + 1];
    const body = flagValue(args, "--body");
    const removeLabels = flagValues(args, "--remove-label");
    const addLabels = flagValues(args, "--add-label");
    const editsLabels = removeLabels.length > 0 || addLabels.length > 0;
    const supported = usesOnlyValueFlags(
      args,
      editAt + 2,
      new Set(["-R", "--repo", "--body", "--remove-label", "--add-label"]),
    );
    if (
      supported
      && (body !== undefined || editsLabels)
      && issueNumber
      && /^\d+$/.test(issueNumber)
      && (!editsLabels || context.currentIssueLabels)
    ) {
      const labels = editsLabels
        ? [...new Set([
            ...context.currentIssueLabels!.filter((label) => !removeLabels.includes(label)),
            ...addLabels,
          ])]
        : undefined;
      return {
        surface: "rest",
        args: [
          "gh", "api", "-X", "PATCH", `repos/${repo}/issues/${issueNumber}`,
          ...(body !== undefined ? ["-f", `body=${body}`] : []),
          ...(labels ? labels.length > 0
            ? labels.flatMap((label) => ["-F", `labels[]=${label}`])
            : ["-F", "labels[]"] : []),
        ],
      };
    }
  }
  if (repo && group === "issue" && verb === "close") {
    const issueNumber = args[args.indexOf("close") + 1];
    if (issueNumber && /^\d+$/.test(issueNumber)) {
      const reason = flagValue(args, "--reason");
      return {
        surface: "rest",
        args: [
          "gh", "api", "-X", "PATCH", `repos/${repo}/issues/${issueNumber}`,
          "-f", "state=closed",
          ...(reason ? ["-f", `state_reason=${reason}`] : []),
        ],
      };
    }
  }
  if (repo && group === "pr" && verb === "merge") {
    if (args.includes("--auto")) return { args, surface: "graphql" };
    const prNumber = args[args.indexOf("merge") + 1];
    if (prNumber && /^\d+$/.test(prNumber)) {
      const subject = flagValue(args, "--subject");
      return {
        surface: "rest",
        args: [
          "gh", "api", "-X", "PUT", `repos/${repo}/pulls/${prNumber}/merge`,
          "-f", "merge_method=merge",
          ...(subject ? ["-f", `commit_title=${subject}`] : []),
        ],
      };
    }
  }
  if (repo && group === "pr" && verb === "create") {
    const base = flagValue(args, "--base");
    const head = flagValue(args, "--head");
    const title = flagValue(args, "--title");
    if (base && head && title !== undefined) {
      const body = flagValue(args, "--body");
      return {
        surface: "rest",
        args: [
          "gh", "api", "-X", "POST", `repos/${repo}/pulls`,
          ...(args.includes("--draft") ? ["-F", "draft=true"] : []),
          "-f", `base=${base}`,
          "-f", `head=${head}`,
          "-f", `title=${title}`,
          ...(body !== undefined ? ["-f", `body=${body}`] : []),
        ],
      };
    }
  }
  if (repo && group === "pr" && verb === "ready") return { args, surface: "graphql" };
  if (repo && group === "pr" && verb === "edit") {
    const editAt = args.indexOf("edit");
    const prNumber = args[editAt + 1];
    const body = flagValue(args, "--body");
    const addLabels = flagValues(args, "--add-label");
    const supported = usesOnlyValueFlags(args, editAt + 2, new Set(["-R", "--repo", "--body", "--add-label"]));
    if (supported && prNumber && /^\d+$/.test(prNumber) && body !== undefined && addLabels.length === 0) {
      return {
        surface: "rest",
        args: ["gh", "api", "-X", "PATCH", `repos/${repo}/pulls/${prNumber}`, "-f", `body=${body}`],
      };
    }
    if (supported && prNumber && /^\d+$/.test(prNumber) && body === undefined && addLabels.length > 0) {
      return {
        surface: "rest",
        args: [
          "gh", "api", "-X", "POST", `repos/${repo}/issues/${prNumber}/labels`,
          ...addLabels.flatMap((label) => ["-F", `labels[]=${label}`]),
        ],
      };
    }
  }
  if (repo && group === "pr" && verb === "update-branch") {
    const prNumber = args[args.indexOf("update-branch") + 1];
    if (prNumber && /^\d+$/.test(prNumber)) {
      return {
        surface: "rest",
        args: ["gh", "api", "-X", "PUT", `repos/${repo}/pulls/${prNumber}/update-branch`],
      };
    }
  }
  if (repo && (group === "issue" || group === "pr") && verb === "comment") {
    const issueNumber = args[args.indexOf("comment") + 1];
    const body = flagValue(args, "--body");
    if (issueNumber && /^\d+$/.test(issueNumber) && body !== undefined) {
      return {
        surface: "rest",
        args: [
          "gh", "api", "-X", "POST", `repos/${repo}/issues/${issueNumber}/comments`,
          "-f", `body=${body}`,
        ],
      };
    }
  }
  if (group === "api" && verb !== "graphql") return { args, surface: "rest" };
  return { args, surface: "graphql" };
}
