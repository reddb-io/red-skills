import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph, initMarkdownOnly } from "../src/init.js";
import { memoryStoreEvidence } from "../src/governed-write.js";
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
