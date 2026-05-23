import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph, initMarkdownOnly } from "../src/init.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-context-status-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("memory status context CLI", () => {
  test("reports a JSON context posture for a graph project", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "CLAUDE.md"), "# Agent rules\n", "utf8");
    await mkdir(join(root, ".red", "adr"), { recursive: true });
    await writeFile(join(root, ".red", "CONTEXT.md"), "# Glossary\n", "utf8");
    await writeFile(join(root, ".red", "CONTEXT-MAP.md"), "# Map\n", "utf8");
    await writeFile(join(root, ".red", "adr", "0001-test.md"), "# ADR\n", "utf8");
    await mkdir(join(root, ".red", "agents"), { recursive: true });
    await mkdir(join(root, ".red", "wiki"), { recursive: true });
    await writeFile(join(root, ".red", "agents", "wiki.md"), "# Wiki agent\n", "utf8");
    await initGraph(root, { hooks: true, skillTelemetry: true });

    const result = runMemory(["status", "context", "--root", root, "--json"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);

    expect(body.state).toBe("ready");
    expect(body.memory.mode).toBe("graph");
    expect(body.memory.skillTelemetry).toBe(true);
    expect(body.memory.hooksEnabled).toEqual(["sessionStart", "postToolUse", "stop", "preCompact"]);
    expect(body.committedContext.agentRules).toBe("CLAUDE.md");
    expect(body.committedContext.domainGlossary).toBe(true);
    expect(body.committedContext.contextMap).toBe(true);
    expect(body.committedContext.adrCount).toBe(1);
    expect(body.wiki.state).toBe("ready");
    expect(body.score.value).toBe(body.score.max);
    expect(body.recommendations).toEqual([]);
  });

  test("explains missing posture pieces without requiring Memory init", async () => {
    const root = await tempRoot();

    const result = runMemory(["status", "context", "--root", root, "--json"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);

    expect(body.state).toBe("incomplete");
    expect(body.memory.mode).toBe("uninitialized");
    expect(body.wiki.state).toBe("absent");
    expect(body.score.value).toBeLessThan(body.score.max);
    expect(body.recommendations).toContain("add CLAUDE.md or AGENTS.md with agent rules");
    expect(body.recommendations).toContain("run `memory init --mode graph --skill-telemetry` when persistent graph recall is useful");
  });

  test("distinguishes markdown-only Memory from graph-ready context", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "AGENTS.md"), "# Agent rules\n", "utf8");
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "CONTEXT.md"), "# Glossary\n", "utf8");
    await initMarkdownOnly(root);

    const result = runMemory(["status", "context", "--root", root, "--json"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);

    expect(body.memory.mode).toBe("markdown-only");
    expect(body.memory.skillTelemetry).toBe(false);
    expect(body.memory.graphStoreExists).toBe(false);
    expect(body.recommendations).toContain("switch to graph mode when you need graph recall, ingest, telemetry, or curator evidence");
  });

  test("flags graph freshness as stale when source files are newer than the graph store", async () => {
    const root = await tempRoot();
    await writeFile(join(root, "CLAUDE.md"), "# Agent rules\n", "utf8");
    await mkdir(join(root, ".red", "adr"), { recursive: true });
    await writeFile(join(root, ".red", "CONTEXT.md"), "# Glossary\n", "utf8");
    await writeFile(join(root, ".red", "adr", "0001-test.md"), "# ADR\n", "utf8");
    await mkdir(join(root, ".red", "agents"), { recursive: true });
    await mkdir(join(root, ".red", "wiki"), { recursive: true });
    await writeFile(join(root, ".red", "agents", "wiki.md"), "# Wiki agent\n", "utf8");
    await initGraph(root, { skillTelemetry: true });

    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const newTime = new Date("2026-01-02T00:00:00.000Z");
    await utimes(join(root, ".red", "memory", "graph.rdb"), oldTime, oldTime);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "newer.ts"), "export const newer = true;\n", "utf8");
    await utimes(join(root, "src", "newer.ts"), newTime, newTime);

    const result = runMemory(["status", "context", "--root", root, "--json"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);

    expect(body.memory.graphFreshness.state).toBe("stale");
    expect(body.memory.graphFreshness.newerFiles).toContain("src/newer.ts");
    expect(body.recommendations).toContain("run `memory ingest . --root .` before relying on graph recall");
  });
});
