import type { StoredNode, VectorStatusReport } from "../graph-store.js";
import { escapeHtmlNoSingleQuote as escapeHtml } from "../viewer-utils.js";
import type { CommunityExportModel, DashboardModel, ExportEdge, StoredDoc } from "./core.js";

type SemanticLaneSummary = {
  seal_distribution: Record<string, { nodes: number; edges: number; total: number }>;
  inferred_nodes: number;
  inferred_edges: number;
  token_cost: { input: number; output: number } | null;
};

function exportVectorStatus(vector: VectorStatusReport): Record<string, unknown> {
  return {
    overall: vector.overall,
    total: vector.total,
    ready: vector.ready,
    stale: vector.stale,
    unavailable: vector.unavailable,
    failed: vector.failed,
    nodes: vector.nodes.map((node) => ({
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      source_collection: node.source_collection,
      status: node.status,
      error: node.error,
      updated_at: node.updated_at,
    })),
    docs: vector.docs.map((doc) => ({
      rid: doc.rid,
      path: doc.path,
      title: doc.title,
      source_collection: doc.source_collection,
      status: doc.status,
      error: doc.error,
      updated_at: doc.updated_at,
    })),
  };
}

function confidenceValue(props: Record<string, unknown>): string | null {
  const value = props.confidence;
  return typeof value === "string" && value.trim() ? value : null;
}

function auditSeal(props: Record<string, unknown>): string {
  const value = props.audit_seal ?? props.confidence;
  return typeof value === "string" && value.trim() ? value : "AMBIGUOUS";
}

function confidenceBand(props: Record<string, unknown>): string | null {
  const value = props.confidence_band;
  return typeof value === "string" && value.trim() ? value : null;
}

function semanticLane(props: Record<string, unknown>): "INFERRED" | "EXTRACTED" | "AMBIGUOUS" {
  const seal = auditSeal(props);
  if (seal === "INFERRED" || seal === "EXTRACTED") return seal;
  return "AMBIGUOUS";
}

function buildSemanticLaneSummary(nodes: StoredNode[], edges: ExportEdge[]): SemanticLaneSummary {
  const sealDistribution: Record<string, { nodes: number; edges: number; total: number }> = {};
  const bump = (seal: string, kind: "nodes" | "edges") => {
    const current = sealDistribution[seal] ?? { nodes: 0, edges: 0, total: 0 };
    current[kind] += 1;
    current.total += 1;
    sealDistribution[seal] = current;
  };
  for (const node of nodes) bump(auditSeal(node.properties), "nodes");
  for (const edge of edges) bump(auditSeal(edge.properties), "edges");
  return {
    seal_distribution: sealDistribution,
    inferred_nodes: nodes.filter((node) => semanticLane(node.properties) === "INFERRED").length,
    inferred_edges: edges.filter((edge) => semanticLane(edge.properties) === "INFERRED").length,
    token_cost: semanticTokenCost(nodes),
  };
}

function semanticTokenCost(nodes: StoredNode[]): { input: number; output: number } | null {
  for (const node of nodes) {
    const input = Number(node.properties.semantic_token_input);
    const output = Number(node.properties.semantic_token_output);
    if (Number.isFinite(input) && Number.isFinite(output) && (input > 0 || output > 0)) {
      return { input, output };
    }
  }
  return null;
}

function edgeKey(edge: Pick<{ from_rid: number; to_rid: number; label: string }, "from_rid" | "to_rid" | "label">): string {
  return `${edge.from_rid}\u0000${edge.to_rid}\u0000${edge.label}`;
}

// ---------------------------------------------------------------------------
// graph.html
// ---------------------------------------------------------------------------

/** Escape a string for safe inlining inside a `<script>` JSON literal. The data
 *  is serialized with JSON.stringify then `<` is broken so the browser can't
 *  see a stray `</script>`. */
function inlineJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

/**
 * Deterministic colour per community id (golden-angle hue spread). Stable for a
 * given set of ids so the same export always paints the same clusters.
 */
function communityPalette(ids: string[]): Record<string, string> {
  const palette: Record<string, string> = {};
  ids.forEach((id, i) => {
    const hue = Math.round((i * 137.508) % 360);
    palette[id] = `hsl(${hue}, 65%, 60%)`;
  });
  return palette;
}

export function renderHtml(
  nodes: StoredNode[],
  edges: ExportEdge[],
  stats: { nodes: number; edges: number },
  docs: StoredDoc[],
  vector: VectorStatusReport,
  communityModel: CommunityExportModel,
  dashboard: DashboardModel,
): string {
  const communities = communityModel.assignments;
  const semantic = buildSemanticLaneSummary(nodes, edges);
  const palette = communityPalette([...new Set(communities.values())].sort());
  const data = {
    nodes: nodes.map((n) => ({
      rid: n.rid,
      label: n.label,
      type: n.node_type,
      title: n.properties.title ?? n.label,
      excerpt: String(n.properties.summary ?? n.properties.content ?? "").slice(0, 280),
      community: communities.get(n.rid) ?? null,
      community_label: communities.get(n.rid)
        ? communityModel.labels.get(communities.get(n.rid) as string) ?? communities.get(n.rid)
        : null,
      confidence: confidenceValue(n.properties),
      audit_seal: auditSeal(n.properties),
      confidence_band: confidenceBand(n.properties),
      semantic_lane: semanticLane(n.properties),
      navigation: communityModel.navigation.get(n.rid) ?? null,
      statuses: dashboard.nodeStatuses.get(n.rid) ?? ["active"],
    })),
    edges: edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
      confidence: confidenceValue(e.properties),
      audit_seal: auditSeal(e.properties),
      confidence_band: confidenceBand(e.properties),
      semantic_lane: semanticLane(e.properties),
      bridge: communityModel.bridgeEdges.has(edgeKey({ from_rid: e.from, to_rid: e.to, label: e.label })),
    })),
    docs: docs.map((doc) => ({
      rid: doc.rid,
      path: doc.path,
      title: doc.title ?? null,
      body_length: doc.body.length,
    })),
    vector: exportVectorStatus(vector),
    semantic,
    communities: communityModel.report,
    palette,
  };
  const health = dashboard.health;
  const statusRows = [
    ["Active", health.active_nodes],
    ["Superseded", health.superseded_nodes],
    ["Stale", health.stale_nodes],
    ["Ambiguous", health.ambiguous_nodes],
    ["Contradictions", health.unresolved_contradictions],
    ["Docs", health.total_docs],
  ]
    .map(([label, value]) => `<div><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(String(label))}</span></div>`)
    .join("");
  const contradictionRows =
    dashboard.contradictions.length === 0
      ? `<p class="muted">None detected.</p>`
      : dashboard.contradictions
          .map((item) => {
            const state = item.resolved ? `resolved via memory_nodes:${item.active_rid}` : "unresolved";
            const reason = item.reason ? `<em>${escapeHtml(item.reason)}</em>` : "";
            return `<li><b>${escapeHtml(item.from_title)}</b> contradicts <b>${escapeHtml(item.to_title)}</b><span>${escapeHtml(state)}</span>${reason}</li>`;
          })
          .join("");
  const supersessionRows =
    dashboard.supersession.length === 0
      ? `<p class="muted">None recorded.</p>`
      : dashboard.supersession
          .map((item) => {
            const reason = item.reason ? `<em>${escapeHtml(item.reason)}</em>` : "";
            return `<li><b>${escapeHtml(item.from_title)}</b> → <b>${escapeHtml(item.to_title)}</b>${reason}</li>`;
          })
          .join("");
  const staleRows =
    dashboard.evidence.stale.length === 0
      ? `<p class="muted">No stale evidence.</p>`
      : dashboard.evidence.stale
          .slice(0, 8)
          .map((item) => `<li><b>${escapeHtml(item.title)}</b><span>${item.age_days ?? 0}d idle</span></li>`)
          .join("");
  const docRows =
    docs.length === 0
      ? `<p class="muted">No documents exported.</p>`
      : docs
          .slice(0, 8)
          .map((doc) => `<li><b>${escapeHtml(doc.path)}</b><span>${escapeHtml(doc.title ?? "untitled")}</span></li>`)
          .join("");
  const vectorRows = [
    ["Overall", vector.overall],
    ["Ready", `${vector.ready}/${vector.total}`],
    ["Node vectors", String(vector.nodes.length)],
    ["Document vectors", String(vector.docs.length)],
  ]
    .map(([label, value]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
    .join("");
  const semanticRows = [
    ["Inferred nodes", String(semantic.inferred_nodes)],
    ["Inferred edges", String(semantic.inferred_edges)],
    [
      "Token cost",
      semantic.token_cost ? `${semantic.token_cost.input} in / ${semantic.token_cost.output} out` : "unavailable",
    ],
  ]
    .map(([label, value]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`)
    .join("");
  const communityRows =
    communityModel.report == null
      ? `<p class="muted">Community export disabled.</p>`
      : communityModel.report.communities
          .slice(0, 8)
          .map((community) => {
            const label = community.short_label ?? community.id;
            return `<li><b>${escapeHtml(label)}</b><span>${community.count} node(s), cohesion ${community.cohesion_score}</span></li>`;
          })
          .join("");

  // Self-contained: a tiny canvas force layout + a filterable sidebar. No CDN,
  // no build — opens straight from disk. The simulation is intentionally minimal
  // (the bundle must stay dependency-free) but enough to navigate the graph.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memory graph (${stats.nodes} nodes, ${stats.edges} edges, ${docs.length} docs)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #0f1115; color: #e6e6e6; }
  #app { display: flex; height: 100vh; }
  #side { width: 320px; flex: none; border-right: 1px solid #23262d; display: flex; flex-direction: column; }
  #side h1 { font-size: 14px; margin: 0; padding: 12px; border-bottom: 1px solid #23262d; }
  #q { margin: 8px; padding: 6px 8px; background: #1a1d23; border: 1px solid #2c2f36; color: inherit; border-radius: 6px; }
  .panel { border-bottom: 1px solid #23262d; padding: 10px 12px; }
  .panel h2 { font-size: 11px; line-height: 1.2; margin: 0 0 8px; color: #c9d1dc; text-transform: uppercase; letter-spacing: .08em; }
  .health-state { display: inline-block; padding: 2px 6px; border-radius: 999px; background: #28384d; color: #b9d8ff; font-size: 11px; margin-bottom: 8px; }
  .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
  .metrics div { background: #171a20; border: 1px solid #252a32; border-radius: 6px; padding: 6px; }
  .metrics strong { display: block; font-size: 15px; }
  .metrics span, .panel li span, .muted { color: #8b93a1; }
  .panel ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .panel li { display: grid; gap: 2px; }
  .panel em { color: #b6bfcc; font-style: normal; font-size: 11px; }
  .preview { max-height: 150px; overflow: auto; white-space: pre-wrap; margin: 0; padding: 8px; background: #171a20; border: 1px solid #252a32; border-radius: 6px; color: #cbd3df; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  #list { overflow: auto; flex: 1; }
  .item { padding: 8px 12px; border-bottom: 1px solid #1a1d23; cursor: pointer; }
  .item:hover, .item.active { background: #1a1d23; }
  .item .t { font-weight: 600; }
  .item .ty { color: #8b93a1; font-size: 11px; }
  .item .ex { color: #9aa3b2; font-size: 11px; margin-top: 2px; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .badge { border: 1px solid #303744; border-radius: 999px; color: #c8d0dc; font-size: 10px; padding: 1px 5px; }
  #stage { flex: 1; position: relative; }
  canvas { display: block; width: 100%; height: 100%; }
  #empty { padding: 24px; color: #8b93a1; }
</style>
</head>
<body>
<div id="app">
  <div id="side">
    <h1>Memory graph &middot; ${stats.nodes} nodes / ${stats.edges} edges / ${docs.length} docs</h1>
    <section class="panel">
      <h2>Memory health</h2>
      <div class="health-state">${escapeHtml(health.state)}</div>
      <div class="metrics">${statusRows}</div>
    </section>
    <section class="panel">
      <h2>Vector projection</h2>
      <div class="metrics">${vectorRows}</div>
    </section>
    <section class="panel">
      <h2>Semantic lane</h2>
      <div class="metrics">${semanticRows}</div>
    </section>
    <section class="panel">
      <h2>Community navigation</h2>
      <ul>${communityRows}</ul>
    </section>
    <section class="panel">
      <h2>Documents</h2>
      <ul>${docRows}</ul>
    </section>
    <section class="panel">
      <h2>Contradictions</h2>
      <ul>${contradictionRows}</ul>
    </section>
    <section class="panel">
      <h2>Supersession</h2>
      <ul>${supersessionRows}</ul>
    </section>
    <section class="panel">
      <h2>Stale evidence</h2>
      <ul>${staleRows}</ul>
    </section>
    <section class="panel" id="context-pack-preview">
      <h2>Context pack preview</h2>
      <pre class="preview">${escapeHtml(dashboard.contextPackPreview.context_md)}</pre>
    </section>
    <input id="q" placeholder="filter nodes…" autocomplete="off" />
    <div id="list"></div>
  </div>
  <div id="stage"><canvas id="c"></canvas><div id="empty" hidden>No nodes to display.</div></div>
</div>
<script id="data" type="application/json">${inlineJson(data)}</script>
<script>
const DATA = JSON.parse(document.getElementById("data").textContent);
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const listEl = document.getElementById("list");
const qEl = document.getElementById("q");
const emptyEl = document.getElementById("empty");

const nodes = DATA.nodes.map((n, i) => ({ ...n, x: 0, y: 0, vx: 0, vy: 0, i }));
const index = new Map(nodes.map((n) => [n.rid, n]));
const edges = DATA.edges.filter((e) => index.has(e.from) && index.has(e.to));
let selected = null;

emptyEl.hidden = nodes.length > 0;

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width; canvas.height = r.height;
}
window.addEventListener("resize", resize);
resize();

// Seed positions on a circle, then relax with a cheap spring + repulsion model.
const cx0 = () => canvas.width / 2, cy0 = () => canvas.height / 2;
nodes.forEach((n, i) => {
  const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
  const rad = Math.min(canvas.width, canvas.height) / 3;
  n.x = cx0() + Math.cos(a) * rad;
  n.y = cy0() + Math.sin(a) * rad;
});

function step() {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 0.01;
      const f = 1400 / d2;
      const d = Math.sqrt(d2);
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }
  }
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - 90) * 0.01;
    const ux = dx / d, uy = dy / d;
    a.vx += ux * f; a.vy += uy * f;
    b.vx -= ux * f; b.vy -= uy * f;
  }
  for (const n of nodes) {
    n.vx += (cx0() - n.x) * 0.002;
    n.vy += (cy0() - n.y) * 0.002;
    n.vx *= 0.85; n.vy *= 0.85;
    n.x += n.vx; n.y += n.vy;
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineWidth = 1;
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    ctx.strokeStyle = e.semantic_lane === "INFERRED" ? "#d8a441" : "#2c2f36";
    ctx.setLineDash(e.semantic_lane === "INFERRED" ? [4, 4] : []);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const n of nodes) {
    const on = selected === n.rid;
    ctx.beginPath(); ctx.arc(n.x, n.y, on ? 8 : 5, 0, Math.PI * 2);
    const clusterColor = (n.community && DATA.palette) ? DATA.palette[n.community] : null;
    ctx.fillStyle = on ? "#ffb454" : (n.semantic_lane === "INFERRED" ? "#d8795f" : (clusterColor || "#5b9dd9")); ctx.fill();
    if (on) {
      ctx.fillStyle = "#e6e6e6"; ctx.font = "12px system-ui";
      ctx.fillText(n.title, n.x + 10, n.y + 4);
    }
  }
}

let frames = 0;
function loop() {
  if (frames++ < 400) step();
  draw();
  requestAnimationFrame(loop);
}
loop();

function renderList(filter) {
  const f = (filter || "").toLowerCase();
  listEl.innerHTML = "";
  for (const n of nodes) {
    if (f && !(n.title + " " + n.label + " " + n.type + " " + (n.community_label || "")).toLowerCase().includes(f)) continue;
    const div = document.createElement("div");
    div.className = "item" + (selected === n.rid ? " active" : "");
    div.innerHTML =
      '<div class="t"></div><div class="ty"></div><div class="ex"></div><div class="badges"></div>';
    div.querySelector(".t").textContent = n.title;
    div.querySelector(".ty").textContent = [n.type, n.community_label].filter(Boolean).join(" · ");
    div.querySelector(".ex").textContent = n.excerpt;
    const badges = div.querySelector(".badges");
    for (const status of n.statuses || ["active"]) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = status;
      badges.appendChild(badge);
    }
    for (const label of [n.semantic_lane, n.confidence_band ? "confidence " + n.confidence_band : null, n.navigation?.hub ? "Hub" : null, n.navigation?.bridge ? "Bridge" : null]) {
      if (!label) continue;
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = label;
      badges.appendChild(badge);
    }
    div.onclick = () => { selected = n.rid; frames = 0; renderList(qEl.value); };
    listEl.appendChild(div);
  }
}
qEl.addEventListener("input", () => renderList(qEl.value));
canvas.addEventListener("click", (ev) => {
  const r = canvas.getBoundingClientRect();
  const mx = ev.clientX - r.left, my = ev.clientY - r.top;
  let best = null, bd = 1e9;
  for (const n of nodes) {
    const d = (n.x - mx) ** 2 + (n.y - my) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  if (best && bd < 400) { selected = best.rid; renderList(qEl.value); }
});
renderList("");
</script>
</body>
</html>
`;
}
