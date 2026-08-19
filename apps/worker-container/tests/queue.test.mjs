import { describe, expect, it, vi } from "vitest";

import { isParked, listReadyIssues, pickIssue, rotate } from "../src/queue.mjs";

const issue = (number, createdAt, labels = ["ready-for-agent"]) => ({
  number,
  createdAt,
  labels: labels.map((name) => ({ name })),
});

describe("isParked", () => {
  it("parks ready-for-human and every blocked:* label", () => {
    expect(isParked(issue(1, "2026-01-01", ["ready-for-agent", "ready-for-human"]))).toBe(true);
    expect(isParked(issue(1, "2026-01-01", ["blocked:dependency"]))).toBe(true);
    expect(isParked(issue(1, "2026-01-01", ["blocked:validation"]))).toBe(true);
  });

  it("does not park an ordinary queued issue", () => {
    expect(isParked(issue(1, "2026-01-01", ["ready-for-agent", "type:bug"]))).toBe(false);
  });

  it("accepts bare string labels", () => {
    expect(isParked({ number: 1, labels: ["blocked:dependency"] })).toBe(true);
  });
});

describe("pickIssue", () => {
  it("takes the oldest actionable issue", () => {
    const picked = pickIssue([issue(9, "2026-02-01"), issue(4, "2026-01-01"), issue(7, "2026-03-01")]);
    expect(picked.number).toBe(4);
  });

  it("skips parked issues even when they are older", () => {
    const picked = pickIssue([
      issue(2, "2026-01-01", ["ready-for-agent", "blocked:dependency"]),
      issue(5, "2026-02-01"),
    ]);
    expect(picked.number).toBe(5);
  });

  it("breaks createdAt ties by issue number", () => {
    expect(pickIssue([issue(8, "2026-01-01"), issue(3, "2026-01-01")]).number).toBe(3);
  });

  it("returns null when nothing is actionable", () => {
    expect(pickIssue([])).toBeNull();
    expect(pickIssue([issue(1, "2026-01-01", ["ready-for-human"])])).toBeNull();
  });
});

describe("listReadyIssues", () => {
  it("asks gh for open labelled issues and parses the JSON payload", async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ number: 3, createdAt: "2026-01-01", labels: [{ name: "ready-for-agent" }] }]),
      stderr: "",
    });
    const issues = await listReadyIssues({ repo: "owner/name", label: "ready-for-agent", exec });

    expect(issues).toHaveLength(1);
    expect(exec).toHaveBeenCalledWith("gh", [
      "api",
      "repos/owner/name/issues",
      "--method",
      "GET",
      "-f",
      "state=open",
      "-f",
      "labels=ready-for-agent",
      "-f",
      "per_page=100",
      "--jq",
      "map(select(.pull_request == null) | {number, createdAt: .created_at, labels})",
    ]);
  });

  it("throws with gh's stderr when the query fails", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: "", stderr: "HTTP 401" });
    await expect(listReadyIssues({ repo: "owner/name", label: "ready-for-agent", exec })).rejects.toThrow(/HTTP 401/);
  });

  it("returns an empty list for an empty queue", async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "[]\n", stderr: "" });
    await expect(listReadyIssues({ repo: "owner/name", label: "ready-for-agent", exec })).resolves.toEqual([]);
  });
});

describe("rotate", () => {
  it("starts the list at the cycle offset, wrapping", () => {
    expect(rotate(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
    expect(rotate(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotate(["a", "b", "c"], 4)).toEqual(["b", "c", "a"]);
  });

  it("handles an empty list", () => {
    expect(rotate([], 3)).toEqual([]);
  });
});
