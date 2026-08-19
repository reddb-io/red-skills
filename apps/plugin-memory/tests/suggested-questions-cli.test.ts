import { decode } from "@reddb-io/toon";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { getReadOnlyMemoryOperation } from "../src/operations.js";
import { buildSuggestedQuestions } from "../src/suggested-questions.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-suggested-questions-cli-"));
  roots.push(root);
  await initGraph(root);
  return root;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

async function seedQuestionTopology(root: string): Promise<MemoryStore> {
  const store = await openStore(root);
  const mk = (label: string, title: string) =>
    store.upsertNode({
      label,
      node_type: "concept",
      properties: { title, content: title },
    });
  const [
    authHub,
    login,
    token,
    session,
    billingHub,
    invoice,
    payment,
    rollout,
  ] = await Promise.all([
    mk("auth-hub", "auth hub"),
    mk("login-flow", "login flow"),
    mk("token-rotation", "token rotation"),
    mk("session-policy", "session policy"),
    mk("billing-hub", "billing hub"),
    mk("invoice-sync", "invoice sync"),
    mk("payment-state", "payment state"),
    mk("rollout-plan", "rollout plan"),
  ]);
  const edge = (
    from_rid: number,
    to_rid: number,
    seal: "EXTRACTED" | "INFERRED" = "EXTRACTED",
    confidence_score?: number,
  ) =>
    store.upsertEdge({
      label: "REFERENCES",
      from_rid,
      to_rid,
      properties: { seal, ...(confidence_score == null ? {} : { confidence_score }) },
    });
  await edge(login, authHub);
  await edge(token, authHub, "INFERRED", 0.91);
  await edge(authHub, session);
  await edge(session, login);
  await edge(invoice, billingHub);
  await edge(payment, billingHub);
  await edge(billingHub, invoice);
  await edge(payment, invoice);
  await edge(authHub, billingHub);
  await edge(session, billingHub);
  await edge(rollout, authHub);
  await edge(rollout, billingHub);
  return store;
}

describe("memory suggested-questions", () => {
  test(
    "phrases deterministic graph signals through the provider and keeps graph references",
    async () => {
      const root = await initRoot();
      const store = await seedQuestionTopology(root);
      const calls: Array<{ task?: string; signals: Array<{ signal_id: string; signal_type: string }> }> = [];
      const providerClient = {
        async complete(req: { user: string }) {
          const body = JSON.parse(req.user) as {
            task?: string;
            signals: Array<{ signal_id: string; signal_type: string; title: string }>;
          };
          calls.push(body);
          return JSON.stringify({
            questions: body.signals.map((signal) => ({
              signal_id: signal.signal_id,
              question: `Fake ${signal.signal_type} question for ${signal.title}?`,
            })),
          });
        },
      };

      const first = await buildSuggestedQuestions(store, {
        now: new Date("2026-07-10T00:00:00.000Z"),
        providerConfig: {
          mode: "openai-compat",
          model: "llama3.1",
          baseUrl: "http://localhost:11434/v1",
        },
        providerClient,
      });
      const second = await buildSuggestedQuestions(store, {
        now: new Date("2026-07-10T00:00:00.000Z"),
        providerConfig: {
          mode: "openai-compat",
          model: "llama3.1",
          baseUrl: "http://localhost:11434/v1",
        },
        providerClient,
      });

      expect(calls).toHaveLength(2);
      expect(calls[0].task).toBe("suggested-questions");
      expect(calls[0].signals.map((signal) => signal.signal_id)).toEqual(
        calls[1].signals.map((signal) => signal.signal_id),
      );
      expect(new Set(first.signals.map((signal) => signal.signal_type))).toEqual(
        new Set(["hub", "bridge", "weak_community", "inferred_edge"]),
      );
      expect(first.questions.map((question) => question.signal_id)).toEqual(
        second.questions.map((question) => question.signal_id),
      );
      expect(first.questions.length).toBe(first.signals.length);
      expect(first.questions.every((question) => question.question.startsWith("Fake "))).toBe(true);
      expect(first.questions.every((question) => question.references.length > 0)).toBe(true);
      expect(first.questions.some((question) => question.references.some((ref) => ref.kind === "edge"))).toBe(true);
      expect(first.summary.status).toBe("ready");
    },
    TIMEOUT,
  );

  test(
    "registers the CLI surface and emits a definitive TOON empty state",
    async () => {
      const root = await initRoot();
      expect(getReadOnlyMemoryOperation("memory.suggested-questions").renderer.cli).toMatchObject({
        command: "suggested-questions",
        supportsJson: true,
      });

      const result = runMemory(["suggested-questions", "--root", root]);
      expect(result.status).toBe(0);
      const body = decode(result.stdout) as {
        schema_version: string;
        questions: unknown[];
        summary: {
          status: string;
          nodes: number;
          edges: number;
          signals: number;
          questions: number;
          next: string[];
        };
      };

      expect(body.schema_version).toBe("memory.suggested-questions.v1");
      expect(body.questions).toEqual([]);
      expect(body.summary).toMatchObject({
        status: "empty_graph",
        nodes: 0,
        edges: 0,
        signals: 0,
        questions: 0,
      });
      expect(body.summary.next).toContain("memory hub-report --json");
    },
    TIMEOUT,
  );
});
