import { describe, expect, it, vi } from "vitest";
import { closeIssue, editBody, editLabels, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import { readsIssue, restIssueBody } from "./support/gh-rest-fixtures.js";

/**
 * Lane isolation at the LAST gate (#2894). `/go` is sold as safe to run beside
 * any fleet, and that promise rests on the disposable issue never carrying
 * `ready-for-agent` — the pool the fleet lists. The typed lifecycle edges guard
 * the promotions they can see, but most call sites declare only the labels they
 * intend to shed (a retry says `from: [running]`), so the lane never reaches the
 * pure model. This port reads the issue's REAL labels and refuses there.
 */

/** A gh fake answering the REST read of one issue with `labels`, and recording
 * every `issue edit` it is asked to perform. The label read routes to REST
 * (#3094): one issue by number is a single-object read. */
function ghWith(labels: string[]): { ctx: GhContext; edits: string[][]; reads: { count: number } } {
  const edits: string[][] = [];
  const reads = { count: 0 };
  const exec: ExecFn = (_bin, args) => {
    let out: ExecOutput = { code: 0, stdout: "", stderr: "" };
    if (readsIssue(args)) {
      reads.count += 1;
      out = { code: 0, stdout: JSON.stringify(restIssueBody({ labels })), stderr: "" };
    } else {
      edits.push([...args]);
    }
    return Promise.resolve(out);
  };
  return { ctx: { cwd: "/r", repo: "acme/widgets", exec }, edits, reads };
}

describe("editLabels — lane isolation backstop (#2894)", () => {
  it("refuses to promote a lane:go issue and performs no edit", async () => {
    const { ctx, edits } = ghWith(["lane:go", "running"]);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const ok = await editLabels(ctx, 2888, ["running"], ["ready-for-agent"]);

    expect(ok).toBe(false);
    expect(edits).toEqual([]);
    // The refusal names the lane and the origin of the write.
    const message = String(stderr.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("#2888");
    expect(message).toContain("lane:go");
    expect(message).toContain("direct label write");
    stderr.mockRestore();
  });

  it("refuses a lane:scout promotion the same way", async () => {
    const { ctx, edits } = ghWith(["lane:scout"]);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(await editLabels(ctx, 41, [], ["ready-for-agent"])).toBe(false);
    expect(edits).toEqual([]);
    stderr.mockRestore();
  });

  it("promotes an ordinary backlog issue with a REST PATCH of the resulting labels", async () => {
    const { ctx, edits, reads } = ghWith(["ready-for-human"]);

    expect(await editLabels(ctx, 42, ["ready-for-human"], ["ready-for-agent"])).toBe(true);
    expect(reads.count).toBe(1);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual([
      "api", "-X", "PATCH", "repos/acme/widgets/issues/42", "-F", "labels[]=ready-for-agent",
    ]);
  });

  it("allows an edit that sheds the lane in the SAME call", async () => {
    // Judging the RESULTING set means a genuine "leave the lane" edit is not
    // refused for a label it just removed.
    const { ctx, edits } = ghWith(["lane:go"]);

    expect(await editLabels(ctx, 43, ["lane:go"], ["ready-for-agent"])).toBe(true);
    expect(edits).toHaveLength(1);
  });

  it("reads labels before a non-promotion so the REST replacement preserves unrelated labels", async () => {
    const { ctx, edits, reads } = ghWith(["type:bug", "running"]);

    expect(await editLabels(ctx, 44, ["running"], ["ready-for-human"])).toBe(true);
    expect(reads.count).toBe(1);
    expect(edits[0]).toEqual([
      "api", "-X", "PATCH", "repos/acme/widgets/issues/44",
      "-F", "labels[]=type:bug", "-F", "labels[]=ready-for-human",
    ]);
  });
});

describe("issue edits — REST write plan (#3724)", () => {
  it("routes body and state mutations through REST PATCH", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_bin, args) => {
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec };

    expect(await editBody(ctx, 45, "next body")).toBe(true);
    await closeIssue(ctx, 45);

    expect(calls).toEqual([
      ["api", "-X", "PATCH", "repos/acme/widgets/issues/45", "-f", "body=next body"],
      [
        "api", "-X", "PATCH", "repos/acme/widgets/issues/45",
        "-f", "state=closed", "-f", "state_reason=completed",
      ],
    ]);
  });
});
