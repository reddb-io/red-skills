import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The App pays for reads; the operator signs the work.
 *
 * A GitHub App installation exists to keep automation off a person's rate
 * limit, and it earns that by touching only the READ client. The moment its
 * credential reaches the `gh` CLI — as `GH_TOKEN`, as `GITHUB_TOKEN`, or in any
 * exec environment — every comment, label and pull request the fleet creates is
 * signed by a bot instead of the operator, and every commit pushed through it
 * is attributed to an app nobody recognises.
 *
 * The separation is currently structural: reads go through the routed client
 * (`githubReadClient`), writes go through `runGithubWrite` into `gh`, and the
 * App credential is handed only to `createGithubClient`. Structure is not a
 * guarantee, though — one convenient assignment would undo it silently, and the
 * damage would appear in a repository's history rather than in a stack trace.
 */
const GH_COMMON = join(process.cwd(), "src", "runtime", "gh", "common.ts");

describe("the App is a payer, never an author", () => {
  const source = readFileSync(GH_COMMON, "utf8");
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("never hands the App credential to the CLI that writes", () => {
    const assignments = withoutComments.match(/\b(GH_TOKEN|GITHUB_TOKEN)\b\s*[:=]/g) ?? [];
    expect(assignments, "the write path must keep the operator's own credential").toEqual([]);
  });

  it("hands the App credential to the read client and nowhere else", () => {
    const uses = [...withoutComments.matchAll(/\bapp\b\s*(?:===|!==|\)|,|\})/g)];
    expect(uses.length, "the App credential is resolved and passed, not spread around").toBeGreaterThan(0);
    // The one construction that may receive it.
    expect(withoutComments).toContain("createGithubClient({");
    expect(withoutComments).toContain("identity: githubIdentityRef({ kind: \"app\", app })");
    // The exec surface must never see it: `runGh` builds its argv and options
    // from the context alone.
    const runGh = withoutComments.slice(withoutComments.indexOf("export function runGh"));
    expect(runGh.slice(0, 400)).not.toMatch(/\bapp\b/);
  });
});
