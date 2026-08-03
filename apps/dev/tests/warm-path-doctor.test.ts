// The warm path is the INSTALLED plugin's fetcher, and nothing ever asked it
// what it knows how to warm. On the reporting host it was nine releases back,
// still answering `["rsp"]`, so the daemon bundle was fetched by nothing and
// every version number on screen was true about the other lane (#3153).
import { describe, expect, it } from "vitest";
import {
  judgeWarmPath,
  readWarmPathFacts,
  warmPathUpdateRecipe,
} from "../src/core/warm-path-doctor.js";

describe("judgeWarmPath", () => {
  it("names the companion nothing on this host will fetch", () => {
    const report = judgeWarmPath({
      fetcherVersion: "3.3.9",
      companions: [
        { plugin: "rsp", warmed: true },
        { plugin: "redskilled", warmed: false },
      ],
    });

    expect(report.verdict).toBe("companion-gap");
    expect(report.unwarmed).toEqual(["redskilled"]);
    expect(report.detail).toContain("3.3.9");
    expect(report.detail).toContain("redskilled");
    // The fix must name the PLUGIN lane: the bundle lane is the one that works,
    // and it is the lane that cannot carry a fix to the fetcher.
    expect(report.fix).toBe(warmPathUpdateRecipe());
    expect(report.fix).toContain("marketplace");
  });

  it("is complete when the fetcher names every companion", () => {
    const report = judgeWarmPath({
      fetcherVersion: "3.3.19",
      companions: [
        { plugin: "rsp", warmed: true },
        { plugin: "redskilled", warmed: true },
      ],
    });

    expect(report.verdict).toBe("complete");
    expect(report.unwarmed).toEqual([]);
    expect(report.fix).toBeNull();
  });

  it("reports an unreadable warm path as unknown, never as complete", () => {
    const report = judgeWarmPath({ fetcherVersion: null, companions: [] });

    // Certifying a host whose fetcher could not even be located is the
    // inconclusive-read-as-negative confusion this repo keeps paying for.
    expect(report.verdict).toBe("unknown");
    expect(report.detail).toContain("unknown is not complete");
    expect(report.fix).toBeNull();
  });
});

describe("readWarmPathFacts", () => {
  const installed: Record<string, string> = {
    // The nine-release-old fetcher, verbatim in the shape that matters: it
    // knows `rsp` and has never heard of the daemon.
    "3.3.9": 'function jt(e){return e==="dev"?["rsp"]:[]}',
    "3.3.19": 'function jt(e){return e==="dev"?["rsp","redskilled"]:[]}',
  };

  it("reads the NEWEST installed fetcher — the one the host will run", async () => {
    const facts = await readWarmPathFacts({
      homedir: () => "/home/op",
      async readdir(path) {
        expect(path).toBe("/home/op/.claude/plugins/cache/red-skills/dev");
        return ["3.3.9", "3.3.19", "3.3.10", "not-a-version"];
      },
      async readFile(path) {
        const version = path.split("/").at(-3)!;
        const body = installed[version];
        if (body === undefined) throw new Error(`ENOENT ${path}`);
        return body;
      },
      companions: ["rsp", "redskilled"],
    });

    // 3.3.19 sorts above 3.3.10 and 3.3.9 numerically, not lexically.
    expect(facts.fetcherVersion).toBe("3.3.19");
    expect(judgeWarmPath(facts).verdict).toBe("complete");
  });

  it("falls back to the newest fetcher it can actually read", async () => {
    const facts = await readWarmPathFacts({
      homedir: () => "/home/op",
      async readdir() {
        return ["3.3.9", "3.3.20"];
      },
      async readFile(path) {
        // 3.3.20's directory exists but carries no hooks/ — a half-installed
        // version must not be read as the answer.
        if (path.includes("3.3.20")) throw new Error("ENOENT");
        return installed["3.3.9"]!;
      },
      companions: ["rsp", "redskilled"],
    });

    expect(facts.fetcherVersion).toBe("3.3.9");
    const report = judgeWarmPath(facts);
    expect(report.verdict).toBe("companion-gap");
    expect(report.unwarmed).toEqual(["redskilled"]);
  });

  it("yields unknown on a host with no plugin cache at all", async () => {
    const facts = await readWarmPathFacts({
      homedir: () => "/home/op",
      async readdir() {
        throw new Error("ENOENT");
      },
      companions: ["rsp", "redskilled"],
    });

    expect(facts.fetcherVersion).toBeNull();
    expect(judgeWarmPath(facts).verdict).toBe("unknown");
  });
});
