import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readConfig, resolveStoreUri } from "../src/config.js";
import { MemoryStore } from "../src/graph-store.js";
import { readMemoryEvents } from "../src/memory-events.js";
import { parseClaudeInput, parseCodexInput, formatOutput } from "../src/hook-adapters.js";
import {
  dispatch,
  heuristicExtractor,
  type NormalizedInput,
} from "../src/hook-runtime.js";
import { initGraph, initMarkdownOnly } from "../src/init.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-hook-"));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function input(event: NormalizedInput["event"], over: Partial<NormalizedInput> = {}): NormalizedInput {
  return { event, runner: "claude", changedFiles: [], ...over };
}

describe("dispatch gating (AC3)", () => {
  test("no-ops when memory is not initialized", async () => {
    const root = await tempRoot();
    const r = await dispatch(input("SessionStart", { goal: "anything" }), root);
    expect(r.noop).toBe(true);
    expect(r.reason).toMatch(/not initialized/);
  });

  test("no-ops in markdown-only mode (hooks always off)", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    const r = await dispatch(input("Stop", { transcriptText: "We decided to use X." }), root);
    expect(r.noop).toBe(true);
  });

  test(
    "no-ops in graph mode when the hook flag is off",
    async () => {
      const root = await tempRoot();
      await initGraph(root); // hooks default off
      const r = await dispatch(input("SessionStart", { goal: "x" }), root);
      expect(r.noop).toBe(true);
      expect(r.reason).toMatch(/disabled/);
    },
    TIMEOUT,
  );
});

describe("PreCompact flush → SessionStart recall across /clear (AC1, AC2)", () => {
  test(
    "PreCompact persists a decision the next session recalls",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });

      const flush = await dispatch(
        input("PreCompact", {
          transcriptText:
            "We decided to adopt the zigzag caching strategy for the planner because it halves lookups.",
        }),
        root,
      );
      expect(flush.noop).toBe(false);
      expect(flush.stored).toBeGreaterThanOrEqual(1);

      // A fresh dispatch — the next session — recalls it from the store.
      const recall = await dispatch(input("SessionStart", { goal: "zigzag caching" }), root);
      expect(recall.noop).toBe(false);
      expect(recall.inject).toMatch(/zigzag caching/i);
      expect(recall.injection?.deliveredNodeIds.length).toBeGreaterThan(0);

      const config = await readConfig(root);
      if (!config) throw new Error("config missing after init");
      const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
      try {
        const events = await readMemoryEvents(store);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "memory.injection.delivered",
              payload: expect.objectContaining({
                delivery_surface: "hook",
                hook_event: "SessionStart",
                delivered_citation_ids: expect.arrayContaining([
                  expect.stringMatching(/^memory_nodes:/),
                ]),
                delivered_node_ids: expect.arrayContaining([expect.any(Number)]),
              }),
            }),
          ]),
        );
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );

  test(
    "Stop persists structured problem/fix/validation facts with inferred relations",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });

      const flush = await dispatch(
        input("Stop", {
          transcriptText: [
            "Problem: deploys fail during cold start.",
            "Fix: warm the connection pool during boot.",
            "Validation: pnpm test startup passed.",
          ].join("\n"),
        }),
        root,
      );
      expect(flush.noop).toBe(false);
      expect(flush.stored).toBe(3);

      const config = await readConfig(root);
      if (!config) throw new Error("config missing after init");
      const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
      try {
        const nodes = await store.listNodes();
        const edges = await store.listEdges();
        const problem = nodes.find((node) => node.label === "problem-deploys-fail-during-cold-start");
        const fix = nodes.find((node) => node.label === "fix-warm-the-connection-pool-during-boot");
        const validation = nodes.find((node) => node.label === "validation-pnpm-test-startup-passed");

        expect(problem?.properties.confidence).toBe("INFERRED");
        expect(problem?.properties.source).toBe("hook:Stop:structured-transcript");
        expect(fix?.node_type).toBe("fix");
        expect(validation?.node_type).toBe("validation");
        expect(edges).toContainEqual(
          expect.objectContaining({
            from_rid: fix?.rid,
            to_rid: problem?.rid,
            label: "FIXES",
          }),
        );
        expect(edges).toContainEqual(
          expect.objectContaining({
            from_rid: fix?.rid,
            to_rid: validation?.rid,
            label: "TESTED_BY",
          }),
        );
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );

  test(
    "SessionStart no-ops when nothing relevant is stored",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      const r = await dispatch(input("SessionStart", { goal: "wholly unrelated topic" }), root);
      expect(r.noop).toBe(true);
    },
    TIMEOUT,
  );
});

describe("PostToolUse incremental re-index (watched-path scoping)", () => {
  /** Write a watched ADR markdown file under `<root>/.red/adr/` and return its path. */
  async function writeWatchedAdr(root: string, name: string, body: string): Promise<string> {
    const dir = join(root, ".red", "adr");
    await mkdir(dir, { recursive: true });
    const file = join(dir, name);
    await writeFile(file, body, "utf8");
    return file;
  }

  test(
    "a watched path triggers ingest into the graph",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      const file = await writeWatchedAdr(
        root,
        "0099-zigzag.md",
        "# ADR 0099: Zigzag\n\nWe decided to adopt the zigzag caching strategy.\n",
      );

      const r = await dispatch(input("PostToolUse", { changedFiles: [file] }), root);
      expect(r.noop).toBe(false);
      expect(r.indexed).toBe(1);

      const config = await readConfig(root);
      if (!config) throw new Error("config missing after init");
      const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
      try {
        const nodes = await store.listNodes();
        expect(nodes.length).toBeGreaterThan(0);
        const events = await readMemoryEvents(store);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "hook.lifecycle",
              payload: expect.objectContaining({
                hook_event: "PostToolUse",
                result: expect.objectContaining({ indexed: 1 }),
              }),
            }),
          ]),
        );
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );

  test(
    "a non-watched path skips ingest but still records a lifecycle noop event",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      // Indexable by extension, but not a watched memory surface.
      const file = join(root, "widget.ts");
      await writeFile(file, "export function renderWidget() { return 42; }\n", "utf8");

      const r = await dispatch(input("PostToolUse", { changedFiles: [file] }), root);
      expect(r.noop).toBe(true);
      expect(r.reason).toBe("no watched path");

      const config = await readConfig(root);
      if (!config) throw new Error("config missing after init");
      const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
      try {
        // No symbol from the skipped file landed in the graph.
        const nodes = await store.listNodes();
        expect(nodes.some((n) => n.label.includes("renderWidget"))).toBe(false);
        // The skipped invocation is still on the Memory event log (ADR 0025).
        const events = await readMemoryEvents(store);
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "hook.lifecycle",
              payload: expect.objectContaining({
                hook_event: "PostToolUse",
                result: expect.objectContaining({ noop: true, reason: "no watched path" }),
              }),
            }),
          ]),
        );
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );

  test(
    "a mixed changed-files list ingests only the watched subset",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      const watched = await writeWatchedAdr(
        root,
        "0100-mixed.md",
        "# ADR 0100\n\nWe decided to keep the watched subset.\n",
      );
      const unwatched = join(root, "widget.ts");
      await writeFile(unwatched, "export function renderWidget() { return 42; }\n", "utf8");

      const r = await dispatch(
        input("PostToolUse", { changedFiles: [unwatched, watched] }),
        root,
      );
      expect(r.noop).toBe(false);
      // Only the one watched file was re-indexed.
      expect(r.indexed).toBe(1);

      const config = await readConfig(root);
      if (!config) throw new Error("config missing after init");
      const store = await MemoryStore.open({ uri: resolveStoreUri(root, config) });
      try {
        const nodes = await store.listNodes();
        // The non-watched source symbol was never indexed.
        expect(nodes.some((n) => n.label.includes("renderWidget"))).toBe(false);
      } finally {
        await store.close();
      }
    },
    TIMEOUT,
  );
});

describe("heuristicExtractor", () => {
  test("keeps decision and why-note sentences, drops chatter", async () => {
    const out = await heuristicExtractor(
      "Hello there. We decided to use a queue. It rained today. We picked SQLite because it is embedded.",
    );
    const types = out.map((m) => m.node_type);
    expect(types).toContain("decision");
    expect(types).toContain("why_note");
    expect(out.every((m) => m.title.length > 0)).toBe(true);
  });

  test("returns nothing for chatter with no cues", async () => {
    expect(await heuristicExtractor("Hi. How are you. The sky is blue.")).toEqual([]);
  });
});

describe("runner adapters", () => {
  test("parseClaudeInput flattens Edit tool_input to a changed file", async () => {
    const ni = await parseClaudeInput("PostToolUse", {
      cwd: "/repo",
      tool_input: { file_path: "src/a.ts" },
    });
    expect(ni.runner).toBe("claude");
    expect(ni.changedFiles).toEqual(["/repo/src/a.ts"]);
  });

  test("parseCodexInput has no branch/goal and reads cwd", async () => {
    const ni = await parseCodexInput("SessionStart", {
      cwd: "/repo",
      session_id: "abc",
    });
    expect(ni.runner).toBe("codex");
    expect(ni.branch).toBeUndefined();
    expect(ni.goal).toBeUndefined();
    expect(ni.cwd).toBe("/repo");
  });

  test("parseCodexInput pulls apply_patch paths", async () => {
    const ni = await parseCodexInput("PostToolUse", {
      cwd: "/repo",
      tool_input: { changes: { "src/x.ts": {}, "src/y.ts": {} } },
    });
    expect(ni.changedFiles.sort()).toEqual(["/repo/src/x.ts", "/repo/src/y.ts"]);
  });

  test("runner adapters accept inline transcript text for OpenCode lifecycle bridges", async () => {
    const ni = await parseCodexInput("Stop", {
      cwd: "/repo",
      session_id: "abc",
      transcript_text: "We decided to persist OpenCode Stop hooks.",
    });
    expect(ni.transcriptText).toBe("We decided to persist OpenCode Stop hooks.");
  });

  test("formatOutput renders each runner's injection shape; no-op is empty", () => {
    expect(formatOutput("claude", "SessionStart", { noop: true })).toBe("{}");
    const claude = JSON.parse(
      formatOutput("claude", "SessionStart", { noop: false, inject: "ctx" }),
    );
    expect(claude.hookSpecificOutput.additionalContext).toBe("ctx");
    expect(claude.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const codex = JSON.parse(
      formatOutput("codex", "SessionStart", { noop: false, inject: "ctx" }),
    );
    expect(codex.systemMessage).toBe("ctx");
  });
});
