import { describe, expect, it } from "vitest";
import {
  planRelabelSweep,
  planTicketRelabel,
  targetLabelsToEnsure,
} from "../src/core/relabel-sweep.js";
import { relabelSweepCommand, type RelabelSweepGh } from "../src/commands/relabel-sweep.js";
import type { TicketLabelState } from "../src/core/relabel-sweep.js";

describe("relabel-sweep planner (core)", () => {
  it("migrates type:prd → type:spec", () => {
    expect(planTicketRelabel({ number: 1, labels: ["type:prd", "ready-for-agent"] })).toEqual({
      number: 1,
      title: undefined,
      remove: ["type:prd"],
      add: ["type:spec"],
    });
  });

  it("migrates each prd:N → spec:N and leaves other families untouched", () => {
    expect(
      planTicketRelabel({ number: 2, title: "child", labels: ["prd:1013", "req:1010", "type:bug"] }),
    ).toEqual({
      number: 2,
      title: "child",
      remove: ["prd:1013"],
      add: ["spec:1013"],
    });
  });

  it("migrates both the type and ref families on one Ticket", () => {
    const plan = planTicketRelabel({ number: 3, labels: ["type:prd", "prd:900"] });
    expect(plan?.remove.sort()).toEqual(["prd:900", "type:prd"]);
    expect(plan?.add.sort()).toEqual(["spec:900", "type:spec"]);
  });

  it("returns null for a Ticket with no old-vocabulary labels (idempotent no-op)", () => {
    expect(planTicketRelabel({ number: 4, labels: ["type:spec", "spec:900", "req:1"] })).toBeNull();
  });

  it("removes the old label but does not re-add a target already present (idempotent convergence)", () => {
    expect(planTicketRelabel({ number: 5, labels: ["type:prd", "type:spec"] })).toEqual({
      number: 5,
      title: undefined,
      remove: ["type:prd"],
      add: [],
    });
  });

  it("does not match prd:N with a non-numeric suffix", () => {
    expect(planTicketRelabel({ number: 6, labels: ["prd:foo", "prdish"] })).toBeNull();
  });

  it("planRelabelSweep keeps only Tickets with work and preserves order", () => {
    const tickets: TicketLabelState[] = [
      { number: 10, labels: ["type:prd"] },
      { number: 11, labels: ["req:1"] },
      { number: 12, labels: ["prd:5"] },
    ];
    expect(planRelabelSweep(tickets).map((p) => p.number)).toEqual([10, 12]);
  });

  it("targetLabelsToEnsure returns the sorted, de-duplicated add set", () => {
    const plans = planRelabelSweep([
      { number: 1, labels: ["type:prd", "prd:5"] },
      { number: 2, labels: ["prd:5"] },
      { number: 3, labels: ["prd:9"] },
    ]);
    expect(targetLabelsToEnsure(plans)).toEqual(["spec:5", "spec:9", "type:spec"]);
  });
});

/** A recording fake gh surface for the command's control flow. */
function fakeGh(tickets: TicketLabelState[], existing: string[] = []): RelabelSweepGh & {
  created: string[];
  edits: Array<{ issue: number; remove: string[]; add: string[] }>;
} {
  const created: string[] = [];
  const edits: Array<{ issue: number; remove: string[]; add: string[] }> = [];
  return {
    created,
    edits,
    listOpenTickets: async () => tickets,
    existingLabels: async () => new Set(existing),
    createLabel: async (name) => {
      created.push(name);
    },
    editLabels: async (issue, remove, add) => {
      edits.push({ issue, remove, add });
    },
  };
}

function collect(): { stream: NodeJS.WritableStream; text: () => string } {
  let buf = "";
  const stream = { write: (s: string) => (buf += s, true) } as unknown as NodeJS.WritableStream;
  return { stream, text: () => buf };
}

describe("relabel-sweep command (IO control flow)", () => {
  it("--dry-run lists every affected Ticket and writes nothing", async () => {
    const gh = fakeGh([
      { number: 1, title: "spec doc", labels: ["type:prd"] },
      { number: 2, title: "child", labels: ["prd:1", "req:9"] },
      { number: 3, title: "unrelated", labels: ["type:bug"] },
    ]);
    const out = collect();
    const code = await relabelSweepCommand(["--dry-run"], "/repo", out.stream, gh);
    expect(code).toBe(0);
    expect(out.text()).toContain("#1 spec doc: remove=[type:prd] add=[type:spec]");
    expect(out.text()).toContain("#2 child: remove=[prd:1] add=[spec:1]");
    expect(out.text()).not.toContain("#3");
    expect(out.text()).toContain("no changes written");
    // Nothing written.
    expect(gh.created).toEqual([]);
    expect(gh.edits).toEqual([]);
  });

  it("real run creates only missing labels and applies exactly the plan", async () => {
    const gh = fakeGh(
      [
        { number: 1, labels: ["type:prd", "prd:5"] },
        { number: 2, labels: ["prd:5"] },
      ],
      ["type:spec"], // already exists — must not be re-created
    );
    const out = collect();
    const code = await relabelSweepCommand([], "/repo", out.stream, gh);
    expect(code).toBe(0);
    // type:spec pre-existed; only spec:5 created.
    expect(gh.created).toEqual(["spec:5"]);
    expect(gh.edits).toEqual([
      { issue: 1, remove: ["type:prd", "prd:5"], add: ["type:spec", "spec:5"] },
      { issue: 2, remove: ["prd:5"], add: ["spec:5"] },
    ]);
  });

  it("is idempotent — a replay over already-migrated Tickets no-ops", async () => {
    const gh = fakeGh([
      { number: 1, labels: ["type:spec", "spec:5"] },
      { number: 2, labels: ["req:9"] },
    ]);
    const out = collect();
    const code = await relabelSweepCommand([], "/repo", out.stream, gh);
    expect(code).toBe(0);
    expect(out.text()).toContain("nothing to migrate");
    expect(gh.created).toEqual([]);
    expect(gh.edits).toEqual([]);
  });
});
