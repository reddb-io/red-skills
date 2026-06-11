import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";
import type {
  OnboardingEvidenceItem,
  OnboardingMap,
  OnboardingSection,
  OnboardingSkillSuggestion,
  OnboardingWarning,
} from "./onboarding-map.js";

export interface OnboardingMapViewerArtifact {
  contract: {
    name: "memory.onboarding_map.viewer";
    version: "memory.onboarding_map.viewer.v1";
    consumes: "memory.onboarding_map.v1";
  };
  map: OnboardingMap;
  html: string;
}

const SECTION_ORDER: OnboardingSection[] = [
  "concepts",
  "workflows",
  "decisions",
  "risks",
  "validations",
  "suggestedSkills",
];

const SECTION_TITLES: Record<OnboardingSection, string> = {
  concepts: "Concepts",
  workflows: "Workflows",
  decisions: "Decisions",
  risks: "Risks",
  validations: "Validations",
  suggestedSkills: "Suggested Skills",
};

export function buildOnboardingMapViewerArtifact(
  map: OnboardingMap,
): OnboardingMapViewerArtifact {
  return {
    contract: {
      name: "memory.onboarding_map.viewer",
      version: "memory.onboarding_map.viewer.v1",
      consumes: map.schema_version,
    },
    map,
    html: renderOnboardingMapViewer(map),
  };
}

function renderOnboardingMapViewer(map: OnboardingMap): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory onboarding map viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f7f2;
      --ink: #202421;
      --muted: #657067;
      --line: #d8ddd4;
      --panel: #ffffff;
      --accent: #0b6f5d;
      --warn: #8a5a12;
      --bad: #a43a3a;
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
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
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
    .layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, .8fr); gap: 14px; }
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
        <h1>Onboarding Map</h1>
        <p class="meta">Map-first orientation generated from RedDB Memory graph evidence.</p>
      </div>
      <div class="badge ${map.status === "ready" ? "" : map.status === "empty" ? "warn" : "bad"}">${escapeHtml(map.status)}</div>
    </header>
    <div class="metrics">
      ${metric("Concepts", map.summary.concepts)}
      ${metric("Workflows", map.summary.workflows)}
      ${metric("Decisions", map.summary.decisions)}
      ${metric("Risks", map.summary.risks)}
      ${metric("Validations", map.summary.validations)}
      ${metric("Warnings", map.summary.warnings)}
    </div>
    <div class="layout">
      <div class="stack">
        ${SECTION_ORDER.map((section) => sectionBlock(section, map)).join("")}
      </div>
      <div class="stack">
        <section>
          <h2>Warnings</h2>
          ${map.warnings.length === 0 ? `<p class="empty">No onboarding warnings.</p>` : `<ul>${map.warnings.map(warningItem).join("")}</ul>`}
        </section>
        <section>
          <h2>Markdown</h2>
          <p class="meta">The markdown block is embedded in the JSON contract for agent injection.</p>
          <p class="meta"><code>${map.markdown.length} byte(s)</code></p>
        </section>
      </div>
    </div>
    <script id="onboarding-map-data" type="application/json">${jsonForScript(map)}</script>
  </main>
</body>
</html>`;
}

function sectionBlock(section: OnboardingSection, map: OnboardingMap): string {
  const entries = map.sections[section];
  return `<section>
    <h2>${escapeHtml(SECTION_TITLES[section])}</h2>
    ${entries.length === 0 ? `<p class="empty">No ${escapeHtml(SECTION_TITLES[section].toLowerCase())} evidence.</p>` : `<ul>${entries.map((entry) => section === "suggestedSkills" ? skillItem(entry as OnboardingSkillSuggestion) : evidenceItem(entry as OnboardingEvidenceItem)).join("")}</ul>`}
  </section>`;
}

function evidenceItem(item: OnboardingEvidenceItem): string {
  const stateClass = item.statuses.includes("contradictory")
    ? "bad"
    : item.statuses.includes("stale") || item.statuses.includes("superseded")
      ? "warn"
      : "";
  return `<li>
    <div>
      <h3>${escapeHtml(item.title)}</h3>
      <p class="meta"><code>${escapeHtml(item.urn)}</code> - ${escapeHtml(item.nodeType)} - ${escapeHtml(item.confidence)}</p>
      <p class="meta">${escapeHtml(item.excerpt || "No excerpt.")}</p>
    </div>
    <span class="pill ${stateClass}">${escapeHtml(item.statuses.join(", "))}</span>
  </li>`;
}

function skillItem(item: OnboardingSkillSuggestion): string {
  return `<li>
    <div>
      <h3>${escapeHtml(item.name)}</h3>
      <p class="meta"><code>${escapeHtml(item.path)}</code></p>
      <p class="meta">${escapeHtml(item.reason)}</p>
    </div>
    <span class="pill">${item.succeeded}/${item.resultCount} succeeded</span>
  </li>`;
}

function warningItem(warning: OnboardingWarning): string {
  return `<li>
    <div>
      <h3>${escapeHtml(warning.kind)}</h3>
      <p class="meta">${escapeHtml(warning.message)}</p>
    </div>
    <span class="pill bad">${warning.rids.length} rid(s)</span>
  </li>`;
}
