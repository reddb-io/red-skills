import { describe, expect, it, vi } from "vitest";
import { editLabels, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

/**
 * Lane isolation at the LAST gate (#2894). `/go` is sold as safe to run beside
 * any fleet, and that promise rests on the disposable issue never carrying
 * `ready-for-agent` — the pool the fleet lists. The typed lifecycle edges guard
 * the promotions they can see, but most call sites declare only the labels they
 * intend to shed (a retry says `from: [running]`), so the lane never reaches the
 * pure model. This port reads the issue's REAL labels and refuses there.
 */

/** A gh fake answering `issue view --json labels` with `labels`, and recording
 * every `issue edit` it is asked to perform. */
function ghWith(labels: string[]): { ctx: GhContext; edits: string[][] } {
  const edits: string[][] = [];
  const exec: ExecFn = (_bin, args) => {
    let out: ExecOutput = { code: 0, stdout: "", stderr: "" };
    if (args[0] === "issue" && args[1] === "view") {
      out = { code: 0, stdout: JSON.stringify({ labels: labels.map((name) => ({ name })) }), stderr: "" };
    } else if (args[0] === "issue" && args[1] === "edit") {
      edits.push([...args]);
    }
    return Promise.resolve(out);
  };
  return { ctx: { cwd: "/r", repo: "acme/widgets", exec }, edits };
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

  it("promotes an ordinary backlog issue untouched, with no extra read", async () => {
    const { ctx, edits } = ghWith(["ready-for-human"]);

    expect(await editLabels(ctx, 42, ["ready-for-human"], ["ready-for-agent"])).toBe(true);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("--add-label");
    expect(edits[0]).toContain("ready-for-agent");
  });

  it("allows an edit that sheds the lane in the SAME call", async () => {
    // Judging the RESULTING set means a genuine "leave the lane" edit is not
    // refused for a label it just removed.
    const { ctx, edits } = ghWith(["lane:go"]);

    expect(await editLabels(ctx, 43, ["lane:go"], ["ready-for-agent"])).toBe(true);
    expect(edits).toHaveLength(1);
  });

  it("never reads the issue when the write is not a promotion", async () => {
    const reads: string[][] = [];
    const exec: ExecFn = (_bin, args) => {
      reads.push([...args]);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    const ctx: GhContext = { cwd: "/r", repo: "acme/widgets", exec };

    expect(await editLabels(ctx, 44, ["running"], ["ready-for-human"])).toBe(true);
    // Exactly one gh call: the edit itself. The guard costs nothing off the
    // promotion path.
    expect(reads).toHaveLength(1);
    expect(reads[0]?.[1]).toBe("edit");
  });
});
