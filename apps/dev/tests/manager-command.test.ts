import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { managerCommand } from "../src/commands/manager.js";
import { readEffort } from "../src/core/manager/effort-store.js";
import { readLease } from "../src/core/manager/effort-lease.js";
import type { ExecFn } from "../src/runtime/exec.js";

let root: string;
let out: string[];
let err: string[];

function deps(at?: string): Parameters<typeof managerCommand>[1] {
  return {
    root,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    // Pinned when a test starts two efforts, so "newest" never rides on two
    // real timestamps landing in the same millisecond.
    now: at ? () => new Date(at) : undefined,
  };
}

function brief(): Record<string, unknown> {
  return decode(out.join("")) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-command-"));
  out = [];
  err = [];
});

describe("manager <intent>", () => {
  it("starts an effort, persists it, and prints its brief", async () => {
    expect(await managerCommand(["ship the walking skeleton"], deps())).toBe(0);
    const rendered = brief();
    expect(rendered.kind).toBe("manager.brief");
    expect(rendered.lifecycle).toBe("inbox");
    expect(rendered.intent).toBe("ship the walking skeleton");

    const stored = await readEffort(root, String(rendered.effort_id));
    expect(stored?.intent).toBe("ship the walking skeleton");
    expect(stored?.generation).toBe(1);
  });

  it("joins a multi-word intent that the shell split into separate args", async () => {
    expect(await managerCommand(["ship", "the", "skeleton"], deps())).toBe(0);
    expect(brief().intent).toBe("ship the skeleton");
  });

  it("refuses an empty invocation with usage instead of minting a nameless effort", async () => {
    expect(await managerCommand([], deps())).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/usage/i);
  });
});

describe("manager status", () => {
  it("renders the most recently started effort", async () => {
    await managerCommand(["first intent"], deps("2026-07-21T00:00:00.000Z"));
    out = [];
    await managerCommand(["second intent"], deps("2026-07-21T01:00:00.000Z"));
    const second = brief();
    out = [];

    expect(await managerCommand(["status"], deps())).toBe(0);
    expect(brief().effort_id).toBe(second.effort_id);
  });

  it("renders a named effort by its id", async () => {
    await managerCommand(["first intent"], deps("2026-07-21T00:00:00.000Z"));
    const first = brief();
    out = [];
    await managerCommand(["second intent"], deps("2026-07-21T01:00:00.000Z"));
    out = [];

    expect(await managerCommand(["status", String(first.effort_id)], deps())).toBe(0);
    expect(brief().intent).toBe("first intent");
  });

  it("reports an unknown effort id instead of falling back to another effort", async () => {
    await managerCommand(["first intent"], deps());
    out = [];
    expect(await managerCommand(["status", "eff_zzzzzzzzzzzzzzzzzzzzzzzzzz"], deps())).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/eff_zzzz/);
  });

  it("renders an empty brief when the portfolio holds no effort", async () => {
    expect(await managerCommand(["status"], deps())).toBe(0);
    expect(brief()).toEqual({ kind: "manager.brief", state_source: "owned", efforts: 0 });
  });
});

describe("manager resume", () => {
  it("transitions an effort to active and prints its brief", async () => {
    await managerCommand(["start this effort"], deps());
    const started = brief();
    expect(started.lifecycle).toBe("inbox");
    out = [];

    expect(await managerCommand(["resume", String(started.effort_id)], deps())).toBe(0);
    const resumed = brief();
    expect(resumed.lifecycle).toBe("active");
    expect(resumed.effort_id).toBe(started.effort_id);
  });

  it("resumes the most recently started effort when no id is given", async () => {
    await managerCommand(["the latest effort"], deps());
    out = [];

    expect(await managerCommand(["resume"], deps())).toBe(0);
    expect(brief().lifecycle).toBe("active");
  });

  it("acquires a lease visible via readLease", async () => {
    await managerCommand(["leased effort"], deps());
    const started = brief();
    out = [];

    await managerCommand(["resume", String(started.effort_id)], { ...deps(), host: "test-host" });
    const lease = await readLease(root, String(started.effort_id));
    expect(lease).not.toBeNull();
    expect(lease?.host).toBe("test-host");
  });

  it("reports an error when no portfolio exists", async () => {
    expect(await managerCommand(["resume"], deps())).toBe(1);
    expect(err.join("")).toMatch(/no effort/i);
  });

  it("reports a lifecycle error when the effort cannot be resumed", async () => {
    await managerCommand(["already done"], deps());
    const started = brief();
    out = [];
    // End it
    await managerCommand(["resume", String(started.effort_id)], deps());
    out = [];
    await managerCommand(["end", String(started.effort_id)], deps());
    out = [];
    // Try to resume a completed effort
    expect(await managerCommand(["resume", String(started.effort_id)], deps())).toBe(1);
    expect(err.join("")).toMatch(/\[manager\]/);
  });
});

describe("manager end", () => {
  it("transitions an active effort to completed and prints its brief", async () => {
    await managerCommand(["finish this effort"], deps());
    const started = brief();
    out = [];
    await managerCommand(["resume", String(started.effort_id)], deps());
    out = [];

    expect(await managerCommand(["end", String(started.effort_id)], deps())).toBe(0);
    const ended = brief();
    expect(ended.lifecycle).toBe("completed");
    expect(ended.effort_id).toBe(started.effort_id);

    const stored = await readEffort(root, String(started.effort_id));
    expect(stored?.lifecycle).toBe("completed");
  });

  it("releases the lease on end", async () => {
    await managerCommand(["releaseme"], deps());
    const started = brief();
    out = [];
    await managerCommand(["resume", String(started.effort_id)], { ...deps(), host: "h1" });
    out = [];

    const leaseBefore = await readLease(root, String(started.effort_id));
    expect(leaseBefore).not.toBeNull();

    await managerCommand(["end", String(started.effort_id)], deps());
    const leaseAfter = await readLease(root, String(started.effort_id));
    expect(leaseAfter).toBeNull();
  });

  it("reports an error when no portfolio exists", async () => {
    expect(await managerCommand(["end"], deps())).toBe(1);
    expect(err.join("")).toMatch(/no effort/i);
  });

  it("reports a lifecycle error when the effort is not active", async () => {
    await managerCommand(["not active"], deps());
    const started = brief();
    out = [];
    // Effort is in inbox, not active — end should fail
    expect(await managerCommand(["end", String(started.effort_id)], deps())).toBe(1);
    expect(err.join("")).toMatch(/\[manager\]/);
  });
});

describe("manager dispatch (slice #2295)", () => {
  function makeGhDeps(
    issueNumber: number,
    issueState: "OPEN" | "CLOSED" = "OPEN",
  ): Parameters<typeof managerCommand>[1] {
    const exec: ExecFn = (_tool, args) => {
      // Issue creation and the reconcile read both ride REST now (#3663/#3729):
      // `gh api -X POST repos/{o}/{r}/issues ...` and `gh api repos/{o}/{r}/issues/{n}`.
      const isCreate = args.includes("POST") && args.some((a) => /repos\/.+\/issues$/.test(a));
      const isView = args[0] === "api" && args.some((a) => /repos\/.+\/issues\/\d+$/.test(a));
      if (isCreate) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            number: issueNumber,
            html_url: `https://github.com/acme/widgets/issues/${issueNumber}`,
          }),
          stderr: "",
        });
      }
      if (isView) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            number: issueNumber,
            state: issueState.toLowerCase(),
            labels: [{ name: "ready-for-agent" }],
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
    return { ...deps(), gh: { exec, repo: "acme/widgets", cwd: "/repo" } };
  }

  it("creates a tracker issue and records the dispatch_issue in the effort", async () => {
    await managerCommand(["dispatch this intent"], deps());
    const started = brief();
    out = [];

    expect(await managerCommand(["dispatch", String(started.effort_id)], makeGhDeps(300))).toBe(0);
    const stored = await readEffort(root, String(started.effort_id));
    expect(stored?.dispatch_issue).toBe(300);
  });

  it("renders a reconciled brief with execution_issue and execution_state", async () => {
    await managerCommand(["dispatch attempt"], deps());
    const started = brief();
    out = [];

    await managerCommand(["dispatch", String(started.effort_id)], makeGhDeps(301));
    const rendered = brief();
    expect(rendered.state_source).toBe("reconciled");
    expect(rendered.execution_issue).toBe(301);
    expect(rendered.execution_state).toBe("open");
  });

  it("dispatches the most recently started effort when no id is given", async () => {
    await managerCommand(["latest effort for dispatch"], deps());
    out = [];

    expect(await managerCommand(["dispatch"], makeGhDeps(302))).toBe(0);
    const rendered = brief();
    expect(rendered.execution_issue).toBe(302);
  });

  it("refuses a second dispatch when one already exists", async () => {
    await managerCommand(["already dispatched"], deps());
    const started = brief();
    out = [];

    await managerCommand(["dispatch", String(started.effort_id)], makeGhDeps(303));
    out = [];
    err = [];

    expect(
      await managerCommand(["dispatch", String(started.effort_id)], makeGhDeps(304)),
    ).toBe(1);
    expect(err.join("")).toMatch(/already dispatched/);
  });

  it("fails with exit code 1 when no GH context is provided", async () => {
    await managerCommand(["no gh context"], deps());
    const started = brief();
    out = [];

    expect(await managerCommand(["dispatch", String(started.effort_id)], deps())).toBe(1);
    expect(err.join("")).toMatch(/dispatch requires/i);
  });

  it("reconciles execution_state as open when the execution issue is open on status", async () => {
    await managerCommand(["reconcile on status"], deps());
    const started = brief();
    out = [];

    // Dispatch first
    await managerCommand(["dispatch", String(started.effort_id)], makeGhDeps(305, "OPEN"));
    out = [];

    // Status with GH context reconciles execution state
    await managerCommand(["status", String(started.effort_id)], makeGhDeps(305, "OPEN"));
    const rendered = brief();
    expect(rendered.state_source).toBe("reconciled");
    expect(rendered.execution_issue).toBe(305);
    expect(rendered.execution_state).toBe("open");
  });

  it("reconciles execution_state as closed when the execution issue is closed on status", async () => {
    await managerCommand(["reconcile closed on status"], deps());
    const started = brief();
    out = [];

    await managerCommand(["dispatch", String(started.effort_id)], makeGhDeps(306, "OPEN"));
    out = [];

    await managerCommand(["status", String(started.effort_id)], makeGhDeps(306, "CLOSED"));
    const rendered = brief();
    expect(rendered.execution_state).toBe("closed");
  });

  it("status falls back to owned brief when GH context is absent even with a dispatch_issue", async () => {
    await managerCommand(["no gh on status"], deps());
    const started = brief();
    out = [];

    // Dispatch with GH
    await managerCommand(["dispatch", String(started.effort_id)], makeGhDeps(307));
    out = [];

    // Status without GH — falls back to owned brief
    await managerCommand(["status", String(started.effort_id)], deps());
    const rendered = brief();
    expect(rendered.state_source).toBe("owned");
  });
});

describe("cli routing", () => {
  it("routes manager with its intent preserved", () => {
    expect(parseCli(["manager", "ship", "the", "skeleton"])).toEqual({
      command: "manager",
      args: ["ship", "the", "skeleton"],
    });
    expect(parseCli(["manager", "status"])).toEqual({ command: "manager", args: ["status"] });
    expect(parseCli(["manager", "resume"])).toEqual({ command: "manager", args: ["resume"] });
    expect(parseCli(["manager", "end"])).toEqual({ command: "manager", args: ["end"] });
    expect(parseCli(["manager", "dispatch"])).toEqual({ command: "manager", args: ["dispatch"] });
  });
});
