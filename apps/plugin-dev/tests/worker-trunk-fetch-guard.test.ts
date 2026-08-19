// ADR 0138's skew window is over: the daemon grants the exact fork point and
// the Worker holds no port or command that can fetch the Trunk for itself.
// Keep the extinct surface extinct, including a future file added beside the
// former implementation rather than only the files that existed at deletion.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "../src/core/extinct-source-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
// #4031 deleted `commands/run` with the dev CLI; the Worker body it held moved
// to @reddb-io/worker. What remains under `apps/plugin-dev` that a Worker still reaches
// is process-issue, so that is what this guard sweeps — the rule (ADR 0138: the
// Worker never fetches the Trunk) is unchanged, only the surface it can hide in.
// The Worker body moved: `process-issue` was the dev CLI's engine and is
// deleted (#4031), so the rule — ADR 0138: the Worker cannot fetch the Trunk —
// is swept where the body lives now.
const WORKER_FETCH_ROOTS = ["packages/worker/src/acp"] as const;
// The policy module is the REFUSAL, not a reach: it has to spell `fetch` to
// deny it, exactly as every other inventory in this repo spells what it bans.
const POLICY_FILE = "terminal-policy.ts";
const WORKER_TRUNK_FETCH = /\b(?:fetchBase|resolveFreshBase)\b|\[\s*["']fetch["']/g;

interface Finding {
  readonly offender: string;
  readonly match: string;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

function findingsInSource(path: string, source: string): Finding[] {
  const stripped = stripComments(source);
  return [...stripped.matchAll(WORKER_TRUNK_FETCH)].map((match) => ({
    offender: `${path}:${stripped.slice(0, match.index).split("\n").length}`,
    match: match[0],
  }));
}

function workerTrunkFetchFindings(root = ROOT): Finding[] {
  return WORKER_FETCH_ROOTS.flatMap((dir) =>
    sourceFiles(join(root, dir))
      .filter((path) => !path.endsWith(POLICY_FILE))
      .flatMap((path) => findingsInSource(relative(root, path), readFileSync(path, "utf8"))),
  );
}

describe("the Worker cannot fetch the Trunk (ADR 0138, #3354)", () => {
  it("denies the fetch in the Worker's own terminal policy", async () => {
    const policy = await import("@reddb-io/worker/acp");
    const denied = (policy as { WORKER_DENIED_TERMINAL_PROGRAMS?: readonly { program: string; subcommands: readonly string[] }[] })
      .WORKER_DENIED_TERMINAL_PROGRAMS ?? [];
    const git = denied.filter((entry) => entry.program === "git").flatMap((entry) => entry.subcommands);

    // The rule is enforced where the body lives now: the refusal must SPELL the
    // subcommand, which is why the policy module is excluded from the sweep.
    expect(git).toContain("fetch");
  });

  it("finds no Worker-side trunk-fetch surface in the live tree", () => {
    const findings = workerTrunkFetchFindings();

    expect(
      findings,
      `worker-side trunk fetch reintroduced by:\n${findings.map((finding) => `${finding.offender} (${finding.match})`).join("\n")}`,
    ).toEqual([]);
  });

  it("names the offending file and line when the extinct surface returns", () => {
    expect(findingsInSource("packages/worker/src/acp/new-worker.ts", "\n\nawait git.fetchBase(trunk);\n"))
      .toEqual([{ offender: "packages/worker/src/acp/new-worker.ts:3", match: "fetchBase" }]);
  });
});
