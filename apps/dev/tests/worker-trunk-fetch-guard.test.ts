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
// to @reddb-io/worker. What remains under `apps/dev` that a Worker still reaches
// is process-issue, so that is what this guard sweeps — the rule (ADR 0138: the
// Worker never fetches the Trunk) is unchanged, only the surface it can hide in.
const WORKER_FETCH_ROOTS = ["apps/dev/src/core/process-issue"] as const;
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
    sourceFiles(join(root, dir)).flatMap((path) =>
      findingsInSource(relative(root, path), readFileSync(path, "utf8")),
    ),
  );
}

describe("the Worker cannot fetch the Trunk (ADR 0138, #3354)", () => {
  it("finds no Worker-side trunk-fetch surface in the live tree", () => {
    const findings = workerTrunkFetchFindings();

    expect(
      findings,
      `worker-side trunk fetch reintroduced by:\n${findings.map((finding) => `${finding.offender} (${finding.match})`).join("\n")}`,
    ).toEqual([]);
  });

  it("names the offending file and line when the extinct surface returns", () => {
    expect(findingsInSource("apps/dev/src/core/process-issue/new-worker.ts", "\n\nawait git.fetchBase(trunk);\n"))
      .toEqual([{ offender: "apps/dev/src/core/process-issue/new-worker.ts:3", match: "fetchBase" }]);
  });
});
