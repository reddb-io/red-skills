import { createServer, type Server } from "node:http";
import type { KpiResult } from "@reddb-io/brain-store/kpi-query.js";
import type { StoredBrainArtifact, StoredBrainConnection } from "@reddb-io/brain-store/schema.js";
import type { BrainStoreLike } from "@reddb-io/brain-store/store.js";

export interface BrainDashboardOptions {
  project: string;
  rootDir: string;
  now?: number;
  decisionLimit?: number;
  connectionLimit?: number;
}

export interface BrainDashboard {
  schema_version: "brain.dashboard.v1";
  generated_at: string;
  project: string;
  root: string;
  stats: {
    artifacts: number;
    connections: number;
    decisions: number;
    events: number;
    supports: number;
    contradicts: number;
    depends_on: number;
  };
  kpis: {
    events_daily: KpiResult;
    events_by_platform: KpiResult;
    events_by_type: KpiResult;
  };
  recent_decisions: BrainDashboardDecision[];
  recent_connections: BrainDashboardConnection[];
  attribution: {
    red_hermes: string;
  };
}

export interface BrainDashboardDecision {
  rid: number;
  id: string;
  title: string;
  updated_at: string;
  tags: string[];
  connection_counts: {
    supports: number;
    contradicts: number;
    depends_on: number;
    related_to: number;
  };
  excerpt: string;
}

export interface BrainDashboardConnection {
  rid: number;
  kind: string;
  from: { rid: number; title: string };
  to: { rid: number; title: string };
  created_at: string;
  reason: string | null;
}

export interface BrainDashboardArtifact {
  contract: {
    name: "brain.dashboard.viewer";
    version: "brain.dashboard.viewer.v1";
    consumes: "brain.dashboard.v1";
  };
  html: string;
}

export async function buildBrainDashboard(
  store: BrainStoreLike,
  options: BrainDashboardOptions,
): Promise<BrainDashboard> {
  const artifacts = await store.listArtifacts();
  const connections = await store.listConnections();
  const artifactsByRid = new Map(artifacts.map((artifact) => [artifact.rid, artifact]));
  const eventsDaily = await store.eventKpis({ interval: "day" });
  const eventsByPlatform = await store.eventKpis({ interval: "day", groupBy: "platform" });
  const eventsByType = await store.eventKpis({ interval: "day", groupBy: "event_type" });
  const decisionLimit = options.decisionLimit ?? 8;
  const connectionLimit = options.connectionLimit ?? 12;

  return {
    schema_version: "brain.dashboard.v1",
    generated_at: new Date(options.now ?? Date.now()).toISOString(),
    project: options.project,
    root: options.rootDir,
    stats: {
      artifacts: artifacts.length,
      connections: connections.length,
      decisions: artifacts.filter((artifact) => artifact.kind === "decision").length,
      events: eventsDaily.total,
      supports: countConnections(connections, "supports"),
      contradicts: countConnections(connections, "contradicts"),
      depends_on: countConnections(connections, "depends_on"),
    },
    kpis: {
      events_daily: eventsDaily,
      events_by_platform: eventsByPlatform,
      events_by_type: eventsByType,
    },
    recent_decisions: artifacts
      .filter((artifact) => artifact.kind === "decision")
      .sort((a, b) => b.properties.updated_at - a.properties.updated_at || b.rid - a.rid)
      .slice(0, decisionLimit)
      .map((artifact) => summarizeDecision(artifact, connections)),
    recent_connections: connections
      .filter((connection) => artifactsByRid.has(connection.from_rid) && artifactsByRid.has(connection.to_rid))
      .sort((a, b) => b.properties.created_at - a.properties.created_at || b.rid - a.rid)
      .slice(0, connectionLimit)
      .map((connection) => summarizeConnection(connection, artifactsByRid)),
    attribution: {
      red_hermes:
        "Dashboard layout and command-center interaction model are adapted from the red-hermes web surface; NOTICE records the MIT attribution.",
    },
  };
}

export function buildBrainDashboardArtifact(dashboard: BrainDashboard): BrainDashboardArtifact {
  return {
    contract: {
      name: "brain.dashboard.viewer",
      version: "brain.dashboard.viewer.v1",
      consumes: "brain.dashboard.v1",
    },
    html: renderBrainDashboardHtml(dashboard),
  };
}

export async function serveBrainDashboardHtml(
  html: string,
  options: { host?: string; port?: number } = {},
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4738;
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/dashboard") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function summarizeDecision(
  artifact: StoredBrainArtifact,
  connections: StoredBrainConnection[],
): BrainDashboardDecision {
  const related = connections.filter((connection) => (
    connection.from_rid === artifact.rid || connection.to_rid === artifact.rid
  ));
  return {
    rid: artifact.rid,
    id: artifact.properties.id,
    title: artifact.properties.title,
    updated_at: new Date(artifact.properties.updated_at).toISOString(),
    tags: artifact.properties.tags,
    connection_counts: {
      supports: related.filter((connection) => connection.kind === "supports").length,
      contradicts: related.filter((connection) => connection.kind === "contradicts").length,
      depends_on: related.filter((connection) => connection.kind === "depends_on").length,
      related_to: related.filter((connection) => connection.kind === "related_to").length,
    },
    excerpt: excerpt(artifact.properties.content),
  };
}

function summarizeConnection(
  connection: StoredBrainConnection,
  artifactsByRid: Map<number, StoredBrainArtifact>,
): BrainDashboardConnection {
  const from = artifactsByRid.get(connection.from_rid);
  const to = artifactsByRid.get(connection.to_rid);
  if (!from || !to) {
    throw new Error(`connection ${connection.rid} references missing artifacts`);
  }
  return {
    rid: connection.rid,
    kind: connection.kind,
    from: { rid: from.rid, title: from.properties.title },
    to: { rid: to.rid, title: to.properties.title },
    created_at: new Date(connection.properties.created_at).toISOString(),
    reason: connection.properties.reason ?? null,
  };
}

function renderBrainDashboardHtml(dashboard: BrainDashboard): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Brain Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #17202a;
      --muted: #667085;
      --line: #d8dee8;
      --surface: #ffffff;
      --band: #f6f7f9;
      --accent: #2f6f73;
      --accent-2: #8b5f2a;
      --risk: #9f3a38;
      --good: #2f7d56;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--band);
      color: var(--ink);
      letter-spacing: 0;
    }
    header {
      display: grid;
      gap: 12px;
      padding: 28px clamp(18px, 4vw, 48px) 18px;
      border-bottom: 1px solid var(--line);
      background: var(--surface);
    }
    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.1;
      font-weight: 720;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 16px;
      line-height: 1.2;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    main {
      display: grid;
      gap: 18px;
      padding: 18px clamp(18px, 4vw, 48px) 48px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
    }
    .metric, section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(23, 32, 42, 0.04);
    }
    .metric {
      min-height: 92px;
      padding: 14px;
      display: grid;
      align-content: space-between;
      gap: 10px;
    }
    .metric strong {
      display: block;
      font-size: 26px;
      line-height: 1;
      font-weight: 760;
    }
    .metric span {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    section { padding: 16px; }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(280px, .8fr);
      gap: 18px;
      align-items: start;
    }
    .bars {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .bar {
      display: grid;
      grid-template-columns: 120px minmax(0, 1fr) 42px;
      gap: 10px;
      align-items: center;
      font-size: 13px;
    }
    .track {
      height: 10px;
      border-radius: 999px;
      background: #e8edf2;
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: var(--accent);
    }
    .feed {
      display: grid;
      gap: 10px;
    }
    .item {
      border-top: 1px solid var(--line);
      padding-top: 10px;
    }
    .item:first-child {
      border-top: 0;
      padding-top: 0;
    }
    .item h3 {
      margin: 0 0 5px;
      font-size: 14px;
      line-height: 1.3;
    }
    .tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .tag {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      color: var(--muted);
      background: #fbfcfd;
    }
    .edge {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      color: #fff;
      background: var(--accent-2);
    }
    .edge.supports { background: var(--good); }
    .edge.contradicts { background: var(--risk); }
    .empty {
      color: var(--muted);
      border-top: 1px solid var(--line);
      padding-top: 10px;
      font-size: 13px;
    }
    footer {
      padding: 0 clamp(18px, 4vw, 48px) 28px;
    }
    @media (max-width: 780px) {
      .grid { grid-template-columns: 1fr; }
      .bar { grid-template-columns: 86px minmax(0, 1fr) 34px; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(dashboard.project)} Brain Dashboard</h1>
    <div class="meta">${escapeHtml(dashboard.root)} - ${escapeHtml(dashboard.generated_at)}</div>
  </header>
  <main>
    <div class="metrics">
      ${metric("Artifacts", dashboard.stats.artifacts, "captured knowledge")}
      ${metric("Decisions", dashboard.stats.decisions, "curated choices")}
      ${metric("Events", dashboard.stats.events, "KpiQuery total")}
      ${metric("Connections", dashboard.stats.connections, "typed graph edges")}
      ${metric("Supports", dashboard.stats.supports, "positive evidence")}
      ${metric("Contradicts", dashboard.stats.contradicts, "open tension")}
    </div>
    <div class="grid">
      <section>
        <h2>Event KPIs</h2>
        <div class="meta">Derived from kind:event artifacts through KpiQuery. No separate metrics store.</div>
        ${kpiBars(dashboard.kpis.events_by_platform, "Platform")}
        ${kpiBars(dashboard.kpis.events_by_type, "Event type")}
      </section>
      <section>
        <h2>Recent Decisions</h2>
        <div class="feed">
          ${dashboard.recent_decisions.length === 0 ? empty("No decision artifacts captured yet.") : dashboard.recent_decisions.map(decisionItem).join("")}
        </div>
      </section>
    </div>
    <section>
      <h2>Recent Connections</h2>
      <div class="feed">
        ${dashboard.recent_connections.length === 0 ? empty("No graph connections captured yet.") : dashboard.recent_connections.map(connectionItem).join("")}
      </div>
    </section>
  </main>
  <footer class="meta">${escapeHtml(dashboard.attribution.red_hermes)}</footer>
  <script id="brain-dashboard-data" type="application/json">${jsonForScript(dashboard)}</script>
</body>
</html>`;
}

function metric(label: string, value: number, note: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong><div class="meta">${escapeHtml(note)}</div></div>`;
}

function kpiBars(kpi: KpiResult, title: string): string {
  const grouped = kpi.series.filter((series) => series.group != null);
  if (grouped.length === 0) return `<div class="empty">No ${escapeHtml(title.toLowerCase())} split available.</div>`;
  const max = Math.max(...grouped.map((series) => series.total), 1);
  return `<div class="bars" aria-label="${escapeHtml(title)}">${grouped.map((series) => {
    const label = series.group ?? "all";
    const width = Math.round((series.total / max) * 100);
    return `<div class="bar"><div class="meta">${escapeHtml(label)}</div><div class="track"><div class="fill" style="width:${width}%"></div></div><strong>${series.total}</strong></div>`;
  }).join("")}</div>`;
}

function decisionItem(decision: BrainDashboardDecision): string {
  const counts = decision.connection_counts;
  const tags = decision.tags.length === 0
    ? ""
    : `<div class="tags">${decision.tags.slice(0, 6).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`;
  return `<article class="item">
    <h3>${escapeHtml(decision.title)}</h3>
    <div class="meta">#${decision.rid} - ${escapeHtml(decision.updated_at)} - supports ${counts.supports}, contradicts ${counts.contradicts}, depends_on ${counts.depends_on}, related_to ${counts.related_to}</div>
    <p class="meta">${escapeHtml(decision.excerpt)}</p>
    ${tags}
  </article>`;
}

function connectionItem(connection: BrainDashboardConnection): string {
  return `<article class="item">
    <h3><span class="edge ${escapeHtml(connection.kind)}">${escapeHtml(connection.kind)}</span> ${escapeHtml(connection.from.title)} -> ${escapeHtml(connection.to.title)}</h3>
    <div class="meta">#${connection.rid} - ${escapeHtml(connection.created_at)}${connection.reason ? ` - ${escapeHtml(connection.reason)}` : ""}</div>
  </article>`;
}

function empty(text: string): string {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function countConnections(connections: StoredBrainConnection[], kind: string): number {
  return connections.filter((connection) => connection.kind === kind).length;
}

function excerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}
