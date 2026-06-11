import type { ContextPack, ContextPackEntry, ContextPackWarning } from "./context-pack.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface ContextPackViewerArtifact {
  contract: {
    name: "memory.context_pack.viewer";
    version: "memory.context_pack.viewer.v1";
    consumes: "memory.context_pack.v1";
  };
  pack: ContextPack;
  html: string;
}

export function buildContextPackViewerArtifact(pack: ContextPack): ContextPackViewerArtifact {
  return {
    contract: {
      name: "memory.context_pack.viewer",
      version: "memory.context_pack.viewer.v1",
      consumes: "memory.context_pack.v1",
    },
    pack,
    html: renderContextPackViewer(pack),
  };
}

function renderContextPackViewer(pack: ContextPack): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory context pack viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f6f1;
      --ink: #202421;
      --muted: #667067;
      --line: #d7ddd3;
      --panel: #ffffff;
      --code: #f9faf5;
      --accent: #0b6f5d;
      --warn: #8a5a12;
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
    .empty-state, .warn { color: var(--warn); }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, .75fr); gap: 14px; }
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
    pre {
      margin: 0;
      max-height: 640px;
      overflow: auto;
      white-space: pre-wrap;
      background: var(--code);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
    }
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
        <h1>Memory Context Pack</h1>
        <p class="meta">Goal: ${escapeHtml(pack.goal)}</p>
        <p class="meta"><code>memory.context_pack.v1</code> - ${pack.usedChars}/${pack.budgetChars} character budget used</p>
      </div>
      <div class="badge ${pack.status === "insufficient-context" ? "empty-state" : ""}">${escapeHtml(pack.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Entries", pack.entries.length)}
      ${metric("Warnings", pack.warnings.length)}
      ${metric("Omitted", pack.omittedEntries)}
      ${metric("Skills", pack.skillRecommendations.recommendations.length)}
      ${metric("Used", pack.usedChars)}
      ${metric("Budget", pack.budgetChars)}
    </div>
    <div class="layout">
      <div class="stack">
        ${pack.entries.length === 0 ? `<section><p class="empty">No active Memory evidence matched this context-pack goal.</p></section>` : groupedEntries(pack)}
      </div>
      <div class="stack">
        <section>
          <h2>Agent Markdown</h2>
          <pre>${escapeHtml(pack.markdown)}</pre>
        </section>
        <section>
          <h2>Warnings</h2>
          ${pack.warnings.length === 0 ? `<p class="empty">No supersession, contradiction, or budget warnings.</p>` : `<ul>${pack.warnings.map(warningHtml).join("")}</ul>`}
        </section>
        <section>
          <h2>Skill Recommendations</h2>
          ${pack.skillRecommendations.recommendations.length === 0 ? `<p class="empty">No skill recommendations from this evidence.</p>` : `<ul>${pack.skillRecommendations.recommendations.map((rec) => `<li><div><h3>${escapeHtml(rec.name)}</h3><p class="meta">${escapeHtml(rec.reasons.join("; "))}</p></div><span class="pill">${escapeHtml(rec.evidenceStrength)}</span></li>`).join("")}</ul>`}
        </section>
      </div>
    </div>
    <script id="memory-context-pack-data" type="application/json">${jsonForScript(pack)}</script>
  </main>
</body>
</html>`;
}

function groupedEntries(pack: ContextPack): string {
  const coreContext = pack.coreContext ?? [];
  const coreRids = new Set(coreContext.map((entry) => entry.citation.rid));
  const entries = pack.entries.filter((entry) => !coreRids.has(entry.citation.rid));
  const order: ContextPackEntry["section"][] = [
    "hard_constraints",
    "prior_decisions",
    "known_pitfalls",
    "similar_past_work",
    "do_not_do",
  ];
  const coreHtml =
    coreContext.length === 0
      ? ""
      : `<section>
        <h2>Core Context</h2>
        <ul>${coreContext.map(entryHtml).join("")}</ul>
      </section>`;
  return `${coreHtml}${order
    .map((section) => {
      const sectionEntries = entries.filter((entry) => entry.section === section);
      if (sectionEntries.length === 0) return "";
      return `<section>
        <h2>${escapeHtml(sectionTitle(section))}</h2>
        <ul>${sectionEntries.map(entryHtml).join("")}</ul>
      </section>`;
    })
    .join("")}`;
}

function entryHtml(entry: ContextPackEntry): string {
  const source = entry.citation.source ? ` - ${escapeHtml(entry.citation.source)}` : "";
  const confidence =
    entry.confidence_score == null ? "" : ` - confidence ${entry.confidence_score.toFixed(2)}`;
  const provenance = entry.provenance
    ? ` - provenance ${escapeHtml(entry.provenance.source_kind)}${entry.provenance.writer ? `/${escapeHtml(entry.provenance.writer)}` : ""}`
    : "";
  return `<li>
    <div>
      <h3>${escapeHtml(entry.citation.marker)} ${escapeHtml(entry.title)}</h3>
      <p>${escapeHtml(entry.excerpt)}</p>
      <p class="meta"><code>${escapeHtml(entry.citation.urn)}</code>${source} - score ${entry.score.toFixed(4)} - trust ${entry.trust.toFixed(2)} - importance ${entry.importance.toFixed(2)}${confidence}${provenance}</p>
      <p class="meta">${escapeHtml(entry.reason)}</p>
    </div>
    <span class="pill">${escapeHtml(entry.nodeType)}</span>
  </li>`;
}

function warningHtml(warning: ContextPackWarning): string {
  return `<li><div><h3>${escapeHtml(warning.kind)}</h3><p class="meta">${escapeHtml(warning.message)}</p></div><span class="pill warn">${escapeHtml(warning.rids.join(","))}</span></li>`;
}

function sectionTitle(section: ContextPackEntry["section"]): string {
  const titles: Record<ContextPackEntry["section"], string> = {
    hard_constraints: "Hard Constraints",
    prior_decisions: "Prior Decisions",
    known_pitfalls: "Known Pitfalls",
    similar_past_work: "Similar Past Work",
    do_not_do: "Do-Not-Do Guidance",
  };
  return titles[section];
}
