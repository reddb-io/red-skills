import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { graphRecall } from "../src/graph-recall.js";
import { initGraph, initMarkdownOnly } from "../src/init.js";
import { memoryStoreAnsweredQuery, memoryStoreEvidence } from "../src/governed-write.js";
import { buildSuggestedQuestions } from "../src/suggested-questions.js";
import { evidenceInboxRoot, parseEvidenceCardYaml } from "../src/evidence-card.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-governed-write-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("memory_store_evidence governed write", () => {
  test(
    "stores low-risk validation evidence with normalized provenance",
    async () => {
      const root = await tempRoot();
      const { storeUri } = await initGraph(root);
      const store = await MemoryStore.open({ uri: storeUri, project: "test" });
      stores.push(store);

      const result = await memoryStoreEvidence(store, {
        claim: "Validation proves the CLI governed write stores graph evidence.",
        sourceRef: "tests/governed-write-cli.test.ts",
        citationExcerpt: "stores low-risk validation evidence",
        intent: "validation",
        observer: "unit-test",
      });

      expect(result).toMatchObject({
        outcome: "stored",
        reason: "low_risk_validation_evidence_stored",
        provenance: {
          source_ref: "tests/governed-write-cli.test.ts",
          citation_excerpt: "stores low-risk validation evidence",
          evidence: [
            "tests/governed-write-cli.test.ts",
            "stores low-risk validation evidence",
          ],
        },
      });
      expect(result.memory.id).toEqual(expect.any(Number));
      const node = await store.getNode(result.memory.id!);
      expect(node).toMatchObject({
        node_type: "validation",
        properties: {
          provenance: {
            writer: "unit-test",
            evidence: [
              "tests/governed-write-cli.test.ts",
              "stores low-risk validation evidence",
            ],
          },
        },
      });
    },
    TIMEOUT,
  );

  test(
    "smoke: stores validation evidence as one runner and recalls it as another",
    async () => {
      const root = await tempRoot();
      const { storeUri } = await initGraph(root);
      const writerStore = await MemoryStore.open({
        uri: storeUri,
        project: "claude-smoke-runner",
      });
      stores.push(writerStore);

      const result = await memoryStoreEvidence(writerStore, {
        claim: "Validation smoke proves cross-agent governed Memory recall.",
        sourceRef: "issue-871-cross-agent-memory-smoke.md:17",
        citationExcerpt: "Validation smoke proves cross-agent governed Memory recall.",
        intent: "validation",
        observer: "claude-smoke-runner",
      });

      expect(result).toMatchObject({
        operation: "memory_store_evidence",
        outcome: "stored",
        reason: "low_risk_validation_evidence_stored",
        policy: {
          reason: "low_risk_validation_evidence_stored",
          risk: "low",
          mode_required: "graph",
        },
        provenance: {
          writer: "claude-smoke-runner",
          source_ref: "issue-871-cross-agent-memory-smoke.md:17",
          citation_excerpt: "Validation smoke proves cross-agent governed Memory recall.",
        },
      });
      expect(result.memory.id).toEqual(expect.any(Number));

      await writerStore.close();
      stores.splice(stores.indexOf(writerStore), 1);

      const readerStore = await MemoryStore.open({
        uri: storeUri,
        project: "codex-smoke-runner",
      });
      stores.push(readerStore);

      const hits = await graphRecall(
        readerStore,
        "cross-agent governed Memory recall validation smoke",
        5,
      );
      expect(hits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            rid: result.memory.id,
            node_type: "validation",
            excerpt: expect.stringContaining(
              "Validation smoke proves cross-agent governed Memory recall.",
            ),
          }),
        ]),
      );

      const recalled = await readerStore.getNode(result.memory.id!);
      expect(recalled).toMatchObject({
        node_type: "validation",
        properties: {
          intent: "validation",
          observer: "claude-smoke-runner",
          provenance: {
            writer: "claude-smoke-runner",
            command: "memory store-evidence",
            evidence: [
              "issue-871-cross-agent-memory-smoke.md:17",
              "Validation smoke proves cross-agent governed Memory recall.",
            ],
          },
        },
      });
    },
    TIMEOUT,
  );

  test(
    "CLI stores evidence and recall/search returns provenance",
    async () => {
      const root = await tempRoot();
      await initGraph(root);

      const write = runMemory([
        "store-evidence",
        "--root",
        root,
        "--claim",
        "Graph recall can find governed validation evidence.",
        "--source-ref",
        "docs/validation.md:12",
        "--citation-excerpt",
        "Graph recall can find governed validation evidence.",
        "--intent",
        "validation",
        "--observer",
        "cli-test",
        "--json",
      ]);
      expect(write.status, write.stderr).toBe(0);
      const body = JSON.parse(write.stdout) as {
        outcome: string;
        reason: string;
        memory: { id: number; urn: string };
        provenance: { source_ref: string; citation_excerpt: string; evidence: string[] };
      };
      expect(body.outcome).toBe("stored");
      expect(body.memory.urn).toBe(`memory_nodes:${body.memory.id}`);
      expect(body.provenance).toMatchObject({
        source_ref: "docs/validation.md:12",
        citation_excerpt: "Graph recall can find governed validation evidence.",
      });

      const provenance = runMemory(["provenance", String(body.memory.id), "--root", root, "--json"]);
      expect(provenance.status, provenance.stderr).toBe(0);
      const provenanceBody = JSON.parse(provenance.stdout) as {
        provenance: { evidence: string[]; writer: string };
      };
      expect(provenanceBody.provenance).toMatchObject({
        writer: "cli-test",
        evidence: [
          "docs/validation.md:12",
          "Graph recall can find governed validation evidence.",
        ],
      });

      const search = runMemory(["search", "governed validation", "--root", root]);
      expect(search.status, search.stderr).toBe(0);
      expect(search.stdout).toContain(String(body.memory.id));
      expect(search.stdout).toContain("Graph recall can find governed validation evidence.");
    },
    TIMEOUT,
  );

  test(
    "CLI rejects missing provenance fields without durable graph memory",
    async () => {
      const root = await tempRoot();
      const { storeUri } = await initGraph(root);

      const result = runMemory([
        "store-evidence",
        "--root",
        root,
        "--claim",
        "Missing citation should not write memory.",
        "--intent",
        "validation",
        "--observer",
        "cli-test",
        "--json",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { outcome: string; reason: string; memory: { id: null } };
      expect(body).toMatchObject({
        outcome: "rejected",
        reason: "missing_required_fields:sourceRef,citationExcerpt",
        memory: { id: null },
      });

      const store = await MemoryStore.open({ uri: storeUri, project: "test" });
      stores.push(store);
      expect(await store.listNodes()).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "proposes risky evidence as a redacted Evidence card without durable graph memory",
    async () => {
      const root = await tempRoot();
      const { storeUri } = await initGraph(root);
      const store = await MemoryStore.open({ uri: storeUri, project: "test" });
      stores.push(store);
      const token = "sk-test_1234567890abcdefghijklmnopqrstuv";

      const result = await memoryStoreEvidence(
        store,
        {
          claim: `User preference: do not store deployment token ${token} as a durable Memory fact.`,
          sourceRef: "agent transcript:42",
          citationExcerpt: `The human-facing note mentioned ${token}.`,
          intent: "personal-context",
          observer: "unit-test",
          blastRadius: "medium",
        },
        { rootDir: root, now: new Date("2026-06-24T01:00:00.000Z") },
      );

      expect(result).toMatchObject({
        outcome: "proposed",
        reason: "risk_requires_evidence_review:medium_blast_radius",
        policy: {
          reason: "risk_requires_evidence_review:medium_blast_radius",
          risk: "medium",
          mode_required: "evidence_review",
        },
        memory: { id: null, urn: null },
        review_artifact: {
          kind: "evidence_card",
          id: expect.stringMatching(/^evidence-[a-f0-9]{12}$/),
          path: expect.stringMatching(/^\.red\/memory\/inbox\/evidence\/evidence-[a-f0-9]{12}\.yaml$/),
        },
      });

      expect(await store.listNodes()).toEqual([]);

      const files = await readdir(evidenceInboxRoot(root));
      expect(files).toEqual([`${result.review_artifact!.id}.yaml`]);
      const raw = await readFile(join(evidenceInboxRoot(root), files[0]), "utf8");
      expect(raw).not.toContain(token);
      expect(raw).toContain("[REDACTED:openai-token]");

      const card = parseEvidenceCardYaml(raw);
      expect(card).toMatchObject({
        id: result.review_artifact!.id,
        source: {
          kind: "governed-write",
          ref: "agent transcript:42",
        },
        route: {
          target: "evidence_review",
          rationale: "risk_requires_evidence_review:medium_blast_radius",
        },
        confidence: "EXTRACTED",
        blast_radius: {
          scope: "medium",
          rationale: "Medium blast-radius governed writes require Evidence review before promotion.",
        },
        proposal_link: {
          kind: "governed-write",
          id: result.review_artifact!.id,
          apply_state: "pending",
        },
      });
      expect(card.privacy.redacted).toBe(true);
      expect(card.citations[0]).toMatchObject({
        label: "agent transcript:42",
        quote: "The human-facing note mentioned [REDACTED:openai-token].",
      });
      expect(card.proposed_lesson.text).toContain("[REDACTED:openai-token]");
    },
    TIMEOUT,
  );

  test(
    "CLI rejects markdown-only mode instead of falling back to notes",
    async () => {
      const root = await tempRoot();
      await initMarkdownOnly(root);

      const result = runMemory([
        "store-evidence",
        "--root",
        root,
        "--claim",
        "Markdown-only mode cannot store graph evidence.",
        "--source-ref",
        "source.md",
        "--citation-excerpt",
        "Markdown-only mode cannot store graph evidence.",
        "--intent",
        "validation",
        "--observer",
        "cli-test",
        "--json",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as { outcome: string; reason: string; memory: { id: null } };
      expect(body).toMatchObject({
        outcome: "rejected",
        reason: "graph_mode_required",
        memory: { id: null },
      });
    },
    TIMEOUT,
  );
});

describe("memory_store_answered_query governed write", () => {
  test(
    "persists an explicitly confirmed graph answer as a sealed node with provenance and source links",
    async () => {
      const root = await tempRoot();
      const { storeUri } = await initGraph(root);
      const store = await MemoryStore.open({ uri: storeUri, project: "test" });
      stores.push(store);
      const authRid = await store.upsertNode({
        label: "auth-hub",
        node_type: "concept",
        properties: { title: "Auth hub", content: "Auth hub" },
      });
      const tokenRid = await store.upsertNode({
        label: "token-rotation",
        node_type: "concept",
        properties: { title: "Token rotation", content: "Token rotation" },
      });

      const result = await memoryStoreAnsweredQuery(store, {
        question: "How does token rotation connect to auth?",
        answer: "Token rotation is governed by the auth hub.",
        sourceElements: [
          { kind: "node", rid: authRid, label: "auth-hub" },
          { kind: "node", rid: tokenRid, label: "token-rotation" },
        ],
        observer: "unit-test",
        confidence: "INFERRED",
      });

      expect(result).toMatchObject({
        operation: "memory_store_answered_query",
        outcome: "stored",
        reason: "answered_query_stored",
        provenance: {
          writer: "unit-test",
          source_ref: "answered-query:how-does-token-rotation-connect-to-auth",
          citation_excerpt: "How does token rotation connect to auth?",
        },
      });
      expect(result.memory.id).toEqual(expect.any(Number));
      const node = await store.getNode(result.memory.id!);
      expect(node).toMatchObject({
        label: "answered-query:how-does-token-rotation-connect-to-auth",
        node_type: "answer",
        properties: {
          title: "How does token rotation connect to auth?",
          content: "Token rotation is governed by the auth hub.",
          confidence: "INFERRED",
          seal: "INFERRED",
          question: "How does token rotation connect to auth?",
          answer: "Token rotation is governed by the auth hub.",
          source_elements: [
            { kind: "node", rid: authRid, label: "auth-hub" },
            { kind: "node", rid: tokenRid, label: "token-rotation" },
          ],
          provenance: {
            source_kind: "derived",
            writer: "unit-test",
            command: "memory store-answered-query",
            confidence: "INFERRED",
            evidence: [
              "question: How does token rotation connect to auth?",
              `node:${authRid}:auth-hub`,
              `node:${tokenRid}:token-rotation`,
            ],
          },
        },
      });
      const edges = await store.listEdges();
      expect(edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "REFERENCES", from_rid: result.memory.id, to_rid: authRid }),
          expect.objectContaining({ label: "REFERENCES", from_rid: result.memory.id, to_rid: tokenRid }),
        ]),
      );
    },
    TIMEOUT,
  );

  test(
    "re-answering the same question replaces the answer node instead of duplicating it",
    async () => {
      const root = await tempRoot();
      const { storeUri } = await initGraph(root);
      const store = await MemoryStore.open({ uri: storeUri, project: "test" });
      stores.push(store);

      await memoryStoreAnsweredQuery(store, {
        question: "Which store path writes answered graph queries?",
        answer: "The first answer is incomplete.",
        sourceElements: [{ kind: "community", community_id: "community-1" }],
        observer: "unit-test",
        confidence: "INFERRED",
      });
      const second = await memoryStoreAnsweredQuery(store, {
        question: "Which store path writes answered graph queries?",
        answer: "Answered graph queries write through the governed store path.",
        sourceElements: [{ kind: "community", community_id: "community-1" }],
        observer: "unit-test",
        confidence: "AMBIGUOUS",
      });

      const answers = (await store.listNodes()).filter(
        (node) => node.label === "answered-query:which-store-path-writes-answered-graph-queries",
      );
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({
        rid: second.memory.id,
        node_type: "answer",
        properties: {
          answer: "Answered graph queries write through the governed store path.",
          confidence: "AMBIGUOUS",
          seal: "AMBIGUOUS",
          provenance: {
            confidence: "AMBIGUOUS",
            evidence: [
              "question: Which store path writes answered graph queries?",
              "community:community-1",
            ],
          },
        },
      });
    },
    TIMEOUT,
  );

  test(
    "plain suggested-question queries leave the temp store untouched",
    async () => {
      const root = await tempRoot();
      const { storeUri } = await initGraph(root);
      const store = await MemoryStore.open({ uri: storeUri, project: "test" });
      stores.push(store);
      await store.upsertNode({
        label: "auth-hub",
        node_type: "concept",
        properties: { title: "Auth hub", content: "Auth hub" },
      });
      const before = await store.listNodes();

      await buildSuggestedQuestions(store, { now: new Date("2026-07-10T00:00:00.000Z") });

      expect(await store.listNodes()).toEqual(before);
    },
    TIMEOUT,
  );
});
