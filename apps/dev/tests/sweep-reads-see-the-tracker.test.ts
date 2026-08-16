import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  listByLabel,
  listOpenPullRequests,
  listParkedMechanicalCandidates,
  listUnblockCandidates,
} from "../src/runtime/gh/sweeps.js";
import { issueComments } from "../src/runtime/gh/comments.js";
import type { GhContext } from "../src/runtime/gh/common.js";

/**
 * A sweep that cannot see the tracker must SAY SO.
 *
 * The regression these tests pin cost a working day of silence: the routed-read
 * refactor gave every sweep listing an argv carrying `--paginate --slurp … --jq
 * …`, a combination the `gh` binary refuses outright. Each caller read the
 * non-zero exit as an empty collection, so the Unblock Sweep, the close
 * cascade's dependent lookup, the parked-mechanical sweep and the handoff
 * comment read all reported "nothing found" against a full tracker — and the
 * Unblock Sweep answered `promoted: []` while two issues sat promotable.
 *
 * Two properties keep that from coming back. The rows a working read returns
 * must REACH the caller, and a failing read must be reported rather than
 * disguised as a quiet repository.
 */

function contextWith(
  paginate: (input: { route: string; parameters?: Readonly<Record<string, unknown>> }) => unknown,
): GhContext {
  return {
    repo: "reddb-io/red-skills",
    cwd: "/nowhere",
    github: {
      conditionalPaginate: async (request: {
        route: string;
        parameters?: Readonly<Record<string, unknown>>;
      }) => {
        const data = paginate(request);
        if (data instanceof Error) throw data;
        return { data, headers: {}, quotaFree: false, requestCount: 1 } as never;
      },
      conditionalRest: async () => {
        throw new Error("these sweeps paginate; a single read is the wrong route");
      },
    },
  } as unknown as GhContext;
}

describe("a sweep read reaches the tracker", () => {
  it("hands the unblock planner the candidates the tracker actually holds", async () => {
    const ctx = contextWith(() => [
      { number: 3629, body: "", labels: [{ name: "blocked:dependency" }, { name: "req:3628" }] },
      { number: 3507, body: "", labels: [{ name: "blocked:dependency" }, { name: "req:3503" }] },
      // A pull request shares the issues collection and must not be swept.
      { number: 3795, body: "", labels: [], pull_request: { url: "…" } },
    ]);

    const read = await listUnblockCandidates(ctx);
    expect(read.outcome).toBe("rows");
    if (read.outcome !== "rows") throw new Error("candidate read unexpectedly failed");
    const candidates = read.rows;

    expect(candidates.map((c) => c.number)).toEqual([3629, 3507]);
    expect(candidates[0]?.labels).toContain("req:3628");
  });

  it("asks for the dependency label, not for every open issue", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const ctx = contextWith((request) => {
      seen.push({ ...request.parameters });
      return [];
    });

    await listUnblockCandidates(ctx);

    expect(seen[0]?.labels).toBe("blocked:dependency");
    expect(seen[0]?.state).toBe("open");
  });

  it("carries the close cascade's dependent lookup", async () => {
    const ctx = contextWith(() => [{ number: 3630, labels: [{ name: "req:3629" }] }]);
    expect(await listByLabel(ctx, "req:3629")).toEqual([{ number: 3630, labels: ["req:3629"] }]);
  });

  it("carries the parked mechanical candidates, de-duplicated across labels", async () => {
    const ctx = contextWith(() => [{ number: 42, title: "t", body: "b", labels: [] }]);
    const parked = await listParkedMechanicalCandidates(ctx);
    expect(parked.map((c) => c.number)).toEqual([42]);
  });

  it("projects an open pull request from its REST head ref", async () => {
    const ctx = contextWith(() => [{ number: 7, head: { ref: "afk/7-thing" }, body: "Closes #6" }]);
    expect(await listOpenPullRequests(ctx)).toEqual([
      { number: 7, headRefName: "afk/7-thing", body: "Closes #6" },
    ]);
  });

  it("delivers the Directive comments that carry human guidance", async () => {
    const ctx = contextWith(() => [
      {
        body: "<details data-kind=\"directive\">…</details>",
        user: { login: "filipeforattini", type: "User" },
        author_association: "OWNER",
        created_at: "2026-08-13T00:00:00Z",
      },
    ]);

    const comments = await issueComments(ctx, 3773);

    expect(comments).toHaveLength(1);
    expect(comments[0]?.body).toContain("data-kind=\"directive\"");
    expect(comments[0]?.author).toBe("filipeforattini");
  });
});

describe("a failed sweep read is named, never disguised as an empty tracker", () => {
  const cases: Array<[string, (ctx: GhContext) => Promise<unknown>]> = [
    ["dependent lookup", (ctx) => listByLabel(ctx, "req:1")],
    ["parked candidates", (ctx) => listParkedMechanicalCandidates(ctx)],
    ["open pull requests", (ctx) => listOpenPullRequests(ctx)],
    ["issue comments", (ctx) => issueComments(ctx, 1)],
  ];

  it("returns the typed failure behind the unblock candidate listing", async () => {
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const ctx = contextWith(() => new Error("HttpError: 503 Service Unavailable"));

    try {
      const read = await listUnblockCandidates(ctx);
      expect(read).toMatchObject({
        outcome: "failed",
        failure: { surface: "rest", classification: "transport" },
      });
      expect(written.join("")).toContain("503 Service Unavailable");
    } finally {
      stderr.mockRestore();
    }
  });

  for (const [name, read] of cases) {
    it(`reports the failure behind ${name} while still answering conservatively`, async () => {
      const written: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
      const ctx = contextWith(() => new Error("HttpError: 503 Service Unavailable"));

      try {
        // The empty answer is deliberate: a sweep blind to the tracker promotes
        // nothing. Only the SILENCE was the defect.
        expect(await read(ctx)).toEqual([]);
        expect(written.join("")).toContain("503 Service Unavailable");
      } finally {
        stderr.mockRestore();
      }
    });
  }
});

describe("no GitHub read argv pairs --slurp with --jq", () => {
  // The planner shapes the REQUEST and cannot know which flag combinations the
  // installed `gh` rejects, so the incompatibility is pinned here instead. `gh`
  // answers `the --slurp option is not supported with --jq or --template` and
  // exits non-zero; every caller reads that as an empty collection.
  const ROOTS = ["apps", "packages"];
  const REPO = join(import.meta.dirname, "..", "..", "..");

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sourceFiles(path, out);
      else if (entry.endsWith(".ts") || entry.endsWith(".mts")) out.push(path);
    }
    return out;
  }

  it("finds no source that builds the refused combination", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFiles(join(REPO, root))) {
        const source = readFileSync(file, "utf8");
        for (const [index, line] of source.split("\n").entries()) {
          // A rejection list naming the flags is the opposite of building one.
          if (!line.includes('"--slurp"')) continue;
          if (/\.includes\(|\bincludes\b\s*\(/.test(line)) continue;
          const window = source.split("\n").slice(index, index + 6).join("\n");
          if (window.includes('"--jq"')) {
            offenders.push(`${file.slice(REPO.length + 1)}:${index + 1}`);
          }
        }
      }
    }
    expect(
      offenders,
      `gh refuses --slurp beside --jq; these argv builders would exit non-zero and read as empty:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
