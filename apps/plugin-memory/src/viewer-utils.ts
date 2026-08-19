export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeHtmlNoSingleQuote(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function jsonForScript(value: unknown): string {
  return JSON.stringify(value, null, 2).replaceAll("</", "<\\/");
}

export function jsonForScriptEscapedLessThan(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
}

export function metric(label: string, value: number | string): string {
  return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

export function metricWithMeta(
  label: string,
  value: number | string,
  meta: string = "",
): string {
  return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}${meta ? ` - ${escapeHtml(meta)}` : ""}</span></div>`;
}

export function metricWithRequiredMeta(
  label: string,
  value: number | string,
  meta: string,
): string {
  return `<div class="metric"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)} - ${escapeHtml(meta)}</span></div>`;
}

export function metricWithStrongClass(
  label: string,
  value: number | string,
  className = "",
): string {
  return `<div class="metric"><strong class="${escapeHtml(className)}">${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`;
}

export function metricWithMetaSpan(label: string, value: number): string {
  return `<div class="metric"><strong>${value}</strong><span class="meta">${escapeHtmlNoSingleQuote(label)}</span></div>`;
}

export function warningsSection(warnings: string[], emptyText: string): string {
  return `<section>
    <h2>Warnings</h2>
    ${
      warnings.length === 0
        ? `<p class="empty">${emptyText}</p>`
        : `<ul>${warnings.map((warning) => `<li class="warn">${escapeHtml(warning)}</li>`).join("")}</ul>`
    }
  </section>`;
}
