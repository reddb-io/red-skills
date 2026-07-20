import { expect } from "vitest";
import { decode } from "@reddb-io/toon";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolResult } from "./mcp-server-test-fixtures.js";

export async function runRegistryDiscoveryAndDocumentationTools(client: Client): Promise<void> {
  const dashboardRes = (await client.callTool({
    name: "memory_dashboard",
    arguments: {},
  })) as ToolResult;
  const dashboard = decode(dashboardRes.content[0]?.text ?? "{}") as {
    contract: { version: string };
    dashboard: { schema_version: string; stats: { nodes: number; docs: number } };
    html: string;
  };
  expect(dashboard.contract.version).toBe("memory.operational_dashboard.viewer.v1");
  expect(dashboard.dashboard.schema_version).toBe("memory.operational_dashboard.v1");
  expect(dashboard.dashboard.stats).toMatchObject({ nodes: 3, docs: 1 });
  expect(dashboard.html).toContain("Memory Operational Dashboard");
  expect(dashboard.html).toContain('id="memory-dashboard-data"');
  expect(dashboardRes.structuredContent).toMatchObject({
    operation_id: "memory.dashboard",
    consumes: "memory.operational_dashboard.v1",
    nodes: 3,
    docs: 1,
  });

  const capabilityRes = (await client.callTool({
    name: "memory_capability_catalog",
    arguments: {},
  })) as ToolResult;
  const capabilityCatalog = decode(capabilityRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    runtime: { stats: { nodes: number; edges: number }; docs: { total: number } };
    categories: Array<{ id: string }>;
    capabilities: Array<{ id: string; mcp: string[] }>;
  };
  expect(capabilityCatalog.schema_version).toBe("memory.capability_catalog.v1");
  expect(capabilityCatalog.runtime.stats).toMatchObject({ nodes: 3, edges: 2 });
  expect(capabilityCatalog.runtime.docs.total).toBe(1);
  expect(capabilityCatalog.categories.map((category) => category.id)).toContain("ui");
  expect(
    capabilityCatalog.capabilities.find((item) => item.id === "local-ui")?.mcp,
  ).toContain("memory_dashboard");
  expect(
    capabilityCatalog.capabilities.find((item) => item.id === "layered-memory-architecture")?.mcp,
  ).toContain("memory_layers");
  expect(
    capabilityCatalog.capabilities.find((item) => item.id === "layered-memory-architecture")?.mcp,
  ).toContain("memory_layers_viewer");
  expect(capabilityRes.structuredContent).toMatchObject({
    operation_id: "memory.capability-catalog",
    schema_version: "memory.capability_catalog.v1",
    total: capabilityCatalog.capabilities.length,
    nodes: 3,
    read_only: true,
  });

  const extractionStatusRes = (await client.callTool({
    name: "memory_extraction_status",
    arguments: {},
  })) as ToolResult;
  const extractionStatus = decode(extractionStatusRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    deterministic: { markdown_entities: boolean };
    inferred: { available: boolean; facts: number };
  };
  expect(extractionStatus.schema_version).toBe("memory.extraction_status.v1");
  expect(extractionStatus.deterministic.markdown_entities).toBe(true);
  expect(extractionStatusRes.structuredContent).toMatchObject({
    operation_id: "memory.extraction-status",
    schema_version: "memory.extraction_status.v1",
    deterministic_ready: expect.any(Number),
    inferred_available: false,
  });

  const extractionViewerRes = (await client.callTool({
    name: "memory_extraction_status_viewer",
    arguments: {},
  })) as ToolResult;
  const extractionViewer = decode(extractionViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    status: { schema_version: string; inferred: { available: boolean } };
    html: string;
  };
  expect(extractionViewer.contract).toMatchObject({
    version: "memory.extraction_status.viewer.v1",
    consumes: "memory.extraction_status.v1",
  });
  expect(extractionViewer.status.schema_version).toBe("memory.extraction_status.v1");
  expect(extractionViewer.html).toContain("Extraction Status");
  expect(extractionViewer.html).toContain('id="extraction-status-data"');
  expect(extractionViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.extraction-status-viewer",
    contract: "memory.extraction_status.viewer.v1",
    consumes: "memory.extraction_status.v1",
    html_bytes: expect.any(Number),
  });

  const layersRes = (await client.callTool({
    name: "memory_layers",
    arguments: {},
  })) as ToolResult;
  const layers = decode(layersRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    layers: Array<{ id: string }>;
  };
  expect(layers.schema_version).toBe("memory.memory_layers.v1");
  expect(layers.layers.map((layer) => layer.id)).toEqual(
    expect.arrayContaining(["short-term", "long-term", "reasoning", "docs-code", "vectors"]),
  );
  expect(layersRes.structuredContent).toMatchObject({
    operation_id: "memory.layers",
    schema_version: "memory.memory_layers.v1",
    total_layers: 5,
    layers: 5,
    read_only: true,
  });

  const layersViewerRes = (await client.callTool({
    name: "memory_layers_viewer",
    arguments: {},
  })) as ToolResult;
  const layersViewer = decode(layersViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    report: { schema_version: string; summary: { total_layers: number } };
    html: string;
  };
  expect(layersViewer.contract).toMatchObject({
    version: "memory.layers.viewer.v1",
    consumes: "memory.memory_layers.v1",
  });
  expect(layersViewer.report.summary.total_layers).toBe(5);
  expect(layersViewer.html).toContain("Memory Layers");
  expect(layersViewer.html).toContain('id="memory-layers-data"');
  expect(layersViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.layers-viewer",
    contract: "memory.layers.viewer.v1",
    consumes: "memory.memory_layers.v1",
    total_layers: 5,
    html_bytes: expect.any(Number),
  });

  const radarRes = (await client.callTool({
    name: "memory_references_radar",
    arguments: {},
  })) as ToolResult;
  const radar = decode(radarRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    summary: { references: number };
    references: Array<{ id: string; repository: string }>;
  };
  expect(radar.schema_version).toBe("memory.reference_radar.v1");
  expect(radar.summary.references).toBe(5);
  expect(radar.references.find((item) => item.id === "agentmemory")?.repository).toBe(
    "rohitg00/agentmemory",
  );
  expect(radarRes.structuredContent).toMatchObject({
    operation_id: "memory.references-radar",
    schema_version: "memory.reference_radar.v1",
    references: 5,
    read_only: true,
  });

  const docSearchRes = (await client.callTool({
    name: "memory_doc_search",
    arguments: { query: "jwt rotation", limit: 3 },
  })) as ToolResult;
  const docSearch = decode(docSearchRes.content[0]?.text ?? "{}") as {
    total_docs: number;
    hits: Array<{ path: string; excerpt: string; matched_fields: string[] }>;
  };
  expect(docSearch.total_docs).toBe(1);
  expect(docSearch.hits[0]).toMatchObject({
    path: "docs/jwt.md",
    matched_fields: expect.arrayContaining(["body"]),
  });
  expect(docSearch.hits[0].excerpt).toContain("jwt tokens rotate");
  expect(docSearchRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-search",
    query: "jwt rotation",
    total_docs: 1,
    hits: 1,
  });

  const docSearchViewerRes = (await client.callTool({
    name: "memory_doc_search_viewer",
    arguments: { query: "jwt rotation", limit: 2 },
  })) as ToolResult;
  const docSearchViewer = decode(
    docSearchViewerRes.content[0]?.text ?? "{}",
  ) as {
    contract: { version: string; consumes: string };
    report: { query: string; hits: unknown[] };
    html: string;
  };
  expect(docSearchViewer.contract).toMatchObject({
    version: "memory.doc_search.viewer.v1",
    consumes: "memory.doc_search.v1",
  });
  expect(docSearchViewer.report.hits.length).toBe(1);
  expect(docSearchViewer.html).toContain("Documentation Search");
  expect(docSearchViewer.html).toContain('id="doc-search-data"');
  expect(docSearchViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-search-viewer",
    contract: "memory.doc_search.viewer.v1",
    consumes: "memory.doc_search.v1",
    hits: 1,
  });

  const docBriefRes = (await client.callTool({
    name: "memory_doc_brief",
    arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
  })) as ToolResult;
  const docBrief = decode(docBriefRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    status: string;
    citations: Array<{ marker: string; path: string }>;
    markdown: string;
  };
  expect(docBrief).toMatchObject({
    schema_version: "memory.doc_brief.v1",
    status: "partial",
    citations: [expect.objectContaining({ marker: "[D1]", path: "docs/jwt.md" })],
  });
  expect(docBrief.markdown).toContain("Memory Docs Brief");
  expect(docBrief.markdown).toContain("D1");
  expect(docBriefRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-brief",
    schema_version: "memory.doc_brief.v1",
    citations: 1,
    read_only: true,
  });

  const docBriefViewerRes = (await client.callTool({
    name: "memory_doc_brief_viewer",
    arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
  })) as ToolResult;
  const docBriefViewer = decode(docBriefViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    brief: { schema_version: string; citations: unknown[]; status: string };
    html: string;
  };
  expect(docBriefViewer.contract).toMatchObject({
    version: "memory.doc_brief.viewer.v1",
    consumes: "memory.doc_brief.v1",
  });
  expect(docBriefViewer.brief.citations.length).toBe(1);
  expect(docBriefViewer.html).toContain("Documentation Brief");
  expect(docBriefViewer.html).toContain('id="doc-brief-data"');
  expect(docBriefViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-brief-viewer",
    contract: "memory.doc_brief.viewer.v1",
    consumes: "memory.doc_brief.v1",
    citations: 1,
    read_only: true,
  });

  const docBundleRes = (await client.callTool({
    name: "memory_doc_bundle",
    arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
  })) as ToolResult;
  const docBundle = decode(docBundleRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    query: string;
    hits: unknown[];
    packs: unknown[];
    markdown: string;
  };
  expect(docBundle).toMatchObject({
    schema_version: "memory.doc_bundle.v1",
    query: "jwt rotation",
  });
  expect(docBundle.hits.length).toBe(1);
  expect(docBundle.packs.length).toBe(1);
  expect(docBundle.markdown).toContain("Memory Docs Bundle");
  expect(docBundle.markdown).toContain("Memory Doc Evidence Pack");
  expect(docBundleRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-bundle",
    schema_version: "memory.doc_bundle.v1",
    hits: 1,
    packs: 1,
    read_only: true,
  });

  const docBundleViewerRes = (await client.callTool({
    name: "memory_doc_bundle_viewer",
    arguments: { query: "jwt rotation", limit: 2, max_bytes: 120 },
  })) as ToolResult;
  const docBundleViewer = decode(
    docBundleViewerRes.content[0]?.text ?? "{}",
  ) as {
    contract: { version: string; consumes: string };
    bundle: { schema_version: string; hits: unknown[]; packs: unknown[] };
    html: string;
  };
  expect(docBundleViewer.contract).toMatchObject({
    version: "memory.doc_bundle.viewer.v1",
    consumes: "memory.doc_bundle.v1",
  });
  expect(docBundleViewer.bundle.hits.length).toBe(1);
  expect(docBundleViewer.bundle.packs.length).toBe(1);
  expect(docBundleViewer.html).toContain("Documentation Bundle");
  expect(docBundleViewer.html).toContain('id="doc-bundle-data"');
  expect(docBundleViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-bundle-viewer",
    contract: "memory.doc_bundle.viewer.v1",
    consumes: "memory.doc_bundle.v1",
    hits: 1,
    packs: 1,
    read_only: true,
  });

  const smartSearchRes = (await client.callTool({
    name: "memory_smart_search",
    arguments: { query: "jwt rotation", limit: 3 },
  })) as ToolResult;
  const smartSearch = decode(smartSearchRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    summary: { recall_hits: number; doc_hits: number };
    top_results: unknown[];
  };
  expect(smartSearch.schema_version).toBe("memory.smart_search.v1");
  expect(smartSearch.summary.recall_hits).toBeGreaterThan(0);
  expect(smartSearch.summary.doc_hits).toBe(1);
  expect(smartSearch.top_results.length).toBeGreaterThan(0);
  expect(smartSearchRes.structuredContent).toMatchObject({
    operation_id: "memory.smart-search",
    schema_version: "memory.smart_search.v1",
    doc_hits: 1,
    top_results: smartSearch.top_results.length,
  });

  const smartSearchViewerRes = (await client.callTool({
    name: "memory_smart_search_viewer",
    arguments: { query: "jwt rotation", limit: 3 },
  })) as ToolResult;
  const smartSearchViewer = decode(
    smartSearchViewerRes.content[0]?.text ?? "{}",
  ) as {
    contract: { version: string };
    report: { query: string; top_results: unknown[] };
    html: string;
  };
  expect(smartSearchViewer.contract.version).toBe("memory.smart_search.viewer.v1");
  expect(smartSearchViewer.report.query).toBe("jwt rotation");
  expect(smartSearchViewer.html).toContain("Smart Search");
  expect(smartSearchViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.smart-search-viewer",
    contract: "memory.smart_search.viewer.v1",
    query: "jwt rotation",
    top_results: smartSearchViewer.report.top_results.length,
  });

  const docReadRes = (await client.callTool({
    name: "memory_doc_read",
    arguments: { path: "docs/jwt.md", max_bytes: 20 },
  })) as ToolResult;
  const docRead = decode(docReadRes.content[0]?.text ?? "{}") as {
    found: boolean;
    path: string;
    body: string;
    truncated: boolean;
  };
  expect(docRead).toMatchObject({
    found: true,
    path: "docs/jwt.md",
    truncated: true,
  });
  expect(docRead.body).toContain("jwt tokens");
  expect(docReadRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-read",
    found: true,
    path: "docs/jwt.md",
    truncated: true,
  });

  const docRelatedRes = (await client.callTool({
    name: "memory_doc_related",
    arguments: { path: "docs/jwt.md" },
  })) as ToolResult;
  const docRelated = decode(docRelatedRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    found: boolean;
    references: unknown[];
    related_docs: unknown[];
  };
  expect(docRelated).toMatchObject({
    schema_version: "memory.doc_related.v1",
    found: true,
  });
  expect(Array.isArray(docRelated.references)).toBe(true);
  expect(Array.isArray(docRelated.related_docs)).toBe(true);
  expect(docRelatedRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-related",
    schema_version: "memory.doc_related.v1",
    found: true,
    read_only: true,
  });

  const docEvidencePackRes = (await client.callTool({
    name: "memory_doc_evidence_pack",
    arguments: { path: "docs/jwt.md", max_bytes: 120 },
  })) as ToolResult;
  const docEvidencePack = decode(
    docEvidencePackRes.content[0]?.text ?? "{}",
  ) as {
    schema_version: string;
    found: boolean;
    markdown: string;
    related: { references: unknown[] };
  };
  expect(docEvidencePack).toMatchObject({
    schema_version: "memory.doc_evidence_pack.v1",
    found: true,
  });
  expect(docEvidencePack.markdown).toContain("Memory Doc Evidence Pack");
  expect(docEvidencePack.markdown).toContain("docs/jwt.md");
  expect(Array.isArray(docEvidencePack.related.references)).toBe(true);
  expect(docEvidencePackRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-evidence-pack",
    schema_version: "memory.doc_evidence_pack.v1",
    found: true,
    read_only: true,
  });

  const docEvidencePackViewerRes = (await client.callTool({
    name: "memory_doc_evidence_pack_viewer",
    arguments: { path: "docs/jwt.md", max_bytes: 120 },
  })) as ToolResult;
  const docEvidencePackViewer = decode(
    docEvidencePackViewerRes.content[0]?.text ?? "{}",
  ) as {
    contract: { version: string; consumes: string };
    pack: { schema_version: string; found: boolean };
    html: string;
  };
  expect(docEvidencePackViewer.contract).toMatchObject({
    version: "memory.doc_evidence_pack.viewer.v1",
    consumes: "memory.doc_evidence_pack.v1",
  });
  expect(docEvidencePackViewer.pack).toMatchObject({
    schema_version: "memory.doc_evidence_pack.v1",
    found: true,
  });
  expect(docEvidencePackViewer.html).toContain("Doc Evidence Pack");
  expect(docEvidencePackViewer.html).toContain('id="doc-evidence-pack-data"');
  expect(docEvidencePackViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-evidence-pack-viewer",
    contract: "memory.doc_evidence_pack.viewer.v1",
    consumes: "memory.doc_evidence_pack.v1",
    references: 1,
    read_only: true,
  });

  const docRelatedViewerRes = (await client.callTool({
    name: "memory_doc_related_viewer",
    arguments: { path: "docs/jwt.md" },
  })) as ToolResult;
  const docRelatedViewer = decode(docRelatedViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string; consumes: string };
    html: string;
  };
  expect(docRelatedViewer.contract).toMatchObject({
    version: "memory.doc_related.viewer.v1",
    consumes: "memory.doc_related.v1",
  });
  expect(docRelatedViewer.html).toContain("Related Documentation");
  expect(docRelatedViewer.html).toContain('id="doc-related-data"');
  expect(docRelatedViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-related-viewer",
    consumes: "memory.doc_related.v1",
    found: true,
  });

  const docBacklinksRes = (await client.callTool({
    name: "memory_doc_backlinks",
    arguments: { query: "cache-ttl" },
  })) as ToolResult;
  const docBacklinks = decode(docBacklinksRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    found: boolean;
    references: unknown[];
    docs: unknown[];
  };
  expect(docBacklinks).toMatchObject({
    schema_version: "memory.doc_backlinks.v1",
    found: true,
  });
  expect(Array.isArray(docBacklinks.references)).toBe(true);
  expect(Array.isArray(docBacklinks.docs)).toBe(true);
  expect(docBacklinksRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-backlinks",
    schema_version: "memory.doc_backlinks.v1",
    found: true,
    read_only: true,
  });

  const docBacklinksViewerRes = (await client.callTool({
    name: "memory_doc_backlinks_viewer",
    arguments: { query: "cache-ttl" },
  })) as ToolResult;
  const docBacklinksViewer = decode(
    docBacklinksViewerRes.content[0]?.text ?? "{}",
  ) as {
    contract: { version: string; consumes: string };
    html: string;
  };
  expect(docBacklinksViewer.contract).toMatchObject({
    version: "memory.doc_backlinks.viewer.v1",
    consumes: "memory.doc_backlinks.v1",
  });
  expect(docBacklinksViewer.html).toContain("Documentation Backlinks");
  expect(docBacklinksViewer.html).toContain('id="doc-backlinks-data"');
  expect(docBacklinksViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-backlinks-viewer",
    consumes: "memory.doc_backlinks.v1",
    found: true,
  });

  const docCoverageRes = (await client.callTool({
    name: "memory_doc_coverage",
    arguments: {},
  })) as ToolResult;
  const docCoverage = decode(docCoverageRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    total_docs: number;
    grounded_docs: number;
    docs_with_references: number;
    docs: Array<{ path: string; graph_status: string; vector_status: string }>;
  };
  expect(docCoverage).toMatchObject({
    schema_version: "memory.doc_coverage.v1",
    total_docs: 1,
    grounded_docs: 1,
    docs_with_references: 1,
  });
  expect(docCoverage.docs[0]).toMatchObject({
    path: "docs/jwt.md",
    graph_status: "grounded",
    vector_status: "unavailable",
  });
  expect(docCoverageRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-coverage",
    schema_version: "memory.doc_coverage.v1",
    total_docs: 1,
    grounded_docs: 1,
    read_only: true,
  });

  const docCoverageViewerRes = (await client.callTool({
    name: "memory_doc_coverage_viewer",
    arguments: {},
  })) as ToolResult;
  const docCoverageViewer = decode(docCoverageViewerRes.content[0]?.text ?? "{}") as {
    contract: { version: string };
    html: string;
  };
  expect(docCoverageViewer.contract.version).toBe("memory.doc_coverage.viewer.v1");
  expect(docCoverageViewer.html).toContain("Documentation Coverage");
  expect(docCoverageViewer.html).toContain('id="doc-coverage-data"');
  expect(docCoverageViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-coverage-viewer",
    consumes: "memory.doc_coverage.v1",
    total_docs: 1,
    grounded_docs: 1,
  });

  const docReferenceGraphRes = (await client.callTool({
    name: "memory_doc_reference_graph",
    arguments: {},
  })) as ToolResult;
  const docReferenceGraph = decode(docReferenceGraphRes.content[0]?.text ?? "{}") as {
    schema_version: string;
    total_docs: number;
    reference_edges: number;
  };
  expect(docReferenceGraph).toMatchObject({
    schema_version: "memory.doc_reference_graph.v1",
    total_docs: 1,
  });
  expect(docReferenceGraph.reference_edges).toBeGreaterThanOrEqual(0);
  expect(docReferenceGraphRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-reference-graph",
    schema_version: "memory.doc_reference_graph.v1",
    total_docs: 1,
    read_only: true,
  });

  const docReferenceGraphViewerRes = (await client.callTool({
    name: "memory_doc_reference_graph_viewer",
    arguments: {},
  })) as ToolResult;
  const docReferenceGraphViewer = decode(
    docReferenceGraphViewerRes.content[0]?.text ?? "{}",
  ) as {
    contract: { version: string; consumes: string };
    html: string;
  };
  expect(docReferenceGraphViewer.contract).toMatchObject({
    version: "memory.doc_reference_graph.viewer.v1",
    consumes: "memory.doc_reference_graph.v1",
  });
  expect(docReferenceGraphViewer.html).toContain("Documentation Reference Graph");
  expect(docReferenceGraphViewer.html).toContain('id="doc-reference-graph-data"');
  expect(docReferenceGraphViewerRes.structuredContent).toMatchObject({
    operation_id: "memory.doc-reference-graph-viewer",
    consumes: "memory.doc_reference_graph.v1",
    total_docs: 1,
  });

}
