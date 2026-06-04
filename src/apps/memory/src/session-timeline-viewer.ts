import type { SessionTimeline, SessionTimelineEntry } from "./session-timeline.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface SessionTimelineViewerArtifact {
  contract: {
    name: "memory.session_timeline.viewer";
    version: "memory.session_timeline.viewer.v1";
    consumes: "memory.session_timeline.v1";
  };
  timeline: SessionTimeline;
  html: string;
}

export function buildSessionTimelineViewerArtifact(
  timeline: SessionTimeline,
): SessionTimelineViewerArtifact {
  return {
    contract: {
      name: "memory.session_timeline.viewer",
      version: "memory.session_timeline.viewer.v1",
      consumes: timeline.schema_version,
    },
    timeline,
    html: renderSessionTimelineViewer(timeline),
  };
}

function renderSessionTimelineViewer(timeline: SessionTimeline): string {
  const scope = timeline.filter.session_id ?? "all sessions";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory session timeline viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f6f2;
      --ink: #202421;
      --muted: #657066;
      --line: #d6dbd2;
      --panel: #ffffff;
      --accent: #0c6f68;
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
    h1 { font-size: 28px; letter-spacing: 0; }
    h2 { font-size: 16px; margin-bottom: 10px; }
    h3 { font-size: 13px; margin-bottom: 4px; overflow-wrap: anywhere; }
    .meta, .empty { color: var(--muted); font-size: 13px; }
    .badge {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
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
    .layout { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    .event {
      display: grid;
      grid-template-columns: 160px minmax(0, 1fr) auto;
      gap: 12px;
      align-items: start;
    }
    .pill {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      white-space: nowrap;
    }
    .succeeded { color: var(--accent); }
    .failed { color: var(--bad); }
    .noop, .unknown { color: var(--warn); }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    @media (max-width: 900px) {
      header, .metrics, .layout, .event { grid-template-columns: 1fr; }
      .badge, .pill { white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Session Timeline</h1>
        <p class="meta">${escapeHtml(scope)} - ${escapeHtml(timeline.generated_at)}</p>
        <p class="meta">Replay evidence from ${escapeHtml(timeline.schema_version)} without raw transcripts.</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Events", timeline.summary.events)}
      ${metric("Sessions", timeline.summary.sessions)}
      ${metric("Hook events", timeline.summary.hook_events)}
      ${metric("Failures", timeline.summary.failures)}
    </div>
    <div class="layout">
      <div class="stack">
        ${entriesSection(timeline.entries)}
      </div>
      <div class="stack">
        ${sessionsSection(timeline)}
        ${actionsSection(timeline.recommended_next_actions)}
      </div>
    </div>
    <script id="session-timeline-data" type="application/json">${jsonForScript(timeline)}</script>
  </main>
</body>
</html>`;
}


function entriesSection(entries: SessionTimelineEntry[]): string {
  return `<section>
    <h2>Events</h2>
    ${
      entries.length === 0
        ? `<p class="empty">No session events available.</p>`
        : `<ul>${entries.map(entryItem).join("")}</ul>`
    }
  </section>`;
}

function entryItem(entry: SessionTimelineEntry): string {
  return `<li class="event">
    <p class="meta">${escapeHtml(entry.occurred_at)}</p>
    <div>
      <h3>${escapeHtml(entry.title)}</h3>
      <p>${escapeHtml(entry.detail || "No detail.")}</p>
      <p class="meta"><code>${escapeHtml(entry.session_id)}</code> - ${escapeHtml(entry.actor)} - ${escapeHtml(entry.source)}</p>
    </div>
    <span class="pill ${escapeHtml(entry.outcome)}">${escapeHtml(entry.outcome)}</span>
  </li>`;
}

function sessionsSection(timeline: SessionTimeline): string {
  return `<section>
    <h2>Sessions</h2>
    ${
      timeline.sessions.length === 0
        ? `<p class="empty">No sessions in this window.</p>`
        : `<ul>${timeline.sessions.map((session) => `<li><h3>${escapeHtml(session.session_id)}</h3><p class="meta">${session.events} event(s), ${escapeHtml(session.first_event_at)} to ${escapeHtml(session.last_event_at)}</p></li>`).join("")}</ul>`
    }
  </section>`;
}

function actionsSection(actions: string[]): string {
  return `<section>
    <h2>Next Actions</h2>
    ${
      actions.length === 0
        ? `<p class="empty">No next actions.</p>`
        : `<ul>${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>`
    }
  </section>`;
}
