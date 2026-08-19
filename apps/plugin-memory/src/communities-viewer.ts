import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";
import type {
  CommunityAnalyticsReport,
  CommunityAssignment,
  CommunitySummary,
} from "./communities.js";

export interface CommunitiesViewerArtifact {
  contract: {
    name: "memory.communities.viewer";
    version: "memory.communities.viewer.v1";
    consumes: "memory.communities.v1";
  };
  report: CommunityAnalyticsReport;
  html: string;
}

export function buildCommunitiesViewerArtifact(
  report: CommunityAnalyticsReport,
): CommunitiesViewerArtifact {
  return {
    contract: {
      name: "memory.communities.viewer",
      version: "memory.communities.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: renderCommunitiesViewer(report),
  };
}

function renderCommunitiesViewer(report: CommunityAnalyticsReport): string {
  const assignmentsByCommunity = new Map<string, CommunityAssignment[]>();
  for (const assignment of report.assignments) {
    const group = assignmentsByCommunity.get(assignment.community_id) ?? [];
    group.push(assignment);
    assignmentsByCommunity.set(assignment.community_id, group);
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory communities viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --ink: #202421;
      --muted: #657067;
      --line: #d8ddd4;
      --panel: #ffffff;
      --accent: #0b6f5d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    main { width: min(1180px, calc(100vw - 32px)); margin: 0 auto; padding: 28px 0 42px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: start;
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; letter-spacing: 0; overflow-wrap: anywhere; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 14px; margin-bottom: 5px; overflow-wrap: anywhere; }
    .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge, .pill {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 6px 10px;
      background: var(--panel);
      color: var(--accent);
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 20px 0;
    }
    .metric, section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 14px;
    }
    .metric strong { display: block; font-size: 22px; }
    .metric span { color: var(--muted); font-size: 13px; }
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .75fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
    li {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: start;
      border-top: 1px solid var(--line);
      padding-top: 12px;
    }
    li:first-child { border-top: 0; padding-top: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 900px) {
      header, .metrics, .layout, li { grid-template-columns: 1fr; }
      .badge, .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Graph Communities</h1>
        <p class="meta">Read-only RedDB graph community analytics with cache metadata.</p>
        <p class="meta"><code>${escapeHtml(report.graph_hash)}</code></p>
      </div>
      <div class="badge">${report.cached ? "cache hit" : "cache miss"}</div>
    </header>
    <div class="metrics">
      ${metric("Communities", report.communities.length)}
      ${metric("Assigned Nodes", report.assignments.length)}
      ${metric("Inter-community Edges", report.inter_community_edges.length)}
      ${metric("Bridge Nodes", report.bridge_nodes.length)}
    </div>
    <div class="layout">
      <div class="stack">
        <section>
          <h2>Communities</h2>
          ${report.communities.length === 0 ? `<p class="empty">No community assignments available. Ingest graph evidence, then refresh communities.</p>` : `<ul>${report.communities.map((community) => communityItem(community, assignmentsByCommunity.get(community.id) ?? [])).join("")}</ul>`}
        </section>
        <section>
          <h2>Bridge Nodes</h2>
          ${report.bridge_nodes.length === 0 ? `<p class="empty">No cross-community bridge nodes detected.</p>` : `<ul>${report.bridge_nodes.slice(0, 40).map(bridgeNodeItem).join("")}</ul>`}
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Bridge Edges</h2>
          ${report.bridge_edges.length === 0 ? `<p class="empty">No cross-community bridge edges detected.</p>` : `<ul>${report.bridge_edges.slice(0, 40).map(bridgeEdgeItem).join("")}</ul>`}
        </section>
        <section>
          <h2>Cache</h2>
          <p class="meta"><code>${escapeHtml(report.cache_key)}</code></p>
          <p class="meta">${escapeHtml(report.summary.next)}</p>
          <p class="meta">Communities are analytics over graph shape; they are not written back as durable Memory evidence.</p>
        </section>
        <section>
          <h2>Assignments</h2>
          ${report.assignments.length === 0 ? `<p class="empty">No assignments.</p>` : `<ul>${report.assignments.slice(0, 40).map(assignmentItem).join("")}</ul>`}
        </section>
      </div>
    </div>
    <script id="communities-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}

function communityItem(
  community: CommunitySummary,
  assignments: CommunityAssignment[],
): string {
  const nodeTypes = [...new Set(assignments.map((assignment) => assignment.node_type))].sort();
  return `<li>
    <div>
      <h3>${escapeHtml(community.short_label ?? community.id)}</h3>
      ${community.short_label ? `<p class="meta"><code>${escapeHtml(community.id)}</code></p>` : ""}
      <p class="meta">${escapeHtml(community.titles.join(", ") || "No titles")}</p>
      <p class="meta">${escapeHtml(nodeTypes.join(", ") || "unknown node types")}</p>
      <p class="meta">cohesion ${community.cohesion_score} - internal weight ${community.internal_edge_weight} - external weight ${community.external_edge_weight}</p>
      <p class="meta">degree ${community.total_degree} - centrality ${community.avg_centrality}</p>
    </div>
    <span class="pill">${community.count} node(s)</span>
  </li>`;
}

function bridgeNodeItem(node: CommunityAnalyticsReport["bridge_nodes"][number]): string {
  return `<li>
    <div>
      <h3>${escapeHtml(node.title)}</h3>
      <p class="meta"><code>memory_nodes:${node.rid}</code> - ${escapeHtml(node.label)} - ${escapeHtml(node.node_type)}</p>
      <p class="meta">communities ${escapeHtml(node.connected_community_ids.join(", "))} - ${node.cross_community_edge_count} edge(s), weight ${node.cross_community_weight}</p>
    </div>
    <span class="pill">${node.connected_community_count} communities</span>
  </li>`;
}

function bridgeEdgeItem(edge: CommunityAnalyticsReport["bridge_edges"][number]): string {
  return `<li>
    <div>
      <h3>${escapeHtml(edge.from_label)} -> ${escapeHtml(edge.to_label)}</h3>
      <p class="meta">${escapeHtml(edge.from_community_id)} -> ${escapeHtml(edge.to_community_id)} - ${escapeHtml(edge.label || "edge")}</p>
    </div>
    <span class="pill">${edge.weight}</span>
  </li>`;
}

function assignmentItem(assignment: CommunityAssignment): string {
  return `<li>
    <div>
      <h3>${escapeHtml(assignment.title)}</h3>
      <p class="meta"><code>memory_nodes:${assignment.rid}</code> - ${escapeHtml(assignment.label)} - ${escapeHtml(assignment.node_type)}</p>
    </div>
    <span class="pill">${escapeHtml(assignment.community_id)}</span>
  </li>`;
}
