import { describe, expect, test } from "vitest";
import { buildDocCoverageReport, type DocCoverageStore } from "../src/doc-coverage.js";
import { buildDocCoverageViewerArtifact } from "../src/doc-coverage-viewer.js";
import { buildDocReferenceGraphReport } from "../src/doc-reference-graph.js";
import { buildDocReferenceGraphViewerArtifact } from "../src/doc-reference-graph-viewer.js";

describe("doc coverage report", () => {
  test("reports document graph grounding, references, and vector doc status", async () => {
    const store: DocCoverageStore = {
      async listDocs() {
        return [
          {
            rid: 10,
            path: "docs/security.md",
            title: "Security",
            body: "JWT docs",
            frontmatter: {},
            hash: "doc-hash",
            updated_at: 123,
          },
        ];
      },
      async listNodes() {
        return [
          {
            rid: 1,
            label: "md:docs/security.md",
            node_type: "concept",
            properties: { title: "Security", hash: "doc-hash" },
          },
          {
            rid: 2,
            label: "entity:jwt_secret",
            node_type: "concept",
            properties: { title: "JWT_SECRET", tags: ["entity", "identifier"] },
          },
        ];
      },
      async listEdges() {
        return [{ from: 1, to: 2, label: "REFERENCES" }];
      },
      async vectorStatus() {
        return {
          schema_version: "memory.vector_status.v1",
          read_only: true,
          overall: "ready",
          total: 1,
          ready: 1,
          stale: 0,
          unavailable: 0,
          failed: 0,
          nodes: [],
          docs: [
            {
              source_collection: "memory_docs",
              rid: 10,
              path: "docs/security.md",
              title: "Security",
              status: "ready",
              text_hash: "hash",
            },
          ],
        };
      },
    };

    const report = await buildDocCoverageReport(store);

    expect(report).toMatchObject({
      schema_version: "memory.doc_coverage.v1",
      read_only: true,
      total_docs: 1,
      grounded_docs: 1,
      ungrounded_docs: 0,
      docs_with_references: 1,
      total_references: 1,
      vector: { overall: "ready", ready: 1 },
      docs: [
        {
          path: "docs/security.md",
          graph_status: "grounded",
          root_node: { rid: 1, label: "md:docs/security.md" },
          references: {
            count: 1,
            examples: [{ rid: 2, title: "JWT_SECRET" }],
          },
          vector_status: "ready",
        },
      ],
      warnings: [],
    });

    const artifact = buildDocCoverageViewerArtifact(report);
    expect(artifact.contract).toEqual({
      name: "memory.doc_coverage.viewer",
      version: "memory.doc_coverage.viewer.v1",
      consumes: "memory.doc_coverage.v1",
    });
    expect(artifact.html).toContain("Documentation Coverage");
    expect(artifact.html).toContain("JWT_SECRET");
    expect(artifact.html).toContain('id="doc-coverage-data"');

    const referenceGraph = await buildDocReferenceGraphReport(store);
    expect(referenceGraph).toMatchObject({
      schema_version: "memory.doc_reference_graph.v1",
      read_only: true,
      total_docs: 1,
      grounded_docs: 1,
      reference_nodes: 1,
      reference_edges: 1,
      nodes: [
        expect.objectContaining({
          id: "doc:10",
          kind: "doc",
          title: "Security",
          outgoing_references: 1,
        }),
        expect.objectContaining({
          id: "ref:2",
          kind: "reference",
          title: "JWT_SECRET",
          incoming_docs: 1,
        }),
      ],
      edges: [
        expect.objectContaining({
          from: "doc:10",
          to: "ref:2",
          label: "REFERENCES",
          source_doc_path: "docs/security.md",
        }),
      ],
      top_references: [
        expect.objectContaining({
          incoming_docs: 1,
          node: expect.objectContaining({ title: "JWT_SECRET" }),
        }),
      ],
      warnings: [],
    });

    const referenceGraphArtifact = buildDocReferenceGraphViewerArtifact(referenceGraph);
    expect(referenceGraphArtifact.contract).toEqual({
      name: "memory.doc_reference_graph.viewer",
      version: "memory.doc_reference_graph.viewer.v1",
      consumes: "memory.doc_reference_graph.v1",
    });
    expect(referenceGraphArtifact.html).toContain("Documentation Reference Graph");
    expect(referenceGraphArtifact.html).toContain("JWT_SECRET");
    expect(referenceGraphArtifact.html).toContain('id="doc-reference-graph-data"');
    expect(referenceGraphArtifact.html).toContain("<svg");
  });
});
