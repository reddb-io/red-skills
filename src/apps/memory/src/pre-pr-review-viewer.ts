import type { PrePrMemoryReview, PrePrReviewSection } from "./pre-pr-review.js";
import { escapeHtml, jsonForScript, metric } from "./viewer-utils.js";

export interface PrePrReviewViewerArtifact {
  contract: {
    name: "memory.pre_pr_review.viewer";
    version: "memory.pre_pr_review.viewer.v1";
    consumes: "memory.pre-pr-review";
  };
  review: PrePrMemoryReview;
  html: string;
}

export function buildPrePrReviewViewerArtifact(
  review: PrePrMemoryReview,
): PrePrReviewViewerArtifact {
  return {
    contract: {
      name: "memory.pre_pr_review.viewer",
      version: "memory.pre_pr_review.viewer.v1",
      consumes: "memory.pre-pr-review",
    },
    review,
    html: renderPrePrReviewViewer(review),
  };
}

function renderPrePrReviewViewer(review: PrePrMemoryReview): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Memory pre-PR review viewer</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f3;
      --ink: #202421;
      --muted: #667068;
      --line: #d6dbd2;
      --panel: #ffffff;
      --accent: #0c6f68;
      --warn: #8c5d16;
      --bad: #a63a3a;
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
    h3 { font-size: 13px; margin-bottom: 4px; }
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
    .layout { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(320px, .8fr); gap: 14px; }
    .stack { display: grid; gap: 14px; }
    ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    li { border-top: 1px solid var(--line); padding-top: 10px; }
    li:first-child { border-top: 0; padding-top: 0; }
    .warn { color: var(--warn); }
    .bad { color: var(--bad); }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; overflow-wrap: anywhere; }
    @media (max-width: 880px) { header, .metrics, .layout { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Pre-PR Memory Review</h1>
        <p class="meta">${escapeHtml(review.comparison ?? "working tree")} - ${review.changedFiles.length} changed file(s)</p>
      </div>
      <div class="badge">read-only</div>
    </header>
    <div class="metrics">
      ${metric("Changed files", review.changedFiles.length)}
      ${metric("Evidence refs", review.evidence.length)}
      ${metric("Risks", review.risks.items.length)}
      ${metric("Missing groups", review.missingEvidence.length)}
    </div>
    <div class="layout">
      <div class="stack">
        ${section("Impacted concepts", review.impactedConcepts)}
        ${section("Related decisions", review.relatedDecisions)}
        ${section("Known failures", review.knownFailures)}
        ${section("Suggested validations", review.suggestedValidations)}
        ${section("Risks", review.risks)}
      </div>
      <div class="stack">
        ${changedFilesSection(review.changedFiles)}
        ${missingSection(review.missingEvidence)}
        ${evidenceSection(review)}
      </div>
    </div>
    <script id="pre-pr-review-data" type="application/json">${jsonForScript(review)}</script>
  </main>
</body>
</html>
`;
}


function section(title: string, section: PrePrReviewSection): string {
  return `<section>
    <h2>${escapeHtml(title)}</h2>
    ${
      section.items.length === 0
        ? `<p class="empty">No ${escapeHtml(title.toLowerCase())} available.</p>`
        : `<ul>${section.items.map(item).join("")}</ul>`
    }
  </section>`;
}

function item(value: PrePrReviewSection["items"][number]): string {
  return `<li>
    <h3>${escapeHtml(value.title)}</h3>
    <p>${escapeHtml(value.summary)}</p>
    <p class="meta">${value.evidence.map((evidence) => escapeHtml(`${evidence.marker} ${evidence.urn}`)).join(", ")}</p>
  </li>`;
}

function changedFilesSection(files: string[]): string {
  return `<section>
    <h2>Changed files</h2>
    ${files.length === 0 ? `<p class="empty">No changed files.</p>` : `<ul>${files.map((file) => `<li><code>${escapeHtml(file)}</code></li>`).join("")}</ul>`}
  </section>`;
}

function missingSection(groups: string[]): string {
  return `<section>
    <h2>Missing evidence</h2>
    ${groups.length === 0 ? `<p class="empty">No missing evidence groups.</p>` : `<ul>${groups.map((group) => `<li class="warn">${escapeHtml(group)}</li>`).join("")}</ul>`}
  </section>`;
}

function evidenceSection(review: PrePrMemoryReview): string {
  return `<section>
    <h2>Evidence</h2>
    ${
      review.evidence.length === 0
        ? `<p class="empty">No evidence refs.</p>`
        : `<ul>${review.evidence.map((ref) => `<li><h3>${escapeHtml(`${ref.marker} ${ref.title}`)}</h3><p>${escapeHtml(ref.excerpt)}</p><p class="meta"><code>${escapeHtml(ref.urn)}</code> - ${escapeHtml(ref.nodeType)} - ${escapeHtml(ref.confidence)}</p></li>`).join("")}</ul>`
    }
  </section>`;
}
