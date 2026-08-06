// tests/manager-s7-acceptance-journey.test.ts — end-to-end acceptance journey
// harness for the Manager (Spec #2290, slice #2297; architecture in ADR 0109).
//
// Mirrors the pattern of castle-acceptance-harness.test.ts but for the Manager.
// Each it-block proves a specific acceptance-criteria claim in isolation, so a
// failure names the exact gap rather than leaving the reader to bisect a
// monolithic proof.
//
// Acceptance criteria covered:
//   - persistence: an effort survives write → read
//   - declarative-reconcile convergence: plan → partial-apply → re-plan → ok
//   - rename-rejoin: the map issue is found by effort-id marker after rename
//   - lease fail-closed: a live lease on a different host blocks acquisition
//   - five-state lifecycle: inbox → active → paused → active → completed + abandoned
//   - dogfood scenario: a realistic RedSkills improvement effort, start to finish

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { managerCommand } from "../src/commands/manager.js";
import {
  readEffort,
  saveEffort,
  startEffort,
} from "../src/core/manager/effort-store.js";
import {
  ManagerLeaseConflictError,
  endEffort,
  manageEffort,
  readLease,
} from "../src/core/manager/effort-lease.js";
import {
  LABEL_MANAGER_MAP,
  buildEffortMarker,
  buildMapBody,
  buildMapTitle,
  extractEffortIdFromBody,
  planMapPublish,
} from "../src/core/manager/map-reconciler.js";
import { exportCheckpoint, importCheckpoint } from "../src/core/manager/checkpoint.js";
import type { ExecFn } from "../src/runtime/exec.js";

const PINNED_NOW = "2026-07-21T10:00:00.000Z";
const now = () => new Date(PINNED_NOW);

describe("manager S7 acceptance journey harness", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function makeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "manager-s7-"));
    roots.push(root);
    return root;
  }

  function makeDeps(
    root: string,
    out: string[],
    err: string[],
    extra: Parameters<typeof managerCommand>[1] = {},
  ): Parameters<typeof managerCommand>[1] {
    return {
      root,
      now,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      ...extra,
    };
  }

  function brief(out: string[]): Record<string, unknown> {
    return decode(out.join("")) as Record<string, unknown>;
  }

  function makeGhExec(issueNumber: number, state: "OPEN" | "CLOSED" = "OPEN"): ExecFn {
    return (_tool, args) => {
      if (args[0] === "issue" && args[1] === "create") {
        return Promise.resolve({
          code: 0,
          stdout: `https://github.com/reddb-io/red-skills/issues/${issueNumber}`,
          stderr: "",
        });
      }
      if (args[0] === "issue" && args[1] === "view") {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            number: issueNumber,
            state,
            labels: [{ name: "ready-for-agent" }],
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    };
  }

  // ── Full operator journey ──────────────────────────────────────────────────

  it("proves the full operator journey: intent → route → resume → artifact → dispatch → reconcile → complete", async () => {
    const root = await makeRoot();
    const out: string[] = [];
    const err: string[] = [];
    const deps = (extra: Parameters<typeof managerCommand>[1] = {}) =>
      makeDeps(root, out, err, extra);

    // 1. INBOX — mint an effort from an operator intent
    expect(await managerCommand(["add TypeScript strict-mode to the shared package"], deps())).toBe(
      0,
    );
    const startedBrief = brief(out);
    expect(startedBrief.lifecycle).toBe("inbox");
    expect(startedBrief.generation).toBe(1);
    const effortId = String(startedBrief.effort_id);
    out.length = 0;

    // Persistence: the effort survives a read-back
    const stored = await readEffort(root, effortId);
    expect(stored?.intent).toBe("add TypeScript strict-mode to the shared package");
    expect(stored?.generation).toBe(1);

    // 2. ROUTING — ask-red classified this as "to-spec"; record it
    expect(await managerCommand(["route", effortId, "to-spec"], deps())).toBe(0);
    expect(brief(out).route).toBe("to-spec");
    expect((await readEffort(root, effortId))?.route).toBe("to-spec");
    out.length = 0;

    // 3. INLINE PLANNING — a session-bound skill (to-spec) produced an artifact
    const specRef = "https://github.com/reddb-io/red-skills/issues/2290";
    expect(await managerCommand(["artifact", effortId, specRef], deps())).toBe(0);
    expect(brief(out).artifact_refs).toEqual([specRef]);
    out.length = 0;

    // 4. ACTIVE — resume the effort; inbox → active
    expect(await managerCommand(["resume", effortId], deps({ host: "laptop-A" }))).toBe(0);
    const resumedBrief = brief(out);
    expect(resumedBrief.lifecycle).toBe("active");
    expect(Number(resumedBrief.generation)).toBeGreaterThan(1);
    const lease = await readLease(root, effortId);
    expect(lease?.host).toBe("laptop-A");
    out.length = 0;

    // 5. DISPATCH — dispatch autonomous execution via fake GH
    const DISPATCH_ISSUE = 2299;
    expect(
      await managerCommand(
        ["dispatch", effortId],
        deps({
          gh: {
            exec: makeGhExec(DISPATCH_ISSUE, "OPEN"),
            repo: "reddb-io/red-skills",
            cwd: "/repo",
          },
        }),
      ),
    ).toBe(0);
    const dispatchedBrief = brief(out);
    expect(dispatchedBrief.state_source).toBe("reconciled");
    expect(dispatchedBrief.execution_issue).toBe(DISPATCH_ISSUE);
    expect(dispatchedBrief.execution_state).toBe("open");
    expect((await readEffort(root, effortId))?.dispatch_issue).toBe(DISPATCH_ISSUE);
    out.length = 0;

    // 6. RECONCILE — status with GH context shows the execution artifact
    expect(
      await managerCommand(
        ["status", effortId],
        deps({
          gh: {
            exec: makeGhExec(DISPATCH_ISSUE, "CLOSED"),
            repo: "reddb-io/red-skills",
            cwd: "/repo",
          },
        }),
      ),
    ).toBe(0);
    const reconciledBrief = brief(out);
    expect(reconciledBrief.execution_state).toBe("closed");
    out.length = 0;

    // 7. COMPLETED — end the effort; active → completed, lease released
    expect(await managerCommand(["end", effortId], deps())).toBe(0);
    expect(brief(out).lifecycle).toBe("completed");
    expect(await readLease(root, effortId)).toBeNull();
    expect((await readEffort(root, effortId))?.lifecycle).toBe("completed");

    // 8. CHECKPOINT — export the completed portfolio; the effort survives export
    const { document, checkpoint } = await exportCheckpoint(root, {
      now,
      host: "laptop-A",
    });
    expect(checkpoint.meta.effort_count).toBe(1);
    expect(checkpoint.efforts[0]?.effort_id).toBe(effortId);
    expect(checkpoint.efforts[0]?.lifecycle).toBe("completed");
    expect(document).not.toContain("manager.lease");
  });

  // ── Five-state lifecycle ───────────────────────────────────────────────────

  it("five-state lifecycle: inbox → active → paused → active → completed, plus abandoned", async () => {
    const root = await makeRoot();

    const effort = await startEffort({ root, intent: "five-state proof", now });
    expect(effort.lifecycle).toBe("inbox");

    // inbox → active
    const { effort: active } = await manageEffort(root, effort, { now, host: "h1" });
    expect(active.lifecycle).toBe("active");

    // active → paused (no command yet; use the store directly)
    const paused = await saveEffort(root, { ...active, lifecycle: "paused" }, { now });
    expect(paused.lifecycle).toBe("paused");
    expect((await readEffort(root, effort.effort_id))?.lifecycle).toBe("paused");

    // paused → active (reclaim the expired lease — set ttlMs=0 to expire the existing)
    const { effort: reactivated } = await manageEffort(root, paused, {
      now,
      host: "h1",
      ttlMs: 0,
    });
    // TTL=0 expired immediately; the acquire is a stale-reclaim path, so it re-activates
    expect(reactivated.lifecycle).toBe("active");

    // active → completed
    const completed = await endEffort(root, reactivated, { now });
    expect(completed.lifecycle).toBe("completed");
    expect((await readEffort(root, effort.effort_id))?.lifecycle).toBe("completed");
    expect(await readLease(root, effort.effort_id)).toBeNull();

    // abandoned — a separate effort goes inbox → active → abandoned via store
    const effort2 = await startEffort({ root, intent: "to be abandoned", now });
    const { effort: active2 } = await manageEffort(root, effort2, { now, host: "h1" });
    const abandoned = await saveEffort(root, { ...active2, lifecycle: "abandoned" }, { now });
    expect(abandoned.lifecycle).toBe("abandoned");
    expect((await readEffort(root, effort2.effort_id))?.lifecycle).toBe("abandoned");
  });

  // ── Lease fail-closed ──────────────────────────────────────────────────────

  it("lease fail-closed: a live lease on a different host blocks acquisition", async () => {
    const root = await makeRoot();

    const effort = await startEffort({ root, intent: "contested effort", now });

    // session-A acquires the lease with a future expiry (1 hour from PINNED_NOW)
    const { effort: managed, lease: leaseA } = await manageEffort(root, effort, {
      now,
      host: "session-A",
      ttlMs: 3_600_000,
    });
    expect(leaseA.host).toBe("session-A");

    // session-B tries at the same pinned instant — before the 1h expiry — fail closed
    const fresh = await readEffort(root, effort.effort_id);
    await expect(
      manageEffort(root, fresh!, { now, host: "session-B" }),
    ).rejects.toBeInstanceOf(ManagerLeaseConflictError);

    // The stored effort is unchanged — session-B cannot sneak in a write
    expect((await readEffort(root, effort.effort_id))?.generation).toBe(managed.generation);
    expect((await readLease(root, effort.effort_id))?.host).toBe("session-A");
  });

  // ── Declarative-reconcile convergence with partial failure ─────────────────

  it("reconcile converges through partial failure: plan → apply → re-plan returns ok", async () => {
    const EFFORT_ID = "eff_reconcileproof0000000000";
    const effort = {
      effort_id: EFFORT_ID,
      name: "reconcile proof effort",
      intent: "prove declarative convergence",
      lifecycle: "active" as const,
      generation: 1,
      created_at: PINNED_NOW,
      updated_at: PINNED_NOW,
    };

    // Step 1: no map exists yet → create
    const plan1 = planMapPublish(effort, null);
    expect(plan1.action).toBe("create");

    // Step 2: simulate partial failure — the create succeeded (map number=42) but
    // the label apply failed, so the issue has no labels yet
    const plan2 = planMapPublish(effort, { number: 42, labels: [] });
    expect(plan2.action).toBe("update-labels");
    expect(plan2.mapNumber).toBe(42);
    expect(plan2.labelsToAdd).toContain(LABEL_MANAGER_MAP);

    // Step 3: idempotent check — re-running update-labels with the same state still
    // returns update-labels (not create); the partial failure did not regress to "create"
    const plan3 = planMapPublish(effort, { number: 42, labels: [] });
    expect(plan3.action).toBe("update-labels");

    // Step 4: apply the labels; re-plan → ok (converged)
    const plan4 = planMapPublish(effort, { number: 42, labels: [LABEL_MANAGER_MAP] });
    expect(plan4.action).toBe("ok");
    expect(plan4.mapNumber).toBe(42);
  });

  // ── Rename-rejoin ──────────────────────────────────────────────────────────

  it("rename-rejoin: the map issue is matched by effort-id marker after the effort is renamed", async () => {
    // 26-char suffix: a=1…z=26 satisfies the isEffortId pattern
    const EFFORT_ID = "eff_abcdefghijklmnopqrstuvwxyz";
    const original = {
      effort_id: EFFORT_ID,
      name: "original effort name",
      intent: "original intent text",
      lifecycle: "active" as const,
      generation: 1,
      created_at: PINNED_NOW,
      updated_at: PINNED_NOW,
    };

    // The map was published for the original effort — its body embeds the effort-id marker
    const originalBody = buildMapBody(original);
    const originalTitle = buildMapTitle(original);
    expect(extractEffortIdFromBody(originalBody)).toBe(EFFORT_ID);
    expect(originalTitle).toBe("[manager] original effort name");

    // Simulate the operator renaming the effort
    const renamed = { ...original, name: "new effort name after rename", generation: 2 };
    const renamedBody = buildMapBody(renamed);
    const renamedTitle = buildMapTitle(renamed);

    // The marker in the new body still carries the SAME effort-id
    expect(extractEffortIdFromBody(renamedBody)).toBe(EFFORT_ID);
    expect(renamedTitle).toBe("[manager] new effort name after rename");

    // The OLD body still allows the reconciler to find the map by marker — the
    // idempotence key (effort-id) is stable through renames
    expect(extractEffortIdFromBody(originalBody)).toBe(EFFORT_ID);

    // Crucially: the reconciler does NOT plan "create" when the existing map's
    // body contains the effort-id marker — even though the title changed.
    // The caller finds the issue by marker and passes it as `existing`.
    const planAfterRename = planMapPublish(renamed, { number: 42, labels: [LABEL_MANAGER_MAP] });
    expect(planAfterRename.action).toBe("ok");
    expect(planAfterRename.mapNumber).toBe(42);

    // A null existing (marker not found) is the only path that triggers create
    const planIfLost = planMapPublish(renamed, null);
    expect(planIfLost.action).toBe("create");
  });

  // ── Checkpoint export / import round-trip ─────────────────────────────────

  it("checkpoint export/import round-trip: destination host becomes the single active writer", async () => {
    const src = await makeRoot();
    const dst = await makeRoot();

    // Source host: mint two efforts
    const e1 = await startEffort({ root: src, intent: "first effort", now });
    const e2 = await startEffort({ root: src, intent: "second effort", now });

    // Export from source
    const { document, checkpoint } = await exportCheckpoint(src, { now, host: "source-host" });
    expect(checkpoint.meta.effort_count).toBe(2);
    expect(document).not.toContain("manager.lease");

    // Import on destination — generation advances beyond both source records
    const result = await importCheckpoint(dst, document, { now, host: "destination-host" });
    expect(result.host).toBe("destination-host");
    expect(result.imported).toHaveLength(2);

    const dst1 = await readEffort(dst, e1.effort_id);
    expect(dst1?.generation).toBe(e1.generation + 1);
    const dst2 = await readEffort(dst, e2.effort_id);
    expect(dst2?.generation).toBe(e2.generation + 1);

    // Both destination efforts have leases held by the destination host
    const lease1 = await readLease(dst, e1.effort_id);
    expect(lease1?.host).toBe("destination-host");
    const lease2 = await readLease(dst, e2.effort_id);
    expect(lease2?.host).toBe("destination-host");
  });

  // ── Dogfood scenario ───────────────────────────────────────────────────────

  it("dogfood scenario: Manager tracks a real RedSkills effort from intent to completion", async () => {
    // This scenario mimics the operator dogfood run (acceptance criterion 3).
    // The effort is representative of a real low-risk RedSkills task: adding a
    // new skill doc to the /writing-for-agents writing convention guide.
    const root = await makeRoot();
    const out: string[] = [];
    const err: string[] = [];
    const deps = (extra: Parameters<typeof managerCommand>[1] = {}) =>
      makeDeps(root, out, err, extra);
    const DOGFOOD_ISSUE = 2297;

    // Operator types the intent; the Manager mints an effort in inbox
    expect(
      await managerCommand(
        ["document the S7 acceptance harness as a RedSkills engineering skill"],
        deps(),
      ),
    ).toBe(0);
    const mintedBrief = brief(out);
    const effortId = String(mintedBrief.effort_id);
    expect(mintedBrief.lifecycle).toBe("inbox");
    expect(mintedBrief.name).toBe("document the S7 acceptance harness as");
    out.length = 0;

    // ask-red classifies as "afk" (autonomous skill); the Manager records the route
    expect(await managerCommand(["route", effortId, "afk"], deps())).toBe(0);
    expect((await readEffort(root, effortId))?.route).toBe("afk");
    out.length = 0;

    // Operator resumes: inbox → active, lease acquired on this host
    expect(await managerCommand(["resume", effortId], deps({ host: "operator-laptop" }))).toBe(0);
    expect(brief(out).lifecycle).toBe("active");
    expect((await readLease(root, effortId))?.host).toBe("operator-laptop");
    out.length = 0;

    // Operator dispatches the effort as an autonomous execution via fake GH
    expect(
      await managerCommand(
        ["dispatch", effortId],
        deps({
          host: "operator-laptop",
          gh: {
            exec: makeGhExec(DOGFOOD_ISSUE, "OPEN"),
            repo: "reddb-io/red-skills",
            cwd: "/repo",
          },
        }),
      ),
    ).toBe(0);
    const dispatched = brief(out);
    expect(dispatched.execution_issue).toBe(DOGFOOD_ISSUE);
    expect(dispatched.execution_state).toBe("open");
    expect((await readEffort(root, effortId))?.dispatch_issue).toBe(DOGFOOD_ISSUE);
    out.length = 0;

    // Operator checks status later; the execution issue closed (agent delivered)
    expect(
      await managerCommand(
        ["status", effortId],
        deps({
          gh: {
            exec: makeGhExec(DOGFOOD_ISSUE, "CLOSED"),
            repo: "reddb-io/red-skills",
            cwd: "/repo",
          },
        }),
      ),
    ).toBe(0);
    const statusBrief = brief(out);
    expect(statusBrief.state_source).toBe("reconciled");
    expect(statusBrief.execution_state).toBe("closed");
    out.length = 0;

    // Operator ends the effort: active → completed
    expect(await managerCommand(["end", effortId], deps())).toBe(0);
    expect(brief(out).lifecycle).toBe("completed");
    expect(await readLease(root, effortId)).toBeNull();

    // The portfolio holds a completed effort; no errors encountered
    expect(err.join("")).toBe("");
  });
});
