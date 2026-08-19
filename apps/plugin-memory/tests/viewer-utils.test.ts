import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  escapeHtmlNoSingleQuote,
  jsonForScript,
  jsonForScriptEscapedLessThan,
  metric,
  metricWithMeta,
  metricWithMetaSpan,
  metricWithRequiredMeta,
  metricWithStrongClass,
  warningsSection,
} from "../src/viewer-utils.js";

describe("viewer utils", () => {
  test("escapes HTML with the viewer default apostrophe handling", () => {
    expect(escapeHtml(`Tom's </script> & "x"`)).toBe(
      "Tom&#39;s &lt;/script&gt; &amp; &quot;x&quot;",
    );
  });

  test("preserves legacy no-single-quote escaping for older viewers", () => {
    expect(escapeHtmlNoSingleQuote(`Tom's <tag> & "x"`)).toBe(
      "Tom's &lt;tag&gt; &amp; &quot;x&quot;",
    );
  });

  test("serializes embedded JSON using the existing viewer variants", () => {
    expect(jsonForScript({ html: "</script><b>" })).toBe(`{
  "html": "<\\/script><b>"
}`);
    expect(jsonForScriptEscapedLessThan({ html: "</script><b>" })).toBe(`{
  "html": "\\u003c/script>\\u003cb>"
}`);
  });

  test("renders metric variants byte-for-byte", () => {
    expect(metric("Warnings", 2)).toBe(
      `<div class="metric"><strong>2</strong><span>Warnings</span></div>`,
    );
    expect(metricWithMeta("Grounded", "1/2", "50%")).toBe(
      `<div class="metric"><strong>1/2</strong><span>Grounded - 50%</span></div>`,
    );
    expect(metricWithRequiredMeta("Status", "ready", "2 total")).toBe(
      `<div class="metric"><strong>ready</strong><span>Status - 2 total</span></div>`,
    );
    expect(metricWithStrongClass("Confidence", "0.80", "ok")).toBe(
      `<div class="metric"><strong class="ok">0.80</strong><span>Confidence</span></div>`,
    );
    expect(metricWithMetaSpan("Agents", 3)).toBe(
      `<div class="metric"><strong>3</strong><span class="meta">Agents</span></div>`,
    );
  });

  test("renders shared warning sections with operation-specific empty text", () => {
    expect(warningsSection([], "No test warnings.")).toBe(`<section>
    <h2>Warnings</h2>
    <p class="empty">No test warnings.</p>
  </section>`);
    expect(warningsSection(["a < b"], "No test warnings.")).toBe(`<section>
    <h2>Warnings</h2>
    <ul><li class="warn">a &lt; b</li></ul>
  </section>`);
  });
});
