import { describe, expect, it } from "vitest";
import type { ExecFn, ExecOutput } from "../src/runtime/exec.js";
import {
  findManagerMapByEffortId,
  publishAndReconcileManagerMap,
  dispatchExecutionIssue,
  readExecutionArtifact,
} from "../src/runtime/gh/manager-map.js";
import { buildEffortMarker, LABEL_MANAGER_MAP } from "../src/core/manager/map-reconciler.js";
import type { EffortRecord } from "../src/core/manager/effort-store.js";

const EFFORT: EffortRecord = {
  effort_id: "eff_abcdefghijklmnopqrstuvwxyz",
  name: "walking skeleton",
  intent: "prove the manager persists an effort",
  lifecycle: "inbox",
  generation: 1,
  created_at: "2026-07-21T00:00:00.000Z",
  updated_at: "2026-07-21T00:00:00.000Z",
};

const CTX_BASE = { repo: "acme/widgets", cwd: "/repo" };

function isIssueCreate(args: readonly string[]): boolean {
  return args[0] === "api" && args[1] === "-X" && args[2] === "POST" && args[3] === `repos/${CTX_BASE.repo}/issues`;
}

function isIssueEdit(args: readonly string[]): boolean {
  return args[0] === "api" && args[1] === "-X" && args[2] === "PATCH" && String(args[3]).startsWith(`repos/${CTX_BASE.repo}/issues/`);
}

function makeMap(overrides: Partial<{ number: number; labels: string[] }> = {}): object {
  return {
    number: overrides.number ?? 99,
    title: "[manager] walking skeleton",
    body: `${buildEffortMarker(EFFORT.effort_id)}\n\n**walking skeleton**: prove the manager persists an effort`,
    labels: (overrides.labels ?? [LABEL_MANAGER_MAP]).map((name) => ({ name })),
  };
}

describe("findManagerMapByEffortId", () => {
  it("returns null when the issue list returns no results", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    const ctx = { ...CTX_BASE, exec };
    expect(await findManagerMapByEffortId(ctx, EFFORT.effort_id)).toBeNull();
  });

  it("returns null when gh exits non-zero", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 1, stdout: "", stderr: "error" });
    const ctx = { ...CTX_BASE, exec };
    expect(await findManagerMapByEffortId(ctx, EFFORT.effort_id)).toBeNull();
  });

  it("returns the matching issue when the marker is present in the body", async () => {
    const exec: ExecFn = () =>
      Promise.resolve({ code: 0, stdout: JSON.stringify([makeMap()]), stderr: "" });
    const ctx = { ...CTX_BASE, exec };
    const result = await findManagerMapByEffortId(ctx, EFFORT.effort_id);
    expect(result).not.toBeNull();
    expect(result?.number).toBe(99);
    expect(result?.labels).toContain(LABEL_MANAGER_MAP);
  });

  it("rejects a result whose body carries a different effort-id (no false positives)", async () => {
    const other = makeMap();
    (other as Record<string, unknown>).body =
      `${buildEffortMarker("eff_zzzzzzzzzzzzzzzzzzzzzzzzzz")}\n\nother effort`;
    const exec: ExecFn = () =>
      Promise.resolve({ code: 0, stdout: JSON.stringify([other]), stderr: "" });
    const ctx = { ...CTX_BASE, exec };
    expect(await findManagerMapByEffortId(ctx, EFFORT.effort_id)).toBeNull();
  });

  it("passes --search with the effort-id so the tracker pre-filters results", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_tool, args) => {
      calls.push([...args]);
      return Promise.resolve({ code: 0, stdout: "[]", stderr: "" });
    };
    const ctx = { ...CTX_BASE, exec };
    await findManagerMapByEffortId(ctx, EFFORT.effort_id);
    const searchArg = calls[0] ?? [];
    const searchIdx = searchArg.indexOf("--search");
    expect(searchIdx).toBeGreaterThan(-1);
    expect(searchArg[searchIdx + 1]).toContain(EFFORT.effort_id);
  });
});

describe("publishAndReconcileManagerMap — create path", () => {
  it("creates a map when none is found and returns derived state with the new number", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_tool, args) => {
      calls.push([...args]);
      const isCreate = isIssueCreate(args);
      const isSubIssues = String(args[2] ?? "").includes("sub_issues");
      const out: ExecOutput = isCreate
        ? { code: 0, stdout: "https://github.com/acme/widgets/issues/101", stderr: "" }
        : isSubIssues
          ? { code: 0, stdout: "", stderr: "" }
          : { code: 0, stdout: "[]", stderr: "" };
      return Promise.resolve(out);
    };
    const ctx = { ...CTX_BASE, exec };
    const derived = await publishAndReconcileManagerMap(ctx, EFFORT);
    expect(derived.map_issue).toBe(101);
    expect(derived.child_count).toBe(0);
    const createCall = calls.find(isIssueCreate);
    expect(createCall).toBeDefined();
  });

  it("throws when issue creation fails", async () => {
    const exec: ExecFn = (_tool, args) => {
      const isCreate = isIssueCreate(args);
      return Promise.resolve({
        code: isCreate ? 1 : 0,
        stdout: isCreate ? "" : "[]",
        stderr: "error",
      });
    };
    const ctx = { ...CTX_BASE, exec };
    await expect(publishAndReconcileManagerMap(ctx, EFFORT)).rejects.toThrow(/failed to create/);
  });

  it("includes the manager-map label in the create call", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_tool, args) => {
      calls.push([...args]);
      const isCreate = isIssueCreate(args);
      return Promise.resolve({
        code: 0,
        stdout: isCreate ? "https://github.com/acme/widgets/issues/55" : "[]",
        stderr: "",
      });
    };
    const ctx = { ...CTX_BASE, exec };
    await publishAndReconcileManagerMap(ctx, EFFORT);
    const createCall = calls.find(isIssueCreate) ?? [];
    const labelIdx = createCall.indexOf(`labels[]=${LABEL_MANAGER_MAP}`);
    expect(labelIdx).toBeGreaterThan(-1);
  });
});

describe("publishAndReconcileManagerMap — existing map path (idempotence)", () => {
  function makeExecWithExisting(
    existingLabels: string[],
    children: Array<{ number: number }> = [],
  ): ExecFn {
    return (_tool, args) => {
      const isList = args[0] === "issue" && args[1] === "list";
      const isEdit = isIssueEdit(args);
      const isSubIssues = String(args[2] ?? "").includes("sub_issues");
      let stdout = "[]";
      if (isList) stdout = JSON.stringify([makeMap({ labels: existingLabels })]);
      else if (isSubIssues) stdout = children.map((c) => JSON.stringify(c)).join("\n");
      return Promise.resolve({ code: 0, stdout, stderr: "" });
    };
  }

  it("skips creation when the map already exists — no create call", async () => {
    const calls: string[][] = [];
    const baseExec = makeExecWithExisting([LABEL_MANAGER_MAP]);
    const exec: ExecFn = (tool, args, opts) => {
      calls.push([...args]);
      return baseExec(tool, args, opts);
    };
    const ctx = { ...CTX_BASE, exec };
    await publishAndReconcileManagerMap(ctx, EFFORT);
    const createCall = calls.find(isIssueCreate);
    expect(createCall).toBeUndefined();
  });

  it("returns the existing map number as map_issue", async () => {
    const exec = makeExecWithExisting([LABEL_MANAGER_MAP]);
    const ctx = { ...CTX_BASE, exec };
    const derived = await publishAndReconcileManagerMap(ctx, EFFORT);
    expect(derived.map_issue).toBe(99);
  });

  it("applies missing labels without recreating the map", async () => {
    const calls: string[][] = [];
    const baseExec = makeExecWithExisting([]);
    const exec: ExecFn = (tool, args, opts) => {
      calls.push([...args]);
      return baseExec(tool, args, opts);
    };
    const ctx = { ...CTX_BASE, exec };
    await publishAndReconcileManagerMap(ctx, EFFORT);
    const editCall = calls.find(isIssueEdit);
    expect(editCall).toBeDefined();
    expect(editCall).toContain(`labels[]=${LABEL_MANAGER_MAP}`);
    const createCall = calls.find(isIssueCreate);
    expect(createCall).toBeUndefined();
  });

  it("skips label edit when all desired labels are already present", async () => {
    const calls: string[][] = [];
    const baseExec = makeExecWithExisting([LABEL_MANAGER_MAP]);
    const exec: ExecFn = (tool, args, opts) => {
      calls.push([...args]);
      return baseExec(tool, args, opts);
    };
    const ctx = { ...CTX_BASE, exec };
    await publishAndReconcileManagerMap(ctx, EFFORT);
    const editCall = calls.find(isIssueEdit);
    expect(editCall).toBeUndefined();
  });

  it("reconciles native children into the derived state", async () => {
    const children = [{ number: 10 }, { number: 20 }, { number: 30 }];
    const exec = makeExecWithExisting([LABEL_MANAGER_MAP], children);
    const ctx = { ...CTX_BASE, exec };
    const derived = await publishAndReconcileManagerMap(ctx, EFFORT);
    expect(derived.child_count).toBe(3);
    expect(derived.children).toContain(10);
    expect(derived.children).toContain(20);
    expect(derived.children).toContain(30);
  });

  it("returns zero children when the map has no sub-issues yet", async () => {
    const exec = makeExecWithExisting([LABEL_MANAGER_MAP], []);
    const ctx = { ...CTX_BASE, exec };
    const derived = await publishAndReconcileManagerMap(ctx, EFFORT);
    expect(derived.child_count).toBe(0);
    expect(derived.children).toEqual([]);
  });
});

describe("publishAndReconcileManagerMap — partial-failure convergence", () => {
  it("converges on rerun after a label-edit partial failure — best-effort converge, no rollback", async () => {
    // Declarative converge: a failed label edit does not throw or roll back.
    // The map is still found and returned; the next run re-applies the label.
    const execWithFailingEdit: ExecFn = (_tool, args) => {
      const isList = args[0] === "issue" && args[1] === "list";
      const isEdit = isIssueEdit(args);
      const isSubIssues = String(args[2] ?? "").includes("sub_issues");
      if (isEdit) return Promise.resolve({ code: 1, stdout: "", stderr: "transient" });
      return Promise.resolve({
        code: 0,
        stdout: isList ? JSON.stringify([makeMap({ labels: [] })]) : isSubIssues ? "" : "[]",
        stderr: "",
      });
    };
    const ctx = { ...CTX_BASE, exec: execWithFailingEdit };
    // First run: map found, label edit fails — still returns map_issue (no throw)
    const first = await publishAndReconcileManagerMap(ctx, EFFORT);
    expect(first.map_issue).toBe(99);

    // Second run (rerun): label already present → no edit needed, fully converges
    const execConverged: ExecFn = (_tool, args) => {
      const isList = args[0] === "issue" && args[1] === "list";
      const isSubIssues = String(args[2] ?? "").includes("sub_issues");
      return Promise.resolve({
        code: 0,
        stdout: isList
          ? JSON.stringify([makeMap({ labels: [LABEL_MANAGER_MAP] })])
          : isSubIssues
            ? ""
            : "[]",
        stderr: "",
      });
    };
    const ctx2 = { ...CTX_BASE, exec: execConverged };
    const second = await publishAndReconcileManagerMap(ctx2, EFFORT);
    expect(second.map_issue).toBe(99);
  });

  it("rename-rejoin — finds the map by marker even after the title was changed", async () => {
    const renamedMap = {
      ...makeMap(),
      title: "[manager] new name after rename",
    };
    const exec: ExecFn = (_tool, args) => {
      const isList = args[0] === "issue" && args[1] === "list";
      const isSubIssues = String(args[2] ?? "").includes("sub_issues");
      return Promise.resolve({
        code: 0,
        stdout: isList ? JSON.stringify([renamedMap]) : isSubIssues ? "" : "[]",
        stderr: "",
      });
    };
    const ctx = { ...CTX_BASE, exec };
    const derived = await publishAndReconcileManagerMap(ctx, EFFORT);
    // The marker in the body identifies the effort even though the title changed
    expect(derived.map_issue).toBe(99);
  });
});

describe("dispatchExecutionIssue (slice #2295)", () => {
  it("creates a ready-for-agent issue and returns its number", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_tool, args) => {
      calls.push([...args]);
      const isCreate = isIssueCreate(args);
      return Promise.resolve({
        code: 0,
        stdout: isCreate ? "https://github.com/acme/widgets/issues/200" : "",
        stderr: "",
      });
    };
    const ctx = { ...CTX_BASE, exec };
    const num = await dispatchExecutionIssue(ctx, EFFORT, null);
    expect(num).toBe(200);
    const createCall = calls.find(isIssueCreate);
    expect(createCall).toBeDefined();
    expect(createCall).toContain("labels[]=ready-for-agent");
  });

  it("links the execution issue as a sub-issue when a map number is given", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_tool, args) => {
      calls.push([...args]);
      const isCreate = isIssueCreate(args);
      return Promise.resolve({
        code: 0,
        stdout: isCreate ? "https://github.com/acme/widgets/issues/201" : "",
        stderr: "",
      });
    };
    const ctx = { ...CTX_BASE, exec };
    await dispatchExecutionIssue(ctx, EFFORT, 99);
    // The sub-issues call is: ["api", "-X", "POST", "<path>/sub_issues", "-F", "sub_issue_id=N"]
    const subIssueCall = calls.find((c) => c.some((a) => a.includes("sub_issues")));
    expect(subIssueCall).toBeDefined();
    expect(subIssueCall?.join(" ")).toContain("sub_issue_id=201");
  });

  it("does NOT link a sub-issue when mapNumber is null", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_tool, args) => {
      calls.push([...args]);
      const isCreate = isIssueCreate(args);
      return Promise.resolve({
        code: 0,
        stdout: isCreate ? "https://github.com/acme/widgets/issues/202" : "",
        stderr: "",
      });
    };
    const ctx = { ...CTX_BASE, exec };
    await dispatchExecutionIssue(ctx, EFFORT, null);
    const subIssueCall = calls.find((c) => c.some((a) => a.includes("sub_issues")));
    expect(subIssueCall).toBeUndefined();
  });

  it("throws when issue creation fails", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 1, stdout: "", stderr: "error" });
    const ctx = { ...CTX_BASE, exec };
    await expect(dispatchExecutionIssue(ctx, EFFORT, null)).rejects.toThrow(/failed to create/);
  });

  it("includes the effort-ID marker in the execution issue body", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (_tool, args) => {
      calls.push([...args]);
      const isCreate = isIssueCreate(args);
      return Promise.resolve({
        code: 0,
        stdout: isCreate ? "https://github.com/acme/widgets/issues/203" : "",
        stderr: "",
      });
    };
    const ctx = { ...CTX_BASE, exec };
    await dispatchExecutionIssue(ctx, EFFORT, null);
    const createCall = calls.find(isIssueCreate) ?? [];
    const bodyIdx = createCall.findIndex((arg) => arg.startsWith("body="));
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(createCall[bodyIdx]).toContain(EFFORT.effort_id);
  });
});

describe("readExecutionArtifact (slice #2295)", () => {
  it("returns open execution state when the issue is open", async () => {
    const exec: ExecFn = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ number: 55, state: "OPEN", labels: [{ name: "ready-for-agent" }] }),
        stderr: "",
      });
    const ctx = { ...CTX_BASE, exec };
    const artifact = await readExecutionArtifact(ctx, 55);
    expect(artifact).not.toBeNull();
    expect(artifact?.issue_number).toBe(55);
    expect(artifact?.state).toBe("open");
    expect(artifact?.labels).toContain("ready-for-agent");
  });

  it("returns closed execution state when the issue is closed", async () => {
    const exec: ExecFn = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ number: 56, state: "CLOSED", labels: [] }),
        stderr: "",
      });
    const ctx = { ...CTX_BASE, exec };
    const artifact = await readExecutionArtifact(ctx, 56);
    expect(artifact?.state).toBe("closed");
  });

  it("returns null when gh exits non-zero — silently tolerated", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 1, stdout: "", stderr: "not found" });
    const ctx = { ...CTX_BASE, exec };
    const artifact = await readExecutionArtifact(ctx, 57);
    expect(artifact).toBeNull();
  });

  it("returns null when the response is not valid JSON", async () => {
    const exec: ExecFn = () => Promise.resolve({ code: 0, stdout: "not-json", stderr: "" });
    const ctx = { ...CTX_BASE, exec };
    const artifact = await readExecutionArtifact(ctx, 58);
    expect(artifact).toBeNull();
  });

  it("returns null when state is not open or closed", async () => {
    const exec: ExecFn = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ number: 59, state: "MERGED", labels: [] }),
        stderr: "",
      });
    const ctx = { ...CTX_BASE, exec };
    const artifact = await readExecutionArtifact(ctx, 59);
    expect(artifact).toBeNull();
  });

  it("treats the tracker state as untrusted evidence — pr_numbers is empty in this slice", async () => {
    const exec: ExecFn = () =>
      Promise.resolve({
        code: 0,
        stdout: JSON.stringify({ number: 60, state: "OPEN", labels: [] }),
        stderr: "",
      });
    const ctx = { ...CTX_BASE, exec };
    const artifact = await readExecutionArtifact(ctx, 60);
    expect(artifact?.pr_numbers).toEqual([]);
  });
});
