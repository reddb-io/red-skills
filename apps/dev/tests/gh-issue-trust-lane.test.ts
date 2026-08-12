import { describe, expect, it } from "vitest";
import { issueTrust, type GhContext } from "../src/runtime/gh.js";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";

/**
 * Lane-aware claim provenance (#2602): a `lane:go` / `lane:scout` issue NEVER
 * carries `ready-for-agent` (lane isolation is by design), so resolving the
 * promoter from `ready-for-agent` alone leaves `readyForAgentActor` undefined and
 * the trust gate refuses every /go dispatch under a non-permissive posture. The
 * fix teaches `issueTrust` the promoter label the issue was selected under: the
 * lane label's own `labeled` timeline event is the promoter analog.
 */

interface TimelineEvent {
  event: string;
  label?: { name: string };
  actor?: { login: string };
}

/** A gh fake that answers the routed single-object issue read (author) and the
 * routed timeline paginate (#3730), so the real `issueTrust` closure can be
 * driven without touching gh. Both calls are `gh api ...`; the timeline read is
 * distinguished by its `/timeline` path segment. */
function ghWith(opts: {
  author: string;
  timeline: TimelineEvent[];
}): { ctx: GhContext; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = (_bin, args) => {
    calls.push([...args]);
    let out: ExecOutput = { code: 0, stdout: "", stderr: "" };
    if (args[0] === "api" && args.some((a) => String(a).includes("/timeline"))) {
      out = { code: 0, stdout: JSON.stringify(opts.timeline), stderr: "" };
    } else if (args[0] === "api") {
      out = {
        code: 0,
        stdout: JSON.stringify({ user: { login: opts.author }, author_association: "OWNER" }),
        stderr: "",
      };
    }
    return Promise.resolve(out);
  };
  return { ctx: { cwd: "/r", repo: "acme/widgets", exec }, calls };
}

const labeled = (name: string, login: string): TimelineEvent => ({
  event: "labeled",
  label: { name },
  actor: { login },
});

describe("issueTrust — lane-aware promoter resolution (#2602)", () => {
  it("resolves the promoter from the lane:go label event when the promoter label is lane:go", async () => {
    const { ctx } = ghWith({
      author: "maint",
      // A lane:go issue: it carries the lane label applied by the maintainer's
      // `go` mint, and NEVER `ready-for-agent`.
      timeline: [labeled("lane:go", "maint")],
    });
    const trust = await issueTrust(ctx, 2600, "lane:go");
    expect(trust.readyForAgentActor).toBe("maint");
  });

  it("resolves the promoter from the lane:scout label event for the scout lane", async () => {
    const { ctx } = ghWith({
      author: "maint",
      timeline: [labeled("lane:scout", "maint")],
    });
    const trust = await issueTrust(ctx, 2601, "lane:scout");
    expect(trust.readyForAgentActor).toBe("maint");
  });

  it("defaults to the ready-for-agent event when no promoter label is passed (fleet lane)", async () => {
    const { ctx } = ghWith({
      author: "reporter",
      timeline: [labeled("ready-for-agent", "maint"), labeled("lane:go", "stranger")],
    });
    const trust = await issueTrust(ctx, 42);
    expect(trust.readyForAgentActor).toBe("maint");
  });

  it("returns the MOST RECENT lane-label applier when the lane was re-applied", async () => {
    const { ctx } = ghWith({
      author: "maint",
      timeline: [labeled("lane:go", "first"), labeled("lane:go", "second")],
    });
    const trust = await issueTrust(ctx, 2600, "lane:go");
    expect(trust.readyForAgentActor).toBe("second");
  });

  it("leaves the promoter undefined when the lane label carries no labeled event", async () => {
    const { ctx } = ghWith({
      author: "maint",
      timeline: [labeled("ready-for-agent", "maint")],
    });
    const trust = await issueTrust(ctx, 2600, "lane:go");
    expect(trust.readyForAgentActor).toBeUndefined();
  });
});
