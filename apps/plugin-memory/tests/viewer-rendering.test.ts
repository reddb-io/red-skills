import { describe, expect, test } from "vitest";
import type { DocCoverageReport } from "../src/doc-coverage.js";
import { buildDocCoverageViewerArtifact } from "../src/doc-coverage-viewer.js";
import type { PathExplainReport } from "../src/path-explain.js";
import { buildPathExplainViewerArtifact } from "../src/path-explain-viewer.js";
import { buildMemoryRoutingGuide } from "../src/routing-guide.js";
import { buildMemoryRoutingGuideViewerArtifact } from "../src/routing-guide-viewer.js";

describe("Memory viewer rendering", () => {
  test("keeps doc coverage viewer HTML stable", () => {
    const report: DocCoverageReport = {
      schema_version: "memory.doc_coverage.v1",
      read_only: true,
      total_docs: 1,
      grounded_docs: 1,
      ungrounded_docs: 0,
      docs_with_references: 1,
      total_references: 1,
      vector: {
        overall: "ready",
        total: 1,
        ready: 1,
        stale: 0,
        unavailable: 0,
        failed: 0,
      },
      docs: [
        {
          rid: 7,
          path: "docs/security.md",
          title: "Security <Guide>",
          hash: "abc123",
          body_bytes: 42,
          truncated: false,
          graph_status: "grounded",
          root_node: {
            rid: 11,
            label: "security-guide",
            node_type: "concept",
            title: "Security Guide",
          },
          references: {
            count: 1,
            examples: [
              {
                rid: 12,
                label: "auth",
                node_type: "decision",
                title: "Auth Decision",
              },
            ],
          },
          vector_status: "ready",
        },
      ],
      warnings: ["review <references>"],
    };

    expect(buildDocCoverageViewerArtifact(report).html).toMatchSnapshot();
  });

  test("keeps path explanation viewer HTML stable", () => {
    const report: PathExplainReport = {
      schema_version: "memory.path_explain.v1",
      read_only: true,
      request: { from: "auth-service", to: "jwt-rotation", max_depth: 4 },
      reachable: true,
      hop_count: 1,
      path: [
        {
          rid: 1,
          label: "auth-service",
          node_type: "concept",
          title: "Auth service",
          confidence: 0.9,
        },
        {
          rid: 2,
          label: "jwt-rotation",
          node_type: "decision",
          title: "JWT rotation",
          confidence: 0.8,
        },
      ],
      edges: [
        {
          from: {
            rid: 1,
            label: "auth-service",
            node_type: "concept",
            title: "Auth service",
            confidence: 0.9,
          },
          to: {
            rid: 2,
            label: "jwt-rotation",
            node_type: "decision",
            title: "JWT rotation",
            confidence: 0.8,
          },
          label: "REFERENCES",
        },
      ],
      markdown: "Auth service references JWT rotation.",
      recommended_next_actions: ["Inspect related evidence"],
      path_confidence: 0.8,
    };

    expect(buildPathExplainViewerArtifact(report).html).toMatchSnapshot();
  });

  test("keeps routing guide viewer HTML stable", () => {
    const guide = buildMemoryRoutingGuide({ agent: "codex" });

    expect(buildMemoryRoutingGuideViewerArtifact(guide).html).toMatchSnapshot();
  });
});
