import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MemoryStore, StoredNode } from "./graph-store.js";

/**
 * memory export — dump the whole graph to a self-contained, navigable bundle.
 *
 * Emits three files into `outDir`:
 *   - graph.json  — the raw nodes + edges + stats (machine-readable, stable).
 *   - graph.html  — a single self-contained page (data inlined, no network,
 *                   no build step) with a force-directed node-link view plus a
 *                   searchable list; opens straight from disk.
 *   - audit.md    — a human-readable health summary: counts by type/edge label,
 *                   superseded chains, orphans, and the busiest nodes.
 *
 * Pure read: it never mutates the store.
 */

export interface ExportEdge {
  rid: number;
  label: string;
  from: number;
  to: number;
  weight: number;
}

export interface ExportResult {
  dir: string;
  jsonPath: string;
  htmlPath: string;
  auditPath: string;
  nodes: number;
  edges: number;
}

/** Normalize a raw edge row (uppercased/promoted columns vary) into a tidy edge. */
function toEdge(row: Record<string, unknown>): ExportEdge {
  return {
    rid: Number(row.rid ?? row.red_entity_id ?? 0),
    label: String(row.label ?? row.LABEL ?? ""),
    from: Number(row.from ?? row.from_id ?? row.source ?? row.FROM ?? 0),
    to: Number(row.to ?? row.to_id ?? row.target ?? row.TO ?? 0),
    weight: Number(row.weight ?? row.WEIGHT ?? 1),
  };
}

export async function exportGraph(store: MemoryStore, outDir: string): Promise<ExportResult> {
  const dir = resolve(outDir);
  await mkdir(dir, { recursive: true });

  const [nodes, rawEdges, stats] = await Promise.all([
    store.listNodes(),
    store.listEdges(),
    store.stats(),
  ]);
  const edges = rawEdges.map(toEdge);

  const json = {
    generated_at: new Date().toISOString(),
    stats,
    nodes: nodes.map((n) => ({
      rid: n.rid,
      label: n.label,
      node_type: n.node_type,
      properties: n.properties,
    })),
    edges,
  };

  const jsonPath = join(dir, "graph.json");
  const htmlPath = join(dir, "graph.html");
  const auditPath = join(dir, "audit.md");

  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, "utf8"),
    writeFile(htmlPath, renderHtml(nodes, edges, stats), "utf8"),
    writeFile(auditPath, renderAudit(nodes, edges, stats), "utf8"),
  ]);

  return {
    dir,
    jsonPath,
    htmlPath,
    auditPath,
    nodes: nodes.length,
    edges: edges.length,
  };
}

// ---------------------------------------------------------------------------
// audit.md
// ---------------------------------------------------------------------------

function tally<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function renderAudit(
  nodes: StoredNode[],
  edges: ExportEdge[],
  stats: { nodes: number; edges: number },
): string {
  const byType = tally(nodes, (n) => n.node_type);
  const byLabel = tally(edges, (e) => e.label);

  // Degree per node (in + out) and orphan detection.
  const degree = new Map<number, number>();
  for (const n of nodes) degree.set(n.rid, 0);
  for (const e of edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const byRid = new Map(nodes.map((n) => [n.rid, n]));
  const orphans = nodes.filter((n) => (degree.get(n.rid) ?? 0) === 0);
  const superseded = edges.filter((e) => e.label === "SUPERSEDED_BY");
  const topDegree = [...degree.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 10);

  const lines: string[] = [];
  lines.push("# Memory graph audit", "");
  lines.push(`Generated: ${new Date().toISOString()}`, "");
  lines.push(`- **Nodes:** ${stats.nodes}`);
  lines.push(`- **Edges:** ${stats.edges}`);
  lines.push(`- **Orphan nodes (no edges):** ${orphans.length}`);
  lines.push(`- **Superseded chains:** ${superseded.length}`, "");

  lines.push("## Nodes by type", "");
  for (const [type, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${type}\` — ${n}`);
  }
  lines.push("");

  lines.push("## Edges by label", "");
  if (byLabel.size === 0) {
    lines.push("_(none)_");
  } else {
    for (const [label, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${label}\` — ${n}`);
    }
  }
  lines.push("");

  lines.push("## Most connected nodes", "");
  if (topDegree.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const [rid, d] of topDegree) {
      const node = byRid.get(rid);
      const title = node?.properties.title ?? node?.label ?? String(rid);
      lines.push(`- **${title}** _(${node?.node_type ?? "?"})_ — ${d} edge(s)`);
    }
  }
  lines.push("");

  if (orphans.length > 0) {
    lines.push("## Orphan nodes", "");
    for (const n of orphans.slice(0, 50)) {
      lines.push(`- **${n.properties.title ?? n.label}** _(${n.node_type})_`);
    }
    if (orphans.length > 50) lines.push(`- … and ${orphans.length - 50} more`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
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

function renderHtml(
  nodes: StoredNode[],
  edges: ExportEdge[],
  stats: { nodes: number; edges: number },
): string {
  const data = {
    nodes: nodes.map((n) => ({
      rid: n.rid,
      label: n.label,
      type: n.node_type,
      title: n.properties.title ?? n.label,
      excerpt: String(n.properties.summary ?? n.properties.content ?? "").slice(0, 280),
    })),
    edges: edges.map((e) => ({ from: e.from, to: e.to, label: e.label })),
  };

  // Self-contained: a tiny canvas force layout + a filterable sidebar. No CDN,
  // no build — opens straight from disk. The simulation is intentionally minimal
  // (the bundle must stay dependency-free) but enough to navigate the graph.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Memory graph (${stats.nodes} nodes, ${stats.edges} edges)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.4 system-ui, sans-serif; background: #0f1115; color: #e6e6e6; }
  #app { display: flex; height: 100vh; }
  #side { width: 320px; flex: none; border-right: 1px solid #23262d; display: flex; flex-direction: column; }
  #side h1 { font-size: 14px; margin: 0; padding: 12px; border-bottom: 1px solid #23262d; }
  #q { margin: 8px; padding: 6px 8px; background: #1a1d23; border: 1px solid #2c2f36; color: inherit; border-radius: 6px; }
  #list { overflow: auto; flex: 1; }
  .item { padding: 8px 12px; border-bottom: 1px solid #1a1d23; cursor: pointer; }
  .item:hover, .item.active { background: #1a1d23; }
  .item .t { font-weight: 600; }
  .item .ty { color: #8b93a1; font-size: 11px; }
  .item .ex { color: #9aa3b2; font-size: 11px; margin-top: 2px; }
  #stage { flex: 1; position: relative; }
  canvas { display: block; width: 100%; height: 100%; }
  #empty { padding: 24px; color: #8b93a1; }
</style>
</head>
<body>
<div id="app">
  <div id="side">
    <h1>Memory graph &middot; ${stats.nodes} nodes / ${stats.edges} edges</h1>
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
  ctx.strokeStyle = "#2c2f36"; ctx.lineWidth = 1;
  for (const e of edges) {
    const a = index.get(e.from), b = index.get(e.to);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (const n of nodes) {
    const on = selected === n.rid;
    ctx.beginPath(); ctx.arc(n.x, n.y, on ? 8 : 5, 0, Math.PI * 2);
    ctx.fillStyle = on ? "#ffb454" : "#5b9dd9"; ctx.fill();
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
    if (f && !(n.title + " " + n.label + " " + n.type).toLowerCase().includes(f)) continue;
    const div = document.createElement("div");
    div.className = "item" + (selected === n.rid ? " active" : "");
    div.innerHTML =
      '<div class="t"></div><div class="ty"></div><div class="ex"></div>';
    div.querySelector(".t").textContent = n.title;
    div.querySelector(".ty").textContent = n.type;
    div.querySelector(".ex").textContent = n.excerpt;
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
