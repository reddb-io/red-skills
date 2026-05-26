import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
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
  const root = await mkdtemp(join(tmpdir(), "memory-doc-search-cli-"));
  roots.push(root);
  const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

// AFK feedback gates set RED_AFK_SKIP_PERF=1 — this CLI test spawns several
// node+tsx subprocesses and hits the 40s timeout under host load.
const skipPerf = process.env.RED_AFK_SKIP_PERF === "1";

describe("memory docs search CLI", () => {
  test.skipIf(skipPerf)(
    "searches and reads ingested document chunks without an LLM provider",
    async () => {
      const root = await initRoot();
      const doc = join(root, "docs/security.md");
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(
        doc,
        [
          "---",
          "title: Security Guide",
          "tags:",
          "  - jwt",
          "---",
          "",
          "# Security Guide",
          "",
          "JWT rotation requires signed fixtures, `JWT_SECRET`, and incident review.",
          "",
        ].join("\n"),
        "utf8",
      );

      const ingest = runMemory(["ingest", root, "--root", root]);
      expect(ingest.status, ingest.stderr).toBe(0);

      const result = runMemory([
        "docs",
        "search",
        "jwt rotation",
        "--root",
        root,
        "--json",
      ]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        total_docs: number;
        hits: Array<{ path: string; title: string; excerpt: string; matched_fields: string[] }>;
      };

      expect(body.total_docs).toBe(1);
      expect(body.hits).toEqual([
        expect.objectContaining({
          path: doc,
          title: "Security Guide",
          excerpt: expect.stringContaining("JWT rotation requires signed fixtures"),
          matched_fields: expect.arrayContaining(["body", "frontmatter"]),
        }),
      ]);

      const searchViewerOut = join(root, "doc-search-viewer.html");
      const searchViewer = runMemory([
        "docs",
        "search-viewer",
        "jwt rotation",
        "--root",
        root,
        "--limit",
        "2",
        "--out",
        searchViewerOut,
      ]);
      expect(searchViewer.status, searchViewer.stderr).toBe(0);
      expect(searchViewer.stdout).toContain("memory: doc search viewer written");
      const searchHtml = await readFile(searchViewerOut, "utf8");
      expect(searchHtml).toContain("Documentation Search");
      expect(searchHtml).toContain("Security Guide");
      expect(searchHtml).toContain("/docs/evidence-pack?rid=");
      expect(searchHtml).toContain('id="doc-search-data"');

      const coverage = runMemory(["docs", "coverage", "--root", root, "--json"]);
      expect(coverage.status, coverage.stderr).toBe(0);
      const coverageBody = JSON.parse(coverage.stdout) as {
        schema_version: string;
        total_docs: number;
        grounded_docs: number;
        docs_with_references: number;
        total_references: number;
        vector: { overall: string };
        docs: Array<{
          path: string;
          graph_status: string;
          references: { count: number; examples: Array<{ title: string }> };
          vector_status: string;
        }>;
      };
      expect(coverageBody).toMatchObject({
        schema_version: "memory.doc_coverage.v1",
        total_docs: 1,
        grounded_docs: 1,
        docs_with_references: 1,
        total_references: 1,
        vector: { overall: expect.stringMatching(/unavailable|failed/) },
      });
      expect(coverageBody.docs[0]).toMatchObject({
        path: doc,
        graph_status: "grounded",
        references: {
          count: 1,
          examples: [expect.objectContaining({ title: "JWT_SECRET" })],
        },
      });
      expect(["unavailable", "failed"]).toContain(coverageBody.docs[0]?.vector_status);

      const referenceGraph = runMemory([
        "docs",
        "reference-graph",
        "--root",
        root,
        "--json",
      ]);
      expect(referenceGraph.status, referenceGraph.stderr).toBe(0);
      const referenceGraphBody = JSON.parse(referenceGraph.stdout) as {
        schema_version: string;
        total_docs: number;
        grounded_docs: number;
        reference_nodes: number;
        reference_edges: number;
        top_references: Array<{ node: { title: string }; incoming_docs: number }>;
      };
      expect(referenceGraphBody).toMatchObject({
        schema_version: "memory.doc_reference_graph.v1",
        total_docs: 1,
        grounded_docs: 1,
        reference_nodes: 1,
        reference_edges: 1,
        top_references: [
          expect.objectContaining({
            incoming_docs: 1,
            node: expect.objectContaining({ title: "JWT_SECRET" }),
          }),
        ],
      });

      const backlinks = runMemory(["docs", "backlinks", "JWT_SECRET", "--root", root, "--json"]);
      expect(backlinks.status, backlinks.stderr).toBe(0);
      const backlinksBody = JSON.parse(backlinks.stdout) as {
        schema_version: string;
        found: boolean;
        matched_by: string;
        references: Array<{ title: string }>;
        docs: Array<{ path: string; matched_references: number }>;
      };
      expect(backlinksBody).toMatchObject({
        schema_version: "memory.doc_backlinks.v1",
        found: true,
        matched_by: "query",
        references: [expect.objectContaining({ title: "JWT_SECRET" })],
        docs: [expect.objectContaining({ path: doc, matched_references: 1 })],
      });

      const brief = runMemory([
        "docs",
        "brief",
        "jwt rotation",
        "--root",
        root,
        "--limit",
        "2",
        "--max-bytes",
        "160",
        "--json",
      ]);
      expect(brief.status, brief.stderr).toBe(0);
      const briefBody = JSON.parse(brief.stdout) as {
        schema_version: string;
        status: string;
        citations: Array<{ marker: string; path: string; references: Array<{ title: string }> }>;
        gaps: string[];
        markdown: string;
      };
      expect(briefBody).toMatchObject({
        schema_version: "memory.doc_brief.v1",
        status: "partial",
        citations: [
          expect.objectContaining({
            marker: "[D1]",
            path: doc,
            references: [expect.objectContaining({ title: "JWT_SECRET" })],
          }),
        ],
      });
      expect(briefBody.gaps).toContain("Only one doc citation supports this brief.");
      expect(briefBody.markdown).toContain("Memory Docs Brief");
      expect(briefBody.markdown).toContain("[D1]");

      const briefViewerOut = join(root, "doc-brief-viewer.html");
      const briefViewer = runMemory([
        "docs",
        "brief-viewer",
        "jwt rotation",
        "--root",
        root,
        "--limit",
        "2",
        "--max-bytes",
        "160",
        "--out",
        briefViewerOut,
      ]);
      expect(briefViewer.status, briefViewer.stderr).toBe(0);
      expect(briefViewer.stdout).toContain("memory: doc brief viewer written");
      const briefHtml = await readFile(briefViewerOut, "utf8");
      expect(briefHtml).toContain("Documentation Brief");
      expect(briefHtml).toContain("Security Guide");
      expect(briefHtml).toContain("Memory Docs Brief");
      expect(briefHtml).toContain('id="doc-brief-data"');

      const bundle = runMemory([
        "docs",
        "bundle",
        "jwt rotation",
        "--root",
        root,
        "--limit",
        "2",
        "--max-bytes",
        "160",
        "--json",
      ]);
      expect(bundle.status, bundle.stderr).toBe(0);
      const bundleBody = JSON.parse(bundle.stdout) as {
        schema_version: string;
        query: string;
        hits: Array<{ path: string }>;
        packs: Array<{ found: boolean; doc: { path: string } }>;
        markdown: string;
      };
      expect(bundleBody).toMatchObject({
        schema_version: "memory.doc_bundle.v1",
        query: "jwt rotation",
        hits: [expect.objectContaining({ path: doc })],
        packs: [
          expect.objectContaining({
            found: true,
            doc: expect.objectContaining({ path: doc }),
          }),
        ],
      });
      expect(bundleBody.markdown).toContain("Memory Docs Bundle");
      expect(bundleBody.markdown).toContain("Memory Doc Evidence Pack");

      const bundleViewerOut = join(root, "doc-bundle-viewer.html");
      const bundleViewer = runMemory([
        "docs",
        "bundle-viewer",
        "jwt rotation",
        "--root",
        root,
        "--limit",
        "2",
        "--max-bytes",
        "160",
        "--out",
        bundleViewerOut,
      ]);
      expect(bundleViewer.status, bundleViewer.stderr).toBe(0);
      expect(bundleViewer.stdout).toContain("memory: doc bundle viewer written");
      const bundleHtml = await readFile(bundleViewerOut, "utf8");
      expect(bundleHtml).toContain("Documentation Bundle");
      expect(bundleHtml).toContain("Security Guide");
      expect(bundleHtml).toContain("Memory Docs Bundle");
      expect(bundleHtml).toContain('id="doc-bundle-data"');

      const backlinksViewerOut = join(root, "doc-backlinks-viewer.html");
      const backlinksViewer = runMemory([
        "docs",
        "backlinks-viewer",
        "JWT_SECRET",
        "--root",
        root,
        "--out",
        backlinksViewerOut,
      ]);
      expect(backlinksViewer.status, backlinksViewer.stderr).toBe(0);
      expect(backlinksViewer.stdout).toContain("memory: doc backlinks viewer written");
      const backlinksHtml = await readFile(backlinksViewerOut, "utf8");
      expect(backlinksHtml).toContain("Documentation Backlinks");
      expect(backlinksHtml).toContain("Security Guide");
      expect(backlinksHtml).toContain('id="doc-backlinks-data"');

      const referenceGraphViewerOut = join(root, "doc-reference-graph-viewer.html");
      const referenceGraphViewer = runMemory([
        "docs",
        "reference-graph-viewer",
        "--root",
        root,
        "--out",
        referenceGraphViewerOut,
      ]);
      expect(referenceGraphViewer.status, referenceGraphViewer.stderr).toBe(0);
      expect(referenceGraphViewer.stdout).toContain(
        "memory: doc reference graph viewer written",
      );
      const referenceGraphHtml = await readFile(referenceGraphViewerOut, "utf8");
      expect(referenceGraphHtml).toContain("Documentation Reference Graph");
      expect(referenceGraphHtml).toContain("JWT_SECRET");
      expect(referenceGraphHtml).toContain('id="doc-reference-graph-data"');

      const viewerOut = join(root, "doc-coverage-viewer.html");
      const viewer = runMemory([
        "docs",
        "coverage-viewer",
        "--root",
        root,
        "--out",
        viewerOut,
      ]);
      expect(viewer.status, viewer.stderr).toBe(0);
      expect(viewer.stdout).toContain("memory: doc coverage viewer written");
      const html = await readFile(viewerOut, "utf8");
      expect(html).toContain("Documentation Coverage");
      expect(html).toContain("Security Guide");
      expect(html).toContain('id="doc-coverage-data"');

      const read = runMemory([
        "docs",
        "read",
        doc,
        "--root",
        root,
        "--max-bytes",
        "40",
        "--json",
      ]);
      expect(read.status, read.stderr).toBe(0);
      const readBody = JSON.parse(read.stdout) as {
        found: boolean;
        path: string;
        body: string;
        body_bytes: number;
        returned_bytes: number;
        truncated: boolean;
      };
      expect(readBody).toMatchObject({
        found: true,
        path: doc,
        truncated: true,
      });
      expect(readBody.body).toContain("Security Guide");
      expect(readBody.returned_bytes).toBeLessThanOrEqual(40);
      expect(readBody.body_bytes).toBeGreaterThan(readBody.returned_bytes);

      const evidencePack = runMemory([
        "docs",
        "evidence-pack",
        doc,
        "--root",
        root,
        "--max-bytes",
        "160",
        "--json",
      ]);
      expect(evidencePack.status, evidencePack.stderr).toBe(0);
      const evidencePackBody = JSON.parse(evidencePack.stdout) as {
        schema_version: string;
        found: boolean;
        doc: { path: string };
        related: { references: Array<{ title: string }> };
        markdown: string;
      };
      expect(evidencePackBody).toMatchObject({
        schema_version: "memory.doc_evidence_pack.v1",
        found: true,
        doc: { path: doc },
        related: { references: [expect.objectContaining({ title: "JWT_SECRET" })] },
      });
      expect(evidencePackBody.markdown).toContain("Memory Doc Evidence Pack");
      expect(evidencePackBody.markdown).toContain("Security Guide");

      const evidencePackViewerOut = join(root, "doc-evidence-pack-viewer.html");
      const evidencePackViewer = runMemory([
        "docs",
        "evidence-pack-viewer",
        doc,
        "--root",
        root,
        "--max-bytes",
        "160",
        "--out",
        evidencePackViewerOut,
      ]);
      expect(evidencePackViewer.status, evidencePackViewer.stderr).toBe(0);
      expect(evidencePackViewer.stdout).toContain(
        "memory: doc evidence pack viewer written",
      );
      const evidencePackHtml = await readFile(evidencePackViewerOut, "utf8");
      expect(evidencePackHtml).toContain("Doc Evidence Pack");
      expect(evidencePackHtml).toContain("Security Guide");
      expect(evidencePackHtml).toContain("JWT_SECRET");
      expect(evidencePackHtml).toContain('id="doc-evidence-pack-data"');

      const related = runMemory(["docs", "related", doc, "--root", root, "--json"]);
      expect(related.status, related.stderr).toBe(0);
      const relatedBody = JSON.parse(related.stdout) as {
        schema_version: string;
        found: boolean;
        target: { path: string };
        references: Array<{ title: string }>;
        related_docs: unknown[];
      };
      expect(relatedBody).toMatchObject({
        schema_version: "memory.doc_related.v1",
        found: true,
        target: { path: doc },
        references: [expect.objectContaining({ title: "JWT_SECRET" })],
      });
      expect(Array.isArray(relatedBody.related_docs)).toBe(true);

      const relatedViewerOut = join(root, "doc-related-viewer.html");
      const relatedViewer = runMemory([
        "docs",
        "related-viewer",
        doc,
        "--root",
        root,
        "--out",
        relatedViewerOut,
      ]);
      expect(relatedViewer.status, relatedViewer.stderr).toBe(0);
      expect(relatedViewer.stdout).toContain("memory: doc related viewer written");
      const relatedHtml = await readFile(relatedViewerOut, "utf8");
      expect(relatedHtml).toContain("Related Documentation");
      expect(relatedHtml).toContain("JWT_SECRET");
      expect(relatedHtml).toContain('id="doc-related-data"');

      await rm(doc);
      const dryRunRestore = runMemory([
        "docs",
        "restore",
        doc,
        "--root",
        root,
        "--in-place",
        "--dry-run",
        "--json",
      ]);
      expect(dryRunRestore.status, dryRunRestore.stderr).toBe(0);
      const dryRunBody = JSON.parse(dryRunRestore.stdout) as {
        dry_run: boolean;
        summary: { planned: number; restored: number };
        items: Array<{ destination_path: string; status: string }>;
      };
      expect(dryRunBody).toMatchObject({
        dry_run: true,
        summary: { planned: 1, restored: 0 },
      });
      expect(dryRunBody.items[0]).toMatchObject({
        destination_path: doc,
        status: "planned",
      });

      const restore = runMemory([
        "docs",
        "restore",
        doc,
        "--root",
        root,
        "--in-place",
        "--yes",
        "--json",
      ]);
      expect(restore.status, restore.stderr).toBe(0);
      const restoreBody = JSON.parse(restore.stdout) as {
        dry_run: boolean;
        summary: { restored: number; bytes: number };
      };
      expect(restoreBody).toMatchObject({
        dry_run: false,
        summary: { restored: 1 },
      });
      expect(await readFile(doc, "utf8")).toContain("JWT rotation requires signed fixtures");

      const outDir = join(root, "restored-copy");
      const restoreOut = runMemory([
        "docs",
        "restore",
        doc,
        "--root",
        root,
        "--out",
        outDir,
        "--yes",
        "--json",
      ]);
      expect(restoreOut.status, restoreOut.stderr).toBe(0);
      expect(await readFile(join(outDir, "docs/security.md"), "utf8")).toContain(
        "Security Guide",
      );
    },
    TIMEOUT,
  );
});
