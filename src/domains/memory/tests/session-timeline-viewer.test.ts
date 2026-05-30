import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { appendMemoryEvent, hookLifecycleToMemoryEvent } from "../src/memory-events.js";
import { buildSessionTimeline } from "../src/session-timeline.js";
import { buildSessionTimelineViewerArtifact } from "../src/session-timeline-viewer.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "memory-session-timeline-viewer-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { hooks: true, skillTelemetry: true });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  return { root, store };
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory session timeline viewer", () => {
  test("renders a self-contained replay viewer from session timeline evidence", async () => {
    const { store } = await graphRoot();
    await appendMemoryEvent(
      store,
      hookLifecycleToMemoryEvent(
        {
          event: "Stop",
          runner: "codex",
          sessionId: "session-viewer",
          cwd: "/repo",
          changedFiles: [],
          transcriptText: "We decided to avoid raw transcript replay.",
        },
        { noop: false, stored: 1 },
        { timestamp: "2026-05-22T16:03:00.000Z", eventId: "hook:stop:viewer" },
      ),
    );
    const timeline = await buildSessionTimeline(store, { sessionId: "session-viewer" });

    const artifact = buildSessionTimelineViewerArtifact(timeline);

    expect(artifact.contract).toEqual({
      name: "memory.session_timeline.viewer",
      version: "memory.session_timeline.viewer.v1",
      consumes: "memory.session_timeline.v1",
    });
    expect(artifact.html).toContain("<!doctype html>");
    expect(artifact.html).toContain("Session Timeline");
    expect(artifact.html).toContain("Stop hook");
    expect(artifact.html).toContain("session-viewer");
    expect(artifact.html).toContain('id="session-timeline-data"');
    expect(artifact.html).not.toContain("avoid raw transcript replay");
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "CLI writes a local session timeline viewer",
    async () => {
      const { root, store } = await graphRoot();
      await appendMemoryEvent(
        store,
        hookLifecycleToMemoryEvent(
          {
            event: "PostToolUse",
            runner: "claude",
            sessionId: "session-cli-viewer",
            cwd: root,
            changedFiles: [join(root, "src/auth.ts")],
          },
          { noop: false, indexed: 1 },
          { timestamp: "2026-05-22T16:04:00.000Z", eventId: "hook:post:viewer" },
        ),
      );
      await store.close();
      stores.pop();

      const out = join(root, "session-timeline.html");
      const result = runMemory([
        "session",
        "timeline-viewer",
        "--root",
        root,
        "--session",
        "session-cli-viewer",
        "--out",
        out,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: session timeline viewer written");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Session Timeline");
      expect(html).toContain("PostToolUse hook");
      expect(html).toContain("session-timeline-data");
    },
    TIMEOUT,
  );
});
