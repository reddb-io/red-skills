// A workflow's PUSH identity is not its API identity, and only the push is what
// GitHub's anti-recursion guard watches. A workflow can hold a PAT, spend it on
// every API call, open its PR as the PAT identity, and still push as
// `github-actions[bot]` — leaving every `pull_request` run on that branch parked
// in `action_required`, waiting on a human, with every check green.
//
// This bit twice in one day. #3168 moved the PAT to the changesets action's
// `github-token` input; the PR author changed, the repair looked complete, and
// the commit stayed bot-authored, so the release train kept stopping. The second
// half is `actions/checkout`'s `token:`, which is what git actually pushes with.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WORKFLOW_DIR = join(ROOT, ".github/workflows");

/**
 * How a workflow can end up pushing a ref. `changesets/action` is here because it
 * pushes its release branch internally — a workflow that names it never spells
 * `git push` and pushes on every run regardless.
 *
 * The house release engine is here for the same reason, and its absence is why
 * this guard watched a third occurrence go by (2026-08-13). `red-release.yml`
 * force-pushes `red-release/version-pr` from inside the bundle, so it spells
 * neither `git push` nor `changesets/action`; the walker skipped the file and
 * the version branch went out as `github-actions[bot]` for two releases. Both
 * invocation shapes are matched — the vendored bundle and the pinned npx form.
 */
const PUSH_MECHANISMS = [
  /^\s*[^#]*git push/m,
  /uses:\s*changesets\/action/,
  /release\.bundle\.mjs\s+run/,
  /red-skills-release\s+run/,
];

/** A checkout `token:` that is the bot — the exact credential that parks runs. */
const BOT_TOKEN = /token:\s*\$\{\{\s*(secrets\.GITHUB_TOKEN|github\.token)\s*\}\}/;

/** A checkout step's `with:` block, or null when the step declares none. */
function checkoutBlocks(workflow: string): string[] {
  const blocks: string[] = [];
  const marker = /uses:\s*actions\/checkout@/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(workflow)) !== null) {
    // The step runs until the next list item at any indentation — enough to hold
    // its own `with:` block and nothing of its neighbour's.
    const rest = workflow.slice(match.index);
    const next = rest.search(/\n\s*- (name|uses):/);
    blocks.push(next === -1 ? rest : rest.slice(0, next));
  }
  return blocks;
}

describe("a workflow that pushes does not push as the bot (#3168)", () => {
  it("gives every pushing workflow a checkout credential that is not GITHUB_TOKEN", async () => {
    const files = (await readdir(WORKFLOW_DIR)).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length, "found no workflows — a walker that reaches nothing is green by accident")
      .toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const workflow = await readFile(join(WORKFLOW_DIR, file), "utf8");
      if (!PUSH_MECHANISMS.some((pattern) => pattern.test(workflow))) continue;

      const blocks = checkoutBlocks(workflow);
      if (blocks.length === 0) continue; // pushes without checking out: not this guard's case

      // Every checkout in a pushing workflow must state a non-bot credential.
      // An ABSENT `token:` fails the same way an explicit GITHUB_TOKEN does —
      // the default IS GITHUB_TOKEN, and silence is how this shipped twice.
      for (const block of blocks) {
        const hasToken = /token:\s*\$\{\{/.test(block);
        if (!hasToken) offenders.push(`${file}: checkout declares no token: (defaults to GITHUB_TOKEN)`);
        else if (BOT_TOKEN.test(block)) offenders.push(`${file}: checkout pushes as github-actions[bot]`);
      }
    }

    expect(
      offenders,
      `these workflows push, so their pushes land in \`action_required\` and wait on a human:\n` +
        `${offenders.join("\n")}\n\n` +
        `Give the checkout step \`token: \${{ secrets.RELEASE_PAT }}\` — the credential git pushes with.`,
    ).toEqual([]);
  });
});
