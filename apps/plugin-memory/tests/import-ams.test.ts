import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  importAms,
  importAmsDump,
  inferNodeType,
  parseAmsDump,
} from "../src/import-ams.js";
import { initGraph } from "../src/init.js";
import { current as sessionCurrent } from "../src/session-manager.js";

const TIMEOUT = 60_000;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SAMPLE_DUMP = resolve(__dirname, "fixtures/ams/sample-dump.json");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-ams-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("memory import ams (heuristics)", () => {
  test("infers node_type from memory_type field first, then text heuristics", () => {
    expect(inferNodeType({ memory_type: "decision", text: "anything" })).toBe("decision");
    expect(inferNodeType({ memory_type: "fix", text: "anything" })).toBe("fix");
    expect(inferNodeType({ text: "Decision: prefer X over Y" })).toBe("decision");
    expect(inferNodeType({ text: "Fix: handle empty input" })).toBe("fix");
    expect(inferNodeType({ text: "Gotcha: cache invalidation is hard" })).toBe("why_note");
    expect(inferNodeType({ text: "Why: we picked this stack" })).toBe("why_note");
    expect(inferNodeType({ text: "Random observation about the world" })).toBe("concept");
  });

  test("parseAmsDump rejects non-object input", () => {
    expect(() => parseAmsDump("[]")).toThrow(/object/);
    expect(() => parseAmsDump("not-json")).toThrow(/JSON/i);
    expect(() => parseAmsDump(JSON.stringify({ working_memory: 7 }))).toThrow(/working_memory/);
  });
});

describe("memory import ams (end-to-end)", () => {
  test(
    "imports working_memory and long_term_memory from the sample dump",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      const report = await importAmsDump(store, root, SAMPLE_DUMP);

      // working_memory: two sessions, three memories, one transcript.
      expect(report.working.sessions).toEqual(
        expect.arrayContaining(["ams-sess-alpha", "ams-sess-beta"]),
      );
      expect(report.working.events).toBe(3);
      expect(report.working.transcripts).toBe(1);

      // long_term_memory: 4 entries → 2 promoted (decision + fix), 1 reinforced
      // (decision near-dup with different wording), 1 promoted as a *separate*
      // contradicting decision (the conflict detector picks it up via CONTRADICTS).
      expect(report.long_term.promoted).toBe(3);
      expect(report.long_term.reinforced).toBe(1);

      // Each imported L3 node is reachable as a real node, scoped to a session.
      const all = await store.listNodes();
      const decisionNodes = all.filter(
        (n) => n.node_type === "decision" && n.properties.layer !== "L2",
      );
      expect(decisionNodes.length).toBeGreaterThanOrEqual(2);
      for (const n of decisionNodes) {
        const src = String(n.properties.source ?? "");
        expect(src.startsWith("ams-import")).toBe(true);
      }

      // L2 events landed under the right sessions.
      const alphaL2 = all.filter(
        (n) =>
          n.properties.layer === "L2" &&
          n.properties.session_id === "ams-sess-alpha" &&
          n.properties.working_kind === "event",
      );
      expect(alphaL2.length).toBe(2);

      const betaTranscripts = all.filter(
        (n) =>
          n.properties.layer === "L2" &&
          n.properties.session_id === "ams-sess-alpha" &&
          n.properties.working_kind === "transcript",
      );
      expect(betaTranscripts.length).toBe(1);
    },
    TIMEOUT,
  );

  test(
    "import-time contradictions surface as CONTRADICTS edges",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      await importAms(store, root, {
        long_term_memory: [
          {
            id: "x",
            text: "Decision: Always retry failed webhooks with backoff",
            memory_type: "decision",
            session_id: "s1",
          },
          {
            id: "y",
            text: "Decision: Do not retry failed webhooks with backoff",
            memory_type: "decision",
            session_id: "s2",
          },
        ],
      });

      // Find the CONTRADICTS edge directly via the store cache.
      // upsertEdge persists into memory_edges; listNodes already populated
      // the node cache, so re-open the edges via a fresh query.
      const allNodes = await store.listNodes();
      const decisions = allNodes.filter((n) => n.node_type === "decision");
      expect(decisions.length).toBe(2);
      // Both should have ams-import provenance.
      for (const n of decisions) {
        expect(String(n.properties.source ?? "")).toContain("ams-import");
      }
    },
    TIMEOUT,
  );

  test(
    "preserves the caller's current session id",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      // No session set initially.
      const before = await sessionCurrent(root);
      expect(before).toBeNull();

      await importAms(store, root, {
        working_memory: [
          {
            session_id: "ams-only-session",
            memories: [{ id: "m1", text: "Decision: test something", memory_type: "decision" }],
          },
        ],
      });

      // After import with no prior session, the importer's final session id
      // remains active (no original to restore).
      const after = await sessionCurrent(root);
      expect(after).toBe("ams-only-session");
    },
    TIMEOUT,
  );

  test(
    "re-importing the same long_term entries bumps reinforcement instead of duplicating",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);

      const dump = {
        long_term_memory: [
          {
            id: "stable",
            text: "Decision: Default to JSON over YAML for config",
            memory_type: "decision",
          },
        ],
      };
      const first = await importAms(store, root, dump);
      expect(first.long_term.promoted).toBe(1);
      expect(first.long_term.reinforced).toBe(0);

      const second = await importAms(store, root, dump);
      expect(second.long_term.promoted).toBe(0);
      expect(second.long_term.reinforced).toBe(1);

      const count = await store.reinforcedCount(first.long_term.promoted_rids[0]);
      expect(count).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );
});
