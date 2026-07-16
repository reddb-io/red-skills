import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  acquireIssueLease,
  createFsIssueLeaseStore,
  parseTrackerClaimRecords,
  renderTrackerClaimComment,
  retireIssueLease,
  type TrackerClaimComment,
  type TrackerClaimStore,
} from "./claim.js";

function memoryStore(
  existing: TrackerClaimComment[] = [],
): TrackerClaimStore & {
  posted: string[];
  conceded: string[];
} {
  let nextId = (existing.at(-1)?.id ?? 0) + 1;
  const posted: string[] = [];
  const conceded: string[] = [];
  return {
    posted,
    conceded,
    async postClaim(_issue, body) {
      posted.push(body);
      existing.push({ id: nextId, body });
      return nextId++;
    },
    async listClaims() {
      return existing.slice();
    },
    async concede(_issue, body) {
      conceded.push(body);
      existing.push({ id: nextId++, body });
    },
  };
}

async function tempLeaseRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "red-castle-tracker-claim-"));
}

describe("tracker dual lease", () => {
  it("acquires the local mkdir lease before posting the ADR 0066 claim marker", async () => {
    const root = await tempLeaseRoot();
    try {
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();

      const decision = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1", runner: "codex" },
        local,
        remote: store,
        liveness: () => "unknown",
      });

      expect(decision).toMatchObject({ verdict: "won", winner: "host:w1" });
      await expect(readFile(join(root, "1907", "owner"), "utf8")).resolves.toBe(
        "host:w1\n",
      );
      expect(store.posted[0]).toContain(
        "<!-- afk:claim v1 worker=host:w1 kind=claim runner=codex -->",
      );
      expect(
        parseTrackerClaimRecords(await store.listClaims(1907)),
      ).toMatchObject([{ worker: "host:w1", kind: "claim" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not steal a local mkdir lease unless supervisor liveness says dead", async () => {
    const root = await tempLeaseRoot();
    try {
      await mkdir(join(root, "1907"), { recursive: true });
      await writeFile(join(root, "1907", "owner"), "host:other\n");
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();

      const blocked = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1" },
        local,
        remote: store,
        liveness: () => "alive",
      });

      expect(blocked).toMatchObject({
        verdict: "lost",
        winner: "host:other",
        reason: "local lease owner is alive",
      });
      expect(store.posted).toHaveLength(0);
      await expect(readFile(join(root, "1907", "owner"), "utf8")).resolves.toBe(
        "host:other\n",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an older remote claim only from an injected dead liveness verdict", async () => {
    const oldClaim = {
      id: 1,
      body: renderTrackerClaimComment({ worker: "host:dead" }, "claim"),
      createdAt: "2000-01-01T00:00:00Z",
    };
    const liveStore = memoryStore([oldClaim]);
    const liveRoot = await tempLeaseRoot();
    try {
      const liveDecision = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1" },
        local: createFsIssueLeaseStore(liveRoot),
        remote: liveStore,
        liveness: () => "alive",
      });
      expect(liveDecision).toMatchObject({
        verdict: "lost",
        winner: "host:dead",
      });
      expect(liveStore.conceded).toHaveLength(1);
    } finally {
      await rm(liveRoot, { recursive: true, force: true });
    }

    const deadStore = memoryStore([oldClaim]);
    const deadRoot = await tempLeaseRoot();
    try {
      const deadDecision = await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1" },
        local: createFsIssueLeaseStore(deadRoot),
        remote: deadStore,
        liveness: (worker) => (worker === "host:dead" ? "dead" : "alive"),
      });
      expect(deadDecision).toMatchObject({
        verdict: "won",
        winner: "host:w1",
        recovered: ["host:dead"],
      });
    } finally {
      await rm(deadRoot, { recursive: true, force: true });
    }
  });

  it("graceful retirement concedes the remote claim and releases the local lease", async () => {
    const root = await tempLeaseRoot();
    try {
      const local = createFsIssueLeaseStore(root);
      const store = memoryStore();
      await acquireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1", runner: "codex" },
        local,
        remote: store,
        liveness: () => "unknown",
      });

      await retireIssueLease({
        issue: 1907,
        identity: { worker: "host:w1", runner: "codex" },
        local,
        remote: store,
      });

      expect(store.conceded).toHaveLength(1);
      expect(store.conceded[0]).toContain("kind=concede");
      await expect(
        readFile(join(root, "1907", "owner"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
