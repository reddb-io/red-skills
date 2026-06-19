import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBrainDashboard, buildBrainDashboardArtifact, serveBrainDashboardHtml } from "../src/dashboard.js";
import { BrainStore } from "../src/store.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "brain-dashboard-"));
  roots.push(root);
  await mkdir(join(root, ".red", "brain"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runBrain(args: string[], root: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    env: { ...process.env, RED_BRAIN_ROOT: root },
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function seedBrain(root: string): Promise<void> {
  const store = await BrainStore.open({ uri: `file://${join(root, ".red", "brain", "brain.rdb")}` });
  try {
    const decision = await store.capture({
      title: "Use channel bridge",
      kind: "decision",
      tags: ["dashboard"],
      content: "Use the channel bridge behind Brain instead of exposing raw messaging tools.",
    });
    const event = await store.capture({
      title: "Slack release event",
      kind: "event",
      tags: ["channel-event"],
      content: "Release train is green.",
      metadata: {
        timestamp: "2026-06-01T08:00:00.000Z",
        platform: "slack",
        event_type: "message",
        target: "#eng",
      },
    });
    await store.link({
      from: event.rid,
      to: decision.rid,
      kind: "supports",
      reason: "The event supports the dashboard decision.",
    });
  } finally {
    await store.close();
  }
}

describe("Brain dashboard", () => {
  it("builds a curated daily-driver model over KPIs, decisions, and graph edges", async () => {
    const root = await tempRoot();
    await seedBrain(root);
    const store = await BrainStore.open({ uri: `file://${join(root, ".red", "brain", "brain.rdb")}` });
    try {
      const dashboard = await buildBrainDashboard(store, {
        project: "brain-dashboard-test",
        rootDir: root,
        now: Date.UTC(2026, 5, 13, 12),
      });

      expect(dashboard).toMatchObject({
        schema_version: "brain.dashboard.v1",
        generated_at: "2026-06-13T12:00:00.000Z",
        project: "brain-dashboard-test",
        stats: {
          decisions: 1,
          events: 1,
          supports: 1,
        },
        kpis: {
          events_daily: { total: 1 },
          events_by_platform: { total: 1 },
          events_by_type: { total: 1 },
        },
      });
      expect(dashboard.recent_decisions[0]).toMatchObject({
        title: "Use channel bridge",
        connection_counts: { supports: 1 },
      });
      expect(dashboard.recent_connections[0]).toMatchObject({
        kind: "supports",
        from: { title: "Slack release event" },
        to: { title: "Use channel bridge" },
      });

      const artifact = buildBrainDashboardArtifact(dashboard);
      expect(artifact.contract).toEqual({
        name: "brain.dashboard.viewer",
        version: "brain.dashboard.viewer.v1",
        consumes: "brain.dashboard.v1",
      });
      expect(artifact.html).toContain("Brain Dashboard");
      expect(artifact.html).toContain("Event KPIs");
      expect(artifact.html).toContain("Recent Decisions");
      expect(artifact.html).toContain('id="brain-dashboard-data"');
      expect(artifact.html).toContain("red-hermes web surface");
    } finally {
      await store.close();
    }
  });

  it("CLI writes self-contained HTML and emits dashboard JSON", async () => {
    const root = await tempRoot();
    await seedBrain(root);

    const out = join(root, "brain-dashboard.html");
    const html = runBrain(["dashboard", "--out", out], root);
    expect(html.status, html.stderr).toBe(0);
    expect(html.stdout).toContain("brain: dashboard written");
    const content = await readFile(out, "utf8");
    expect(content).toContain("brain-dashboard-data");

    const json = runBrain(["dashboard", "--json"], root);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      schema_version: "brain.dashboard.v1",
      stats: { events: 1, decisions: 1 },
    });
  });

  it("serves the dashboard on a loopback URL", async () => {
    const server = await serveBrainDashboardHtml("<!doctype html><title>Brain Dashboard</title>", {
      port: 0,
    });
    try {
      const address = server.address();
      if (address == null || typeof address === "string") throw new Error("expected TCP server address");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Brain Dashboard");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
