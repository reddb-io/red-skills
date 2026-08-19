import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANAGER_LEASE_SCHEMA,
  MANAGER_LEASE_SCHEMA_VERSION,
  LEASE_DEFAULT_TTL_MS,
  ManagerLeaseConflictError,
  ManagerLifecycleError,
  decodeLeaseDocument,
  encodeLeaseDocument,
  isLeaseExpired,
  readLease,
  releaseLease,
  manageEffort,
  endEffort,
  type EffortLease,
} from "../src/core/manager/effort-lease.js";
import {
  ManagerGenerationError,
  readEffort,
  startEffort,
  type EffortRecord,
} from "../src/core/manager/effort-store.js";
import { encodeRecords, parseRecords } from "@reddb-io/toon";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-lease-"));
});

afterEach(() => {
  root = "";
});

// ── Lease document encoding ────────────────────────────────────────────────

describe("lease document", () => {
  const lease: EffortLease = {
    effort_id: "eff_abcdefghijklmnopqrstuvwxyz",
    host: "builder-1",
    generation: 1,
    acquired_at: "2026-07-21T00:00:00.000Z",
    expires_at: "2026-07-21T01:00:00.000Z",
  };

  it("writes a versioned schema header ahead of the lease row", () => {
    const records = parseRecords(encodeLeaseDocument(lease));
    expect(records[0]).toMatchObject({
      kind: "manager.lease.schema",
      schema: MANAGER_LEASE_SCHEMA,
      version: MANAGER_LEASE_SCHEMA_VERSION,
    });
    expect(records[1]).toMatchObject({ kind: "manager.lease", effort_id: lease.effort_id });
  });

  it("round-trips through the lease encoding", () => {
    expect(decodeLeaseDocument(encodeLeaseDocument(lease))).toEqual(lease);
  });

  it("refuses a document whose schema version is not the one this bundle owns", () => {
    const foreign = encodeRecords([
      { kind: "manager.lease.schema", schema: MANAGER_LEASE_SCHEMA, version: 99 },
      { kind: "manager.lease", ...lease },
    ], {});
    expect(() => decodeLeaseDocument(foreign)).toThrow(/schema version/);
  });
});

// ── isLeaseExpired ─────────────────────────────────────────────────────────

describe("isLeaseExpired", () => {
  it("returns false when the lease expires in the future", () => {
    const lease: EffortLease = {
      effort_id: "eff_abc",
      host: "h",
      generation: 1,
      acquired_at: "2026-07-21T00:00:00.000Z",
      expires_at: "2026-07-21T02:00:00.000Z",
    };
    expect(isLeaseExpired(lease, new Date("2026-07-21T01:00:00.000Z"))).toBe(false);
  });

  it("returns true when the lease expires at or before now", () => {
    const lease: EffortLease = {
      effort_id: "eff_abc",
      host: "h",
      generation: 1,
      acquired_at: "2026-07-21T00:00:00.000Z",
      expires_at: "2026-07-21T01:00:00.000Z",
    };
    expect(isLeaseExpired(lease, new Date("2026-07-21T01:00:00.000Z"))).toBe(true);
    expect(isLeaseExpired(lease, new Date("2026-07-21T02:00:00.000Z"))).toBe(true);
  });
});

// ── readLease ──────────────────────────────────────────────────────────────

describe("readLease", () => {
  it("returns null for an effort that has no lease", async () => {
    expect(await readLease(root, "eff_missing")).toBeNull();
  });
});

// ── releaseLease ───────────────────────────────────────────────────────────

describe("releaseLease", () => {
  it("is idempotent: releasing an absent lease does not throw", async () => {
    await expect(releaseLease(root, "eff_noexist")).resolves.toBeUndefined();
  });
});

// ── manageEffort ───────────────────────────────────────────────────────────

describe("manageEffort", () => {
  const FAKE_HOST = "test-host";
  const AT = "2026-07-21T10:00:00.000Z";
  const now = () => new Date(AT);
  const opts = { now, host: FAKE_HOST, ttlMs: LEASE_DEFAULT_TTL_MS };

  it("transitions an inbox effort to active and writes a lease at the effort's generation", async () => {
    const effort = await startEffort({ root, intent: "build something", now });
    expect(effort.lifecycle).toBe("inbox");
    expect(effort.generation).toBe(1);

    const { effort: managed, lease } = await manageEffort(root, effort, opts);

    expect(managed.lifecycle).toBe("active");
    expect(managed.generation).toBe(2);
    expect(lease.host).toBe(FAKE_HOST);
    expect(lease.generation).toBe(2);
    expect(lease.acquired_at).toBe(AT);

    const stored = await readEffort(root, effort.effort_id);
    expect(stored?.lifecycle).toBe("active");
    expect(stored?.generation).toBe(2);
  });

  it("transitions a paused effort to active", async () => {
    const effort = await startEffort({ root, intent: "paused one", now });
    // Put it in paused state directly via saveEffort
    const { saveEffort } = await import("../src/core/manager/effort-store.js");
    const paused = await saveEffort(root, { ...effort, lifecycle: "paused" }, { now });

    const { effort: managed } = await manageEffort(root, paused, opts);
    expect(managed.lifecycle).toBe("active");
  });

  it("refuses to manage an already-active effort (idempotent guard)", async () => {
    const effort = await startEffort({ root, intent: "active already", now });
    const { effort: managed } = await manageEffort(root, effort, opts);
    await expect(manageEffort(root, managed, opts)).rejects.toBeInstanceOf(ManagerLifecycleError);
  });

  it("refuses to manage a completed effort", async () => {
    const effort = await startEffort({ root, intent: "done already", now });
    const { saveEffort } = await import("../src/core/manager/effort-store.js");
    const completed = await saveEffort(root, { ...effort, lifecycle: "completed" }, { now });
    await expect(manageEffort(root, completed, opts)).rejects.toBeInstanceOf(ManagerLifecycleError);
  });

  it("writes the lease file under the leases lane", async () => {
    const effort = await startEffort({ root, intent: "check lease file", now });
    await manageEffort(root, effort, opts);
    const stored = await readLease(root, effort.effort_id);
    expect(stored).not.toBeNull();
    expect(stored?.host).toBe(FAKE_HOST);
  });

  it("fails closed when a live lease is held by a different host", async () => {
    const effort = await startEffort({ root, intent: "contested", now });
    await manageEffort(root, effort, { ...opts, host: "session-a" });

    const effort2 = await readEffort(root, effort.effort_id);
    await expect(manageEffort(root, effort2!, { ...opts, host: "session-b" })).rejects.toBeInstanceOf(
      ManagerLeaseConflictError,
    );
  });

  it("reclaims a TTL-expired lease with a generation bump", async () => {
    const effort = await startEffort({ root, intent: "expired lease", now });
    // Acquire with a very short TTL so it expires immediately
    const past = new Date(AT);
    await manageEffort(root, effort, { host: "session-a", now: () => past, ttlMs: 0 });

    const effort2 = await readEffort(root, effort.effort_id);
    const genBefore = effort2!.generation;

    // Reclaim: lease is expired
    const later = new Date(past.getTime() + 1000);
    const { effort: reclaimed, lease } = await manageEffort(root, effort2!, {
      host: "session-b",
      now: () => later,
      ttlMs: LEASE_DEFAULT_TTL_MS,
    });

    expect(reclaimed.generation).toBe(genBefore + 1);
    expect(lease.host).toBe("session-b");
    expect(lease.generation).toBe(genBefore + 1);
  });

  it("after stale reclaim, the old writer's saveEffort fails with ManagerGenerationError", async () => {
    const effort = await startEffort({ root, intent: "reclaim fences old writer", now });
    const past = new Date(AT);
    const { effort: oldManaged } = await manageEffort(root, effort, {
      host: "session-a",
      now: () => past,
      ttlMs: 0,
    });
    // old writer holds oldManaged (generation N)
    const effort2 = await readEffort(root, effort.effort_id);
    const later = new Date(past.getTime() + 1000);
    // session-b reclaims, bumps to N+1
    await manageEffort(root, effort2!, { host: "session-b", now: () => later });

    // old writer tries to save with its stale generation → fails closed
    const { saveEffort } = await import("../src/core/manager/effort-store.js");
    await expect(
      saveEffort(root, { ...oldManaged, name: "stale write" }),
    ).rejects.toBeInstanceOf(ManagerGenerationError);
  });
});

// ── endEffort ──────────────────────────────────────────────────────────────

describe("endEffort", () => {
  const FAKE_HOST = "test-host";
  const AT = "2026-07-21T10:00:00.000Z";
  const now = () => new Date(AT);
  const opts = { now, host: FAKE_HOST };

  it("transitions an active effort to completed and removes the lease", async () => {
    const effort = await startEffort({ root, intent: "finish me", now });
    const { effort: managed } = await manageEffort(root, effort, opts);
    expect(managed.lifecycle).toBe("active");

    const completed = await endEffort(root, managed, { now });
    expect(completed.lifecycle).toBe("completed");
    expect(completed.generation).toBe(managed.generation + 1);

    const stored = await readEffort(root, effort.effort_id);
    expect(stored?.lifecycle).toBe("completed");

    const lease = await readLease(root, effort.effort_id);
    expect(lease).toBeNull();
  });

  it("refuses to end an effort that is not active", async () => {
    const effort = await startEffort({ root, intent: "not active", now });
    await expect(endEffort(root, effort, { now })).rejects.toBeInstanceOf(ManagerLifecycleError);
  });

  it("releases the lease even when there is no lease file (idempotent)", async () => {
    const effort = await startEffort({ root, intent: "no lease", now });
    const { saveEffort } = await import("../src/core/manager/effort-store.js");
    const active = await saveEffort(root, { ...effort, lifecycle: "active" }, { now });
    // No lease file exists — end should still succeed
    await expect(endEffort(root, active, { now })).resolves.toMatchObject({ lifecycle: "completed" });
  });
});
