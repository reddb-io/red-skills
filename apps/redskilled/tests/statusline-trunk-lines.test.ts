/**
 * The two facts an idle line and a shipped-today figure rest on.
 *
 * Both are extensions of history the daemon already keeps — the repository
 * activity poll and the Worker outcome marks — so the claims here are about what
 * each one does when it CANNOT answer, which is the only way either of them can
 * lie to an operator.
 */
import { describe, expect, it } from "vitest";

import {
  fetchConditionalRepositoryActivity,
  fetchTrunkLinesToday,
} from "../src/repository-activity-conditional.js";
import { buildRepositoryActivityQuery } from "../src/repository-activity.js";
import { replayedOutcomeMark, witnessedOutcomeMark } from "../src/live-metrics.js";
import { buildLastOutcome } from "../src/statusline-last-outcome.js";

const HEADERS = {};

const answer = <T>(data: T) => ({ data, headers: HEADERS, requestCount: 1 });

const commits = (rows: readonly Record<string, unknown>[]) => async () => answer(rows);

describe("fetchTrunkLinesToday measures what landed, or says it could not", () => {
  const request = (list: unknown, object: unknown) => ({
    owner: "acme",
    repo: "widgets",
    since: "2026-08-21T00:00:00.000Z",
    list: list as never,
    object: object as never,
  });

  it("takes both ends of the day's span from ONE commit listing", async () => {
    const routes: string[] = [];
    const result = await fetchTrunkLinesToday(request(
      async (input: unknown) => {
        routes.push((input as { route: string }).route);
        return answer([
          { sha: "head", parents: [{ sha: "mid" }] },
          { sha: "first", parents: [{ sha: "yesterday" }] },
        ]);
      },
      async (input: unknown) => {
        routes.push((input as { route: string }).route);
        expect((input as { parameters: { basehead: string } }).parameters.basehead)
          .toBe("yesterday...head");
        return answer({ files: [{ additions: 12, deletions: 3 }, { additions: 400, deletions: 97 }] });
      },
    ));

    expect(result.lines).toEqual({ added: 412, removed: 100 });
    expect(routes).toEqual([
      "GET /repos/{owner}/{repo}/commits",
      "GET /repos/{owner}/{repo}/compare/{basehead}",
    ]);
  });

  it("answers a real zero for a day the trunk did not move, and spends one request", async () => {
    const result = await fetchTrunkLinesToday(request(commits([]) as never, async () => {
      throw new Error("a day with no commits needs no comparison");
    }));

    expect(result.lines).toEqual({ added: 0, removed: 0 });
    expect(result.requestCount).toBe(1);
  });

  it("states an absence, never a zero, when the comparison is truncated", async () => {
    const files = Array.from({ length: 300 }, () => ({ additions: 1, deletions: 1 }));
    const result = await fetchTrunkLinesToday(request(
      commits([{ sha: "head", parents: [{ sha: "yesterday" }] }]) as never,
      async () => answer({ files }),
    ));

    expect(result.lines).toEqual({ added: null, removed: null });
  });

  it("states an absence when the comparison carries no file list at all", async () => {
    const result = await fetchTrunkLinesToday(request(
      commits([{ sha: "head", parents: [{ sha: "yesterday" }] }]) as never,
      async () => answer({}),
    ));

    expect(result.lines).toEqual({ added: null, removed: null });
  });

  it("costs the caller nothing when the trunk is unreachable", async () => {
    const result = await fetchTrunkLinesToday(request(
      async () => {
        throw new Error("the host token cannot see acme/widgets");
      },
      async () => answer({ files: [] }),
    ));

    expect(result.lines).toEqual({ added: null, removed: null });
  });

  it("asks nothing of a transport that cannot read an object body", async () => {
    const result = await fetchTrunkLinesToday(request(
      async () => {
        throw new Error("this listing must never be reached");
      },
      undefined,
    ));

    expect(result).toEqual({ lines: { added: null, removed: null }, requestCount: 0 });
  });
});

describe("the newest Worker ending is what an idle host has left to say", () => {
  const worker = { worker_id: "w1", project_label: "red-skills" };

  it("keeps the Worker's own account of its work, read at the moment of death", () => {
    expect(witnessedOutcomeMark(
      worker,
      "2026-08-21T11:57:00.000Z",
      "worker-death",
      { issue: "#4175", phase: "land" },
      "work-reported",
    )).toEqual({
      worker_id: "w1",
      ts: "2026-08-21T11:57:00.000Z",
      outcome: "worker-death",
      project_label: "red-skills",
      issue: "#4175",
      phase: "land",
      birth_outcome: "work-reported",
    });
  });

  it("carries strictly less from a lane replay, and says so with nulls", () => {
    expect(replayedOutcomeMark({
      worker_id: "w1",
      ts: "2026-08-21T11:57:00.000Z",
      event: "worker-budget-kill",
      project_label: "red-skills",
    })).toEqual({
      worker_id: "w1",
      ts: "2026-08-21T11:57:00.000Z",
      outcome: "worker-budget-kill",
      project_label: "red-skills",
      issue: null,
      phase: null,
      birth_outcome: null,
    });
  });

  it("picks the newest by instant, not by position, so a replay cannot pass for now", () => {
    const replayed = replayedOutcomeMark({
      worker_id: "old",
      ts: "2026-08-21T09:00:00.000Z",
      event: "worker-death",
      project_label: "red-skills",
    });
    const live = witnessedOutcomeMark(
      worker,
      "2026-08-21T11:57:00.000Z",
      "worker-death",
      { issue: "#4175", phase: "land" },
      "work-reported",
    );

    expect(buildLastOutcome([live, replayed])?.ts).toBe("2026-08-21T11:57:00.000Z");
  });

  it("has nothing to say on a host that has ended no Worker", () => {
    expect(buildLastOutcome([])).toBeNull();
    expect(buildLastOutcome(undefined)).toBeNull();
  });

  it("refuses an ending it cannot date, because an undated one has no age to print", () => {
    expect(buildLastOutcome([replayedOutcomeMark({
      worker_id: "w1",
      ts: "not-an-instant",
      event: "worker-death",
      project_label: "red-skills",
    })])).toBeNull();
  });
});

describe("fetchConditionalRepositoryActivity carries the day's lines with the panorama", () => {
  const project = { project_label: "acme/widgets", owner: "acme", name: "widgets" };
  const NOW = "2026-08-21T12:00:00.000Z";

  const transport = (
    compare: Record<string, unknown>,
  ): never => {
    const base = (async () => {
      throw new Error("this poll never issues GraphQL");
    }) as unknown as Record<string, unknown>;
    base.conditionalList = async (input: { route: string }) => {
      if (input.route === "GET /repos/{owner}/{repo}/commits") {
        return answer([{ sha: "head", parents: [{ sha: "yesterday" }] }]);
      }
      if (input.route === "GET /repos/{owner}/{repo}/pulls") return answer([{ number: 1 }, { number: 2 }]);
      return answer([]);
    };
    base.conditionalCount = async () => answer({ total_count: 61 });
    base.conditionalObject = async () => answer(compare);
    return base as never;
  };

  const poll = async (compare: Record<string, unknown>) => {
    const operation = buildRepositoryActivityQuery([project], { now: NOW });
    return await fetchConditionalRepositoryActivity(
      { projects: [project], hostTokenRef: "host", transport: transport(compare), now: NOW },
      operation,
    );
  };

  it("puts the measured lines on the same counts as the merge total", async () => {
    const activity = await poll({ files: [{ additions: 900, deletions: 40 }] });

    expect(activity.projects[0]!.counts).toMatchObject({
      merged_today: 61,
      open_pull_requests: 2,
      trunk_lines_added: 900,
      trunk_lines_removed: 40,
    });
  });

  it("keeps the panorama when only the comparison failed", async () => {
    const activity = await poll({});

    expect(activity.projects[0]!.outcome).toBe("counted");
    expect(activity.projects[0]!.counts).toMatchObject({
      merged_today: 61,
      trunk_lines_added: null,
      trunk_lines_removed: null,
    });
  });
});
