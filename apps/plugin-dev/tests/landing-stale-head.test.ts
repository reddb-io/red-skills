import { describe, expect, it } from "vitest";
import { DEFAULT_BRANCH_TIP, doLanding, harness } from "./landing.test-support.js";

// #4134: merge refuses stale heads. A caller that pinned the tip its gate
// validated must never merge a head that moved past it — unless the move is a
// clean rebase carrying the identical stable patch-id.

const VALIDATED = "1111111111111111111111111111111111111111";

function withPatchIds(
  h: ReturnType<typeof harness>,
  ids: Record<string, string | null>,
): void {
  const inner = h.deps.mergeExec;
  let lastDiffTip = "";
  h.deps.mergeExec = async (args: string[], options?: { input?: string }) => {
    const joined = args.join(" ");
    const diffMatch = joined.match(/ diff \S+\.\.\.(\S+)$/);
    if (diffMatch) {
      lastDiffTip = diffMatch[1]!;
      return { code: 0, stdout: `diff-of-${lastDiffTip}\n`, stderr: "" };
    }
    if (joined.includes("patch-id --stable")) {
      const tip = (options?.input ?? "").replace(/^diff-of-/, "").trim();
      const id = ids[tip];
      return id == null
        ? { code: 1, stdout: "", stderr: "no patch id" }
        : { code: 0, stdout: `${id} deadbeef\n`, stderr: "" };
    }
    return inner(args, options);
  };
}

describe("doLanding refuses a stale head (#4134)", () => {
  it("refuses when the branch advanced past the validated tip with a different change", async () => {
    const h = harness({ locked: false });
    withPatchIds(h, { [VALIDATED]: "aaaa", [DEFAULT_BRANCH_TIP]: "bbbb" });
    const r = await doLanding(h.deps, { ...h.input, validatedBranchTip: VALIDATED }, h.hooks);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("stale-head");
    expect(r.message).toContain(VALIDATED.slice(0, 12));
    expect(r.message).toContain(DEFAULT_BRANCH_TIP.slice(0, 12));
  });

  it("treats an unanswerable patch-id as stale, never as equivalence", async () => {
    const h = harness({ locked: false });
    withPatchIds(h, { [VALIDATED]: null, [DEFAULT_BRANCH_TIP]: null });
    const r = await doLanding(h.deps, { ...h.input, validatedBranchTip: VALIDATED }, h.hooks);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("stale-head");
  });

  it("lands the live head when the divergence is a clean rebase (same stable patch-id)", async () => {
    const h = harness({ locked: false });
    withPatchIds(h, { [VALIDATED]: "same", [DEFAULT_BRANCH_TIP]: "same" });
    const r = await doLanding(h.deps, { ...h.input, validatedBranchTip: VALIDATED }, h.hooks);

    expect(r.ok).toBe(true);
  });

  it("an identical live head is the ordinary landing, no patch-id consulted", async () => {
    const h = harness({ locked: false });
    let patchIdCalls = 0;
    const inner = h.deps.mergeExec;
    h.deps.mergeExec = async (args: string[], options?: { input?: string }) => {
      if (args.join(" ").includes("patch-id")) patchIdCalls += 1;
      return inner(args, options);
    };
    const r = await doLanding(h.deps, { ...h.input, validatedBranchTip: DEFAULT_BRANCH_TIP }, h.hooks);

    expect(r.ok).toBe(true);
    expect(patchIdCalls).toBe(0);
  });
});
