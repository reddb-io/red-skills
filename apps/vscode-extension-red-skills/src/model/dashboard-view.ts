/**
 * dashboard-view — what the status bar says and what the panel shows. PURE.
 *
 * **Every fact here was computed by the daemon.** The header line, the Worker
 * rows, the pipeline bars and the counts arrive finished from
 * `statusline-dashboard`; this module decides only where the text goes and how it
 * is escaped for a webview. That is the rule the statusline pair was built on
 * (ADR 0130 rule 10): an editor panel and a herdr pane each doing their own
 * Worker math would be two dashboards lying in two different ways about the same
 * instant.
 *
 * Editor-free on purpose, so the whole of what a reader SEES is asserted by a
 * test that never opens a window. `views/status-bar.ts` and
 * `views/dashboard-panel.ts` hold the `vscode` imports and nothing else.
 */
import { canonicalInvocation } from "@reddb-io/shared/canonical-invocation.js";
import { stripAnsi } from "@reddb-io/redskilled-render/format.js";
import type { RedskilledDashboard } from "@reddb-io/redskilled/protocol";
import type { HostSnapshot } from "./snapshot.js";

/** What one status-bar item says, in the three parts the editor asks for. */
export interface StatusBarView {
  readonly text: string;
  readonly tooltip: string;
  /** True when the item should be drawn in the editor's warning colour. */
  readonly warning: boolean;
}

/** The text an unreachable host puts in the status bar — an outage, not an idle machine. */
export const STATUS_BAR_ABSENCE = "$(circle-slash) redskilled unreachable";

/**
 * The status bar's one line: the daemon's header, and nothing added to it. PURE.
 *
 * The header is used verbatim because it is already the summary — the dashboard
 * renderer builds it to stand alone, for exactly this place. A status bar that
 * assembled its own from the payload would be the second renderer whose drift
 * from the first nobody notices for weeks.
 */
export function statusBarView(snapshot: HostSnapshot): StatusBarView {
  if (!snapshot.reachable) {
    return {
      text: STATUS_BAR_ABSENCE,
      tooltip: `redskilled did not answer at ${snapshot.socketPath} (${snapshot.source}): ${
        snapshot.error?.message ?? "no reason given"
      }`,
      warning: true,
    };
  }
  if (snapshot.dashboard === null) {
    return {
      text: "$(server) redskilled",
      tooltip:
        "This daemon does not serve statusline-dashboard. It answers the Worker set, and the dashboard is rendered by the daemon rather than here, so there is nothing to draw until it does.",
      warning: false,
    };
  }
  const header = snapshot.dashboard.header;
  // The daemon colours its render unconditionally (#3150/#3152) and the editor
  // status bar draws no ANSI, so this caller strips at its boundary — the rule
  // the renderer states: the pipe decision belongs to the reader.
  return {
    text: stripAnsi(`${snapshot.dashboard.stale ? "$(warning)" : "$(server)"} ${header.line}`),
    tooltip: snapshot.dashboard.lines.map(stripAnsi).join("\n"),
    warning: snapshot.dashboard.stale,
  };
}

/** HTML-escape one line of daemon-rendered text. PURE. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The panel's body: the daemon's own lines, in a monospaced block. PURE.
 *
 * A `<pre>` rather than a `<table>` deliberately. The rows arrive column-aligned
 * because the daemon aligned them, and a table would hand that decision to the
 * browser — at which point the panel and the pane beside it would space the same
 * Worker set two different ways, and the alignment the daemon paid for would be
 * dead weight on the wire.
 */
export function renderDashboardHtml(snapshot: HostSnapshot): string {
  const body = dashboardBody(snapshot);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\';">',
    "<style>",
    "body { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-foreground); padding: 0.5rem; }",
    "pre { font-family: var(--vscode-editor-font-family, monospace); font-size: var(--vscode-editor-font-size, 12px); margin: 0; white-space: pre; overflow-x: auto; }",
    ".header { font-weight: 600; }",
    ".stale { color: var(--vscode-editorWarning-foreground); }",
    ".absence { color: var(--vscode-descriptionForeground); }",
    "</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

function dashboardBody(snapshot: HostSnapshot): string {
  if (!snapshot.reachable) {
    return [
      '<p class="absence">',
      escapeHtml(`redskilled did not answer at ${snapshot.socketPath} (${snapshot.source}).`),
      "</p>",
      '<p class="absence">',
      escapeHtml(snapshot.error?.message ?? "the daemon did not answer"),
      "</p>",
      '<p class="absence">',
      escapeHtml(
        "An empty host must mean an idle machine, never a failed lookup — so this panel refuses to draw a table it did not read. " +
          `Bring one up with \`${canonicalInvocation("red-skills-redskilled", ["provision"])}\`.`,
      ),
      "</p>",
    ].join("\n");
  }
  const dashboard = snapshot.dashboard;
  if (dashboard === null) {
    return [
      '<p class="absence">',
      escapeHtml(
        "This daemon does not serve statusline-dashboard. The dashboard is rendered by the daemon rather than here, so there is nothing to draw until it does.",
      ),
      "</p>",
    ].join("\n");
  }
  return [
    `<pre class="header${dashboard.stale ? " stale" : ""}">${escapeHtml(stripAnsi(dashboard.header.line))}</pre>`,
    ...(dashboard.rows.length === 0
      ? [
          '<pre class="absence">no Workers here — the machine is idle, and this is the daemon saying so</pre>',
        ]
      : [`<pre>${dashboardRows(dashboard).map(escapeHtml).join("\n")}</pre>`]),
  ].join("\n");
}

/**
 * Every line below the header, exactly as the daemon rendered them. PURE.
 *
 * Taken from `lines` rather than rebuilt from `rows`, so a trailing line the
 * daemon added — "… 3 more Worker(s)" — reaches the reader instead of being
 * dropped by a panel that only knew about Workers.
 */
export function dashboardRows(dashboard: RedskilledDashboard): readonly string[] {
  return dashboard.lines.slice(1).map(stripAnsi);
}
