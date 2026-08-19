import { escapeHtmlNoSingleQuote as escapeHtml, jsonForScriptEscapedLessThan as jsonForScript, metricWithMetaSpan as metric } from "./viewer-utils.js";
import type {
  MemoryAgentIntegrationItem,
  MemoryAgentIntegrationStatus,
} from "./agent-integration-status.js";

export interface MemoryAgentIntegrationStatusViewerArtifact {
  name: "memory.agent_integration_status.viewer";
  contract: {
    version: "memory.agent_integration_status.viewer.v1";
    consumes: "memory.agent_integration_status.v1";
  };
  report: MemoryAgentIntegrationStatus;
  html: string;
}

export function buildMemoryAgentIntegrationStatusViewerArtifact(
  report: MemoryAgentIntegrationStatus,
): MemoryAgentIntegrationStatusViewerArtifact {
  return {
    name: "memory.agent_integration_status.viewer",
    contract: {
      version: "memory.agent_integration_status.viewer.v1",
      consumes: report.schema_version,
    },
    report,
    html: render(report),
  };
}

function render(report: MemoryAgentIntegrationStatus): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory Agent Integration Status</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f7f8; color: #1d232a; }
    body { margin: 0; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; border-bottom: 1px solid #d8dee4; padding-bottom: 18px; }
    h1, h2, h3, p { margin: 0; }
    h1 { font-size: 28px; }
    h2 { font-size: 18px; margin: 24px 0 10px; }
    h3 { font-size: 15px; margin-bottom: 4px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .meta { color: #667085; font-size: 13px; }
    .pill { border: 1px solid #b8c0cc; border-radius: 999px; padding: 4px 9px; font-size: 12px; background: #fff; white-space: nowrap; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 20px 0; }
    .metric, li { background: #fff; border: 1px solid #d8dee4; border-radius: 8px; padding: 12px; }
    .metric strong { display: block; font-size: 23px; }
    ul { display: grid; gap: 10px; list-style: none; padding: 0; margin: 0; }
    .ready { border-left: 4px solid #027a48; }
    .partial { border-left: 4px solid #b54708; }
    .missing { border-left: 4px solid #b42318; }
    @media (prefers-color-scheme: dark) {
      :root { background: #111418; color: #e6edf3; }
      header { border-color: #30363d; }
      .metric, li, .pill { background: #161b22; border-color: #30363d; }
      .meta { color: #9ba7b4; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Memory Agent Integration Status</h1>
        <p class="meta"><code>${escapeHtml(report.schema_version)}</code> - ${escapeHtml(report.generated_at)}</p>
      </div>
      <span class="pill">${escapeHtml(report.mode)}</span>
    </header>
    <section class="metrics">
      ${metric("Agents", report.summary.agents)}
      ${metric("Ready", report.summary.ready)}
      ${metric("Partial", report.summary.partial)}
      ${metric("Missing", report.summary.missing)}
    </section>
    <section>
      <h2>Agents</h2>
      <ul>${report.agents.map(agentItem).join("")}</ul>
    </section>
    <section>
      <h2>Next Actions</h2>
      <ul>${report.recommended_next_actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>
    </section>
    <script id="memory-agent-integration-status-data" type="application/json">${jsonForScript(report)}</script>
  </main>
</body>
</html>`;
}


function agentItem(agent: MemoryAgentIntegrationItem): string {
  const files = agent.target_files
    .map((file) => `${file.path}: ${file.contains_memory_routing ? "routed" : file.exists ? "present" : "missing"}`)
    .join("; ");
  const hooks = agent.hook_coverage
    ? `hooks ${agent.hook_coverage.effective_events}/${agent.hook_coverage.total_events} effective`
    : "hooks not applicable";
  return `<li class="${agent.state}">
    <h3>${escapeHtml(agent.display_name)} <span class="pill">${escapeHtml(agent.state)}</span></h3>
    <p class="meta">${escapeHtml(agent.transports.join(", "))}</p>
    <p><code>${escapeHtml(files)}</code></p>
    <p class="meta">${escapeHtml(hooks)} - ${agent.mcp_tools} MCP tool(s), ${agent.cli_fallbacks} CLI fallback(s)</p>
  </li>`;
}
