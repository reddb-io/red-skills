import { escapeHtmlNoSingleQuote as escapeHtml, jsonForScriptEscapedLessThan as jsonForScript, metricWithMetaSpan as metric } from "./viewer-utils.js";
import type {
  MemoryAgentIntegration,
  MemoryConfigSnippet,
  MemoryRoutingGuide,
  MemoryRoutingRule,
} from "./routing-guide.js";

export interface MemoryRoutingGuideViewerArtifact {
  name: "memory.routing_guide.viewer";
  contract: {
    version: "memory.routing_guide.viewer.v1";
    consumes: "memory.routing_guide.v1";
  };
  guide: MemoryRoutingGuide;
  html: string;
}

export function buildMemoryRoutingGuideViewerArtifact(
  guide: MemoryRoutingGuide,
): MemoryRoutingGuideViewerArtifact {
  return {
    name: "memory.routing_guide.viewer",
    contract: {
      version: "memory.routing_guide.viewer.v1",
      consumes: guide.schemaVersion,
    },
    guide,
    html: render(guide),
  };
}

function render(guide: MemoryRoutingGuide): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory Routing Guide</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f7f8; color: #1d232a; }
    body { margin: 0; }
    main { max-width: 1180px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 18px; align-items: flex-start; border-bottom: 1px solid #d8dee4; padding-bottom: 18px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; margin-bottom: 10px; }
    h3 { font-size: 15px; margin-bottom: 4px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    pre { white-space: pre-wrap; overflow: auto; background: #fff; border: 1px solid #d8dee4; border-radius: 8px; padding: 14px; }
    section { margin-top: 20px; }
    .meta { color: #667085; font-size: 13px; }
    .pill { border: 1px solid #b8c0cc; border-radius: 999px; padding: 4px 9px; font-size: 12px; background: #fff; white-space: nowrap; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 20px 0; }
    .metric, li, .snippet { background: #fff; border: 1px solid #d8dee4; border-radius: 8px; padding: 12px; }
    .metric strong { display: block; font-size: 23px; }
    ul { display: grid; gap: 10px; list-style: none; padding: 0; margin: 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .snippet { display: grid; gap: 8px; }
    @media (prefers-color-scheme: dark) {
      :root { background: #111418; color: #e6edf3; }
      header { border-color: #30363d; }
      .metric, li, .snippet, pre, .pill { background: #161b22; border-color: #30363d; }
      .meta { color: #9ba7b4; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Routing Guide</h1>
        <p class="meta"><code>${escapeHtml(guide.schemaVersion)}</code> - ${escapeHtml(guide.integration.displayName)}</p>
      </div>
      <span class="pill">${escapeHtml(guide.agent)}</span>
    </header>
    <section class="metrics">
      ${metric("Transports", guide.integration.transports.length)}
      ${metric("MCP Tools", guide.mcpTools.length)}
      ${metric("Rules", guide.rules.length)}
      ${metric("Target Files", guide.targetFiles.length)}
    </section>
    ${integrationSection(guide.integration)}
    ${mapContextSection(guide)}
    ${rulesSection(guide.rules)}
    ${listSection("MCP Tools", guide.mcpTools)}
    ${listSection("CLI Fallbacks", guide.cliFallbacks)}
    ${snippetSection(guide.integration.configSnippets)}
    <section>
      <h2>Install Snippet</h2>
      <pre>${escapeHtml(guide.installSnippet)}</pre>
    </section>
    <script id="memory-routing-guide-data" type="application/json">${jsonForScript(guide)}</script>
  </main>
</body>
</html>`;
}


function mapContextSection(guide: MemoryRoutingGuide): string {
  return `<section>
    <h2>Map Context</h2>
    <ul>
      <li><strong>${escapeHtml(guide.mapContext.kind)}</strong><p class="meta">${escapeHtml(guide.mapContext.description)}</p></li>
      <li><strong>Relation filters</strong><p class="meta">${escapeHtml(guide.mapContext.relationFilters.join(", "))}</p></li>
      ${guide.mapContext.examples
        .map(
          (example) => `<li>
        <strong>${escapeHtml(example.question)}</strong>
        <p><code>${escapeHtml(example.call)}</code></p>
        <p class="meta">Filters: ${escapeHtml(example.relationFilters.join(", "))}</p>
        <p class="meta">${escapeHtml(example.followUp)}</p>
      </li>`,
        )
        .join("")}
    </ul>
  </section>`;
}

function integrationSection(integration: MemoryAgentIntegration): string {
  return `<section>
    <h2>Integration</h2>
    <ul>
      <li><strong>${escapeHtml(integration.displayName)}</strong><p class="meta">Transports: ${escapeHtml(integration.transports.join(", "))}</p></li>
      <li><strong>Target files</strong><p class="meta">${escapeHtml(integration.targetFiles.join(", "))}</p></li>
      <li><strong>Connect commands</strong><p class="meta">${escapeHtml(integration.connectCommands.join(" · "))}</p></li>
      ${integration.notes.map((note) => `<li><strong>Note</strong><p class="meta">${escapeHtml(note)}</p></li>`).join("")}
    </ul>
  </section>`;
}

function rulesSection(rules: MemoryRoutingRule[]): string {
  return `<section>
    <h2>Routing Rules</h2>
    <ul>
      ${rules
        .map(
          (rule) => `<li>
        <strong>${escapeHtml(rule.when)}</strong>
        <p><code>${escapeHtml(rule.call)}</code></p>
        <p class="meta">${escapeHtml(rule.reason)}</p>
      </li>`,
        )
        .join("")}
    </ul>
  </section>`;
}

function listSection(title: string, items: string[]): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    <ul>${items.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join("")}</ul>
  </section>`;
}

function snippetSection(snippets: MemoryConfigSnippet[]): string {
  return `<section>
    <h2>Config Snippets</h2>
    <div class="grid">
      ${snippets
        .map(
          (snippet) => `<div class="snippet">
        <h3>${escapeHtml(snippet.label)}</h3>
        <p class="meta">${escapeHtml(snippet.path)}</p>
        <pre>${escapeHtml(snippet.body)}</pre>
      </div>`,
        )
        .join("")}
    </div>
  </section>`;
}
