import { describe, expect, it } from "vitest";
import type { ExecFn } from "../src/runtime/exec.js";
import {
  GhReadError,
  isGhQuotaExhausted,
  readGhGraphql,
  readGhJsonRows,
  tryReadGhJsonRows,
} from "../src/runtime/gh/read.js";
import { countOpenPrs, countPrsCreatedToday } from "../src/runtime/gh.js";

const RATE_LIMITED_STDERR =
  "gh: API rate limit exceeded for user ID 1. (HTTP 403)";

const RATE_LIMITED_GRAPHQL = JSON.stringify({
  data: { repository: null },
  errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
});

function execReturning(...outputs: Array<{ code: number; stdout: string; stderr?: string }>): {
  exec: ExecFn;
  calls: number;
} {
  const state = { exec: (() => Promise.resolve({ code: 0, stdout: "", stderr: "" })) as ExecFn, calls: 0 };
  state.exec = async () => {
    const out = outputs[Math.min(state.calls, outputs.length - 1)]!;
    state.calls += 1;
    return { code: out.code, stdout: out.stdout, stderr: out.stderr ?? "" };
  };
  return state as { exec: ExecFn; calls: number };
}

describe("gh read boundary — a failed query is not an empty result", () => {
  it("raises on an exhausted GraphQL query instead of returning an empty result set", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: RATE_LIMITED_STDERR });

    await expect(
      readGhJsonRows({ cwd: "/repo", exec }, ["pr", "list", "--json", "number"]),
    ).rejects.toBeInstanceOf(GhReadError);
  });

  it("raises on a GraphQL response whose payload carries RATE_LIMITED errors", async () => {
    // gh exits 0 and prints a well-formed body: `data` is present but null-filled
    // and `errors` explains the query never ran. Reading `data` at face value is
    // exactly how an exhausted query renders as an empty result.
    const exec: ExecFn = async () => ({ code: 0, stdout: RATE_LIMITED_GRAPHQL, stderr: "" });

    const error = await readGhGraphql({ cwd: "/repo", exec }, ["api", "graphql", "-f", "query=x"]).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GhReadError);
    expect((error as GhReadError).classification).toBe("quota");
    expect((error as GhReadError).surface).toBe("graphql");
  });

  it("returns a genuinely empty result set as empty, distinguishable from a failure", async () => {
    const empty = await tryReadGhJsonRows({ cwd: "/repo", exec: async () => ({ code: 0, stdout: "[]", stderr: "" }) }, [
      "pr",
      "list",
      "--json",
      "number",
    ]);
    const failed = await tryReadGhJsonRows(
      { cwd: "/repo", exec: async () => ({ code: 1, stdout: "", stderr: RATE_LIMITED_STDERR }) },
      ["pr", "list", "--json", "number"],
    );

    expect(empty).toEqual({ outcome: "rows", rows: [] });
    expect(failed.outcome).toBe("failed");
    // The consumer can branch on the outcome without inspecting exit codes.
    expect(empty.outcome === "rows" && empty.rows.length === 0).toBe(true);
    expect(failed.outcome === "failed" && failed.failure.classification).toBe("quota");
  });

  it("treats an empty stdout on a successful read as zero rows, not a failure", async () => {
    const rows = await readGhJsonRows({ cwd: "/repo", exec: async () => ({ code: 0, stdout: "", stderr: "" }) }, [
      "pr",
      "list",
      "--json",
      "number",
    ]);
    expect(rows).toEqual([]);
  });

  it("classifies a malformed payload as a failure rather than an empty result", async () => {
    const result = await tryReadGhJsonRows(
      { cwd: "/repo", exec: async () => ({ code: 0, stdout: "not-json", stderr: "" }) },
      ["pr", "list", "--json", "number"],
    );
    expect(result.outcome).toBe("failed");
    expect(result.outcome === "failed" && result.failure.classification).toBe("malformed");
  });

  it("labels a REST read as the rest surface and a non-quota failure as transport", async () => {
    const result = await tryReadGhJsonRows(
      { cwd: "/repo", exec: async () => ({ code: 1, stdout: "", stderr: "HTTP 404: Not Found" }) },
      ["api", "repos/o/r/issues"],
    );
    expect(result.outcome === "failed" && result.failure.surface).toBe("rest");
    expect(result.outcome === "failed" && result.failure.classification).toBe("transport");
    expect(result.outcome === "failed" && result.failure.transient).toBe(false);
  });
});

describe("gh read boundary — transient quota classification", () => {
  it("carries the transient quota classification so the bounded wait-and-retry path applies", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: RATE_LIMITED_STDERR });
    const waits: number[] = [];

    const error = await readGhJsonRows(
      {
        cwd: "/repo",
        exec,
        quotaBackoff: {
          nowMs: () => 0,
          sleepMs: async () => undefined,
          onWait: (remainingMs) => waits.push(remainingMs),
          capMs: 0,
        },
      },
      ["pr", "list", "--json", "number"],
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GhReadError);
    expect((error as GhReadError).classification).toBe("quota");
    expect((error as GhReadError).transient).toBe(true);
    expect(isGhQuotaExhausted(error)).toBe(true);
    // The cap was zero, so no local retry ran here: waiting is the shared
    // primitive's job, never this module's.
    expect(waits).toEqual([]);
  });

  it("lets the existing bounded wait-and-retry recover before raising", async () => {
    const state = execReturning(
      { code: 1, stdout: "", stderr: RATE_LIMITED_STDERR },
      { code: 0, stdout: JSON.stringify([{ number: 7 }]), stderr: "" },
    );

    const rows = await readGhJsonRows<{ number: number }>(
      {
        cwd: "/repo",
        exec: state.exec,
        quotaBackoff: { nowMs: () => 0, sleepMs: async () => undefined, capMs: 60_000 },
      },
      ["pr", "list", "--json", "number"],
    );

    expect(rows).toEqual([{ number: 7 }]);
  });

  it("does not classify a plain auth failure as quota exhaustion", async () => {
    const result = await tryReadGhJsonRows(
      { cwd: "/repo", exec: async () => ({ code: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }) },
      ["pr", "list", "--json", "number"],
    );
    expect(result.outcome === "failed" && result.failure.classification).toBe("transport");
    expect(isGhQuotaExhausted(result.outcome === "failed" ? result.failure : null)).toBe(false);
  });
});

describe("open pull-request consumers cannot render an exhausted query as none open", () => {
  it("countOpenPrs raises on an exhausted query rather than reporting zero open PRs", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: RATE_LIMITED_STDERR });

    const error = await countOpenPrs({ cwd: "/repo", repo: "o/r", exec }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GhReadError);
    expect(isGhQuotaExhausted(error)).toBe(true);
  });

  it("countOpenPrs still reports zero when the repo genuinely has no open PRs", async () => {
    const exec: ExecFn = async () => ({ code: 0, stdout: "[]", stderr: "" });
    await expect(countOpenPrs({ cwd: "/repo", repo: "o/r", exec })).resolves.toBe(0);
  });

  it("countOpenPrs counts the open PRs a successful query returns", async () => {
    const exec: ExecFn = async () => ({
      code: 0,
      stdout: JSON.stringify([{ number: 2801 }, { number: 2830 }]),
      stderr: "",
    });
    await expect(countOpenPrs({ cwd: "/repo", repo: "o/r", exec })).resolves.toBe(2);
  });

  it("countPrsCreatedToday raises on an exhausted query rather than reporting zero", async () => {
    const exec: ExecFn = async () => ({ code: 1, stdout: "", stderr: RATE_LIMITED_STDERR });
    await expect(
      countPrsCreatedToday({ cwd: "/repo", repo: "o/r", exec }, "2026-07-29"),
    ).rejects.toBeInstanceOf(GhReadError);
  });
});
