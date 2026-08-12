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

function flagValue(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
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
 * - `gh -R o/r pr merge <n> --merge [--subject t]` → REST `PUT pulls/{n}/merge`
 * - `gh -R o/r pr merge <n> --merge --auto [...]`  → unchanged (GraphQL enqueue)
 * - `gh -R o/r pr create --base b --head h --title t --body y [--draft]`
 *   → REST `POST pulls`
 *
 * Any other argv passes through unchanged on the GraphQL rail the gh CLI
 * defaults to — an unrouted write is the caller's existing behavior, never a
 * silent rewrite.
 */
export function planGithubWrite(args: readonly string[]): GithubWritePlan {
  const repo = repoOf(args);
  const [group, verb] = commandPath(args);
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
  return { args, surface: "graphql" };
}
