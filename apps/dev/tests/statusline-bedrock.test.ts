import { describe, expect, it } from "vitest";
import {
  composeStatuslineLines,
  renderBedrockProjectBlock,
  renderLocalDiffBlock,
  renderStatuslineBedrock,
} from "../src/core/statusline-bedrock.js";
import { resolveStatuslineBedrock } from "../src/commands/statusline.js";
import type { StatuslineLocalGit, StatuslineLocalGitDeps } from "../src/runtime/wire/statusline-git.js";

const PROJECT = { basename: "red-skills", branch: "afk/3563-bedrock", version: "3.12.13" };

const CLAUDE = {
  model: "Opus",
  effort: "high",
  contextTokens: 47_000,
  contextPercent: 24,
  usage5h: 23,
  usage7d: 41,
};

describe("statusline bedrock render", () => {
  it("renders every zero-network fact in one segment", () => {
    expect(
      renderStatuslineBedrock({
        project: PROJECT,
        claude: CLAUDE,
        localDiff: { localAdded: 142, localRemoved: 36 },
      }),
    ).toBe("red-skills (afk/3563-bedrock) v3.12.13 Opus·high ctx=47k 24% 5h=23% 7d=41% loc=+142 -36");
  });

  it("states the running version even when no newer bundle is cached", () => {
    // The header's project block shows the version only on an update; the
    // bedrock always does — "which version drew this line" is exactly the
    // question asked when the rest of the line is missing.
    expect(renderBedrockProjectBlock(PROJECT)).toBe("red-skills (afk/3563-bedrock) v3.12.13");
    expect(renderBedrockProjectBlock({ ...PROJECT, latestCachedVersion: "3.13.0" })).toBe(
      "red-skills (afk/3563-bedrock) v3.12.13*",
    );
  });

  it("keeps rendering when the stdin payload carries nothing", () => {
    expect(renderStatuslineBedrock({ project: { basename: "red-skills" } })).toBe("red-skills");
  });

  it("renders a detached head and drops a zero local diff", () => {
    expect(
      renderStatuslineBedrock({
        project: { basename: "red-skills", detachedSha: "7658ad2", version: "3.12.13" },
        localDiff: { localAdded: 0, localRemoved: 0 },
      }),
    ).toBe("red-skills (detached 7658ad2) v3.12.13");
  });

  it("emits each half of the local diff only when non-zero", () => {
    expect(renderLocalDiffBlock({ localAdded: 5, localRemoved: 0 })).toBe("loc=+5");
    expect(renderLocalDiffBlock({ localAdded: 0, localRemoved: 7 })).toBe("loc=-7");
    expect(renderLocalDiffBlock({})).toBeNull();
  });
});

describe("bedrock/tail composition", () => {
  it("leads the daemon's header line and leaves its remaining lines untouched", () => {
    expect(composeStatuslineLines("bedrock", ["header", "worker one", "worker two", ""])).toEqual([
      "bedrock · header",
      "worker one",
      "worker two",
    ]);
  });

  it("stands alone when the tail produced nothing", () => {
    expect(composeStatuslineLines("bedrock", [""])).toEqual(["bedrock"]);
    expect(composeStatuslineLines("bedrock", [])).toEqual(["bedrock"]);
  });
});

describe("bedrock input resolution", () => {
  function gitDeps(facts: StatuslineLocalGit): StatuslineLocalGitDeps {
    const files = new Map<string, string>();
    return {
      nowMs: () => 1_000,
      readCache: (path) => files.get(path) ?? null,
      writeCache: (path, text) => {
        files.set(path, text);
      },
      readGitFacts: async () => facts,
    };
  }

  it("builds the project block from the micro-TTL git facts, not from the cwd", async () => {
    const input = await resolveStatuslineBedrock(
      "/tmp/red-skills/.red/tmp/worktrees/manual/some-slug",
      { model: { display_name: "Opus" }, effort: { level: "high" } },
      gitDeps({ basename: "red-skills", branch: "main", localAdded: 4, localRemoved: 1 }),
    );

    expect(input.project.basename).toBe("red-skills");
    expect(input.project.branch).toBe("main");
    expect(input.project.version).toBeTruthy();
    expect(input.localDiff).toEqual({ localAdded: 4, localRemoved: 1 });
    expect(input.claude).toMatchObject({ model: "Opus", effort: "high" });
  });

  it("carries the stdin context and subscription windows through untouched", async () => {
    const input = await resolveStatuslineBedrock(
      "/tmp/red-skills",
      {
        context_window: { total_input_tokens: 47_000, used_percentage: 24 },
        rate_limits: { five_hour: { used_percentage: 23 }, seven_day: { used_percentage: 41 } },
      },
      gitDeps({ basename: "red-skills", localAdded: 0, localRemoved: 0 }),
    );

    expect(input.claude).toMatchObject({
      contextTokens: 47_000,
      contextPercent: 24,
      usage5h: 23,
      usage7d: 41,
    });
  });
});
