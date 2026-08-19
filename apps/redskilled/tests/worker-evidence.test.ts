// What a dead Worker leaves behind, and what a TTL is allowed to take (issue
// #4018, ADR 0149 §2/§4).
//
// The workspace is expensive and regenerable and goes with the Worker (#4017).
// These three files are the other half: cheap, irreplaceable, and the only
// thing a human has left after a reboot cleared OS temporary storage. So the
// assertions are made against a REAL Worker death — the daemon admits one, it
// writes a log, it dies, and the lane is inspected — and against a prune that
// is handed a live Worker and a dead one at once.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decode } from "@reddb-io/toon";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { cleanupWorkflowWorker, type ActiveWorkflowWorker } from "../src/acp-worker-lifecycle.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { materializeWorkerWorkspace, workerWorkspaceRoot } from "../src/worker-workspace.js";
import { encodeHostWorkerId, mintHostWorkerId } from "../src/worker-launch.js";
import {
  DEFAULT_WORKER_EVIDENCE_TTL_MS,
  pruneWorkerEvidence,
  retainWorkerEvidence,
  WORKER_EVIDENCE_LOG_FILE,
  WORKER_EVIDENCE_VERDICT_FILE,
  workerEvidenceDir,
  workerEvidenceRoot,
  WorkerEvidenceError,
} from "../src/worker-evidence.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A lane for a Worker that already died, at a stated birth instant. */
async function deadLane(root: string, bornAtMs: number, outcome = "idle-policy"): Promise<string> {
  const workerId = encodeHostWorkerId(bornAtMs);
  await retainWorkerEvidence({
    root,
    verdict: { workerId, outcome, diedAt: new Date(bornAtMs).toISOString() },
  });
  return workerId;
}

describe("where a Worker's evidence lives", () => {
  it("is the operator's ~/.red/tmp/workers, never the daemon's durable home", () => {
    expect(workerEvidenceRoot("/home/ada")).toBe("/home/ada/.red/tmp/workers");
    expect(workerEvidenceDir(workerEvidenceRoot("/home/ada"), "0aBcDeF"))
      .toBe("/home/ada/.red/tmp/workers/0aBcDeF");
  });

  it("leaves the daemon's own log where ADR 0130 Amendment 2 put it", () => {
    // The evidence lane is a NEW place; it moves nothing. `~/.red/redskilled/`
    // stays the durable home for the daemon's own log and registrations.
    const paths = resolveRedskilledPaths({ homeDir: "/home/ada", runtimeDir: "/run/user/1000" });
    expect(paths.eventLanePath).toBe("/home/ada/.red/redskilled/redskilled.log.toonl");
    expect(redskilledHomeDir("/home/ada")).toBe("/home/ada/.red/redskilled");
    expect(paths.eventLanePath.startsWith(workerEvidenceRoot("/home/ada"))).toBe(false);
  });

  it("refuses an id that would escape the lane rather than resolving it", () => {
    const root = workerEvidenceRoot("/home/ada");
    expect(() => workerEvidenceDir(root, "../elsewhere")).toThrow(WorkerEvidenceError);
    expect(() => workerEvidenceDir(root, "  ")).toThrow(WorkerEvidenceError);
  });
});

describe("what a dead Worker leaves in its lane", () => {
  it("holds the log, the runner's session artifact and the verdict", async () => {
    const home = await scratch("redskilled-evidence-home-");
    const runner = await scratch("redskilled-runner-session-");
    const root = workerEvidenceRoot(home);
    const workerId = encodeHostWorkerId(1_760_000_000_000);

    const logPath = join(await scratch("redskilled-worker-log-"), "worker.log.toonl");
    await writeFile(logPath, "event: birth\nevent: death\n");
    const artifactPath = join(runner, "01H-session.jsonl");
    await writeFile(artifactPath, '{"role":"assistant"}\n');

    const retained = await retainWorkerEvidence({
      root,
      logPath,
      verdict: {
        workerId,
        outcome: "completion",
        diedAt: "2026-08-19T05:00:00.000Z",
        workspacePath: "/tmp/red-skills-1000/workers/xxxxxxx",
        publicSessionId: "session-4018",
        sessionArtifact: { provider: "claude", availability: "available", reference: artifactPath },
      },
    });

    expect(retained.evidenceDir).toBe(join(root, workerId));
    expect(retained.log).toBe("copied");
    expect(retained.sessionArtifact).toBe("copied");
    expect(await readFile(join(retained.evidenceDir, WORKER_EVIDENCE_LOG_FILE), "utf8"))
      .toBe("event: birth\nevent: death\n");
    expect(await readFile(join(retained.evidenceDir, "session-artifact.jsonl"), "utf8"))
      .toBe('{"role":"assistant"}\n');

    const verdict = decode(await readFile(retained.verdictPath, "utf8")) as Record<string, unknown>;
    expect(verdict).toMatchObject({
      worker_id: workerId,
      outcome: "completion",
      died_at: "2026-08-19T05:00:00.000Z",
      released_workspace_path: "/tmp/red-skills-1000/workers/xxxxxxx",
      log: "copied",
      session_artifact: "copied",
    });
  });

  it("still writes the verdict for a Worker that died before it logged anything", async () => {
    const home = await scratch("redskilled-evidence-home-");
    const root = workerEvidenceRoot(home);
    const workerId = encodeHostWorkerId(1_760_000_000_001);

    const retained = await retainWorkerEvidence({
      root,
      logPath: join(home, "never-written.toonl"),
      verdict: {
        workerId,
        outcome: "session-error",
        diedAt: "2026-08-19T05:00:01.000Z",
        sessionArtifact: { provider: "redskills-native", availability: "absent" },
      },
    });

    expect(retained.log).toBe("unreadable");
    expect(retained.sessionArtifact).toBe("absent");
    expect(await readdir(retained.evidenceDir)).toEqual([WORKER_EVIDENCE_VERDICT_FILE]);
    const verdict = decode(await readFile(retained.verdictPath, "utf8")) as Record<string, unknown>;
    expect(verdict).toMatchObject({ outcome: "session-error", log: "unreadable", session_artifact: "absent" });
  });
});

describe("pruning the evidence lane by its host TTL", () => {
  it("removes a dead lane at TTL 0, keeps the same lane under the default TTL", async () => {
    const home = await scratch("redskilled-evidence-home-");
    const root = workerEvidenceRoot(home);
    const bornAtMs = 1_760_000_000_000;
    const workerId = await deadLane(root, bornAtMs);

    const kept = await pruneWorkerEvidence({ root, now: () => bornAtMs + 1_000, live: [] });
    expect(kept.ttlMs).toBe(DEFAULT_WORKER_EVIDENCE_TTL_MS);
    expect(kept.pruned).toBe(0);
    expect(kept.entries).toEqual([expect.objectContaining({ workerId, disposition: "retained" })]);
    expect(existsSync(join(root, workerId))).toBe(true);

    const swept = await pruneWorkerEvidence({ root, ttlMs: 0, now: () => bornAtMs + 1_000, live: [] });
    expect(swept.pruned).toBe(1);
    expect(swept.entries).toEqual([expect.objectContaining({ workerId, disposition: "pruned" })]);
    expect(existsSync(join(root, workerId))).toBe(false);
  });

  it("never removes a live Worker's lane, however old the name says it is", async () => {
    const home = await scratch("redskilled-evidence-home-");
    const root = workerEvidenceRoot(home);
    const ancient = 1_000_000_000_000;
    const live = await deadLane(root, ancient, "still-running");
    const dead = await deadLane(root, ancient + 1);

    const report = await pruneWorkerEvidence({ root, ttlMs: 0, now: () => ancient + 10_000, live: [live] });
    expect(report.entries).toEqual([
      expect.objectContaining({ workerId: live, disposition: "live" }),
      expect.objectContaining({ workerId: dead, disposition: "pruned" }),
    ]);
    expect(existsSync(join(root, live))).toBe(true);
    expect(existsSync(join(root, dead))).toBe(false);
  });

  it("retains a directory whose name carries no birth instant, and says so", async () => {
    const home = await scratch("redskilled-evidence-home-");
    const root = workerEvidenceRoot(home);
    await mkdir(join(root, "h1a2b"), { recursive: true });
    await writeFile(join(root, "h1a2b", "worker.log.toonl"), "from an older id scheme\n");

    const report = await pruneWorkerEvidence({ root, ttlMs: 0, now: () => 1_760_000_000_000 });
    expect(report.entries).toEqual([expect.objectContaining({ workerId: "h1a2b", disposition: "unrecognized" })]);
    expect(existsSync(join(root, "h1a2b"))).toBe(true);
  });

  it("reports an empty sweep for a host that has never lost a Worker", async () => {
    const home = await scratch("redskilled-evidence-home-");
    const report = await pruneWorkerEvidence({ root: workerEvidenceRoot(home), ttlMs: 0 });
    expect(report).toMatchObject({ scanned: 0, pruned: 0, entries: [] });
  });
});

describe("a Worker's death, from the daemon's cleanup path", () => {
  it("keeps the evidence and lets the workspace go, then prunes what has expired", async () => {
    const home = await scratch("redskilled-evidence-home-");
    const tmpRoot = await scratch("redskilled-tmp-root-");
    const root = workerEvidenceRoot(home);
    const workspaceRoot = workerWorkspaceRoot({ tmpDir: tmpRoot, uid: 4018 });

    // One Worker that died long ago, so this death's prune has something to take.
    const ancient = await deadLane(root, 1_000_000_000_000);

    // Minted at the real instant, so this Worker's own lane is younger than the
    // TTL its death sweeps with — a lane the sweep it triggered would eat is a
    // retention policy that keeps nothing.
    const workerId = mintHostWorkerId([]);
    const workspace = await materializeWorkerWorkspace({
      root: workspaceRoot,
      workerId,
      projectWorkspacePath: await scratch("redskilled-not-a-repo-"),
    });
    // The Worker's log lives INSIDE the workspace about to be deleted: the case
    // that decides whether retention happens before or after the release.
    const logPath = join(workspace.workspacePath, "worker.log.toonl");
    await writeFile(logPath, "event: birth\n");
    const artifactPath = join(await scratch("redskilled-runner-session-"), "session.jsonl");
    await writeFile(artifactPath, '{"role":"user"}\n');

    const active = new Map<string, ActiveWorkflowWorker>();
    const worker = {
      workerId,
      workspace,
      evidence: {
        root,
        ttlMs: DEFAULT_WORKER_EVIDENCE_TTL_MS,
        logPath,
        sessionArtifact: { provider: "claude", availability: "available", reference: artifactPath },
      },
      downstreamSessionId: "downstream-session",
      connection: { close: () => undefined },
      socket: new Socket(),
      endpoint: join(tmpRoot, "unused-test-endpoint.sock"),
      publicSessionId: "public-session-4018",
      notify: async () => undefined,
      cancelled: false,
      cleaned: false,
    } as unknown as ActiveWorkflowWorker;
    active.set("public-session-4018", worker);

    cleanupWorkflowWorker("public-session-4018", worker, active, "idle-policy");

    const evidenceDir = join(root, workerId);
    await vi.waitFor(() => {
      expect(existsSync(join(evidenceDir, WORKER_EVIDENCE_VERDICT_FILE))).toBe(true);
      expect(existsSync(workspace.workspacePath)).toBe(false);
      expect(existsSync(join(root, ancient))).toBe(false);
    });

    expect(await readFile(join(evidenceDir, WORKER_EVIDENCE_LOG_FILE), "utf8")).toBe("event: birth\n");
    expect(await readFile(join(evidenceDir, "session-artifact.jsonl"), "utf8")).toBe('{"role":"user"}\n');
    const verdict = decode(await readFile(join(evidenceDir, WORKER_EVIDENCE_VERDICT_FILE), "utf8")) as
      Record<string, unknown>;
    expect(verdict).toMatchObject({
      worker_id: workerId,
      outcome: "idle-policy",
      public_session_id: "public-session-4018",
      released_workspace_path: workspace.workspacePath,
      log: "copied",
      session_artifact: "copied",
    });
    expect(existsSync(evidenceDir)).toBe(true);
  });
});
