// Portable SDK injection.
//
// The bridge augments a generated artifact with a single, self-contained, *additive*
// <script>. Portability rule (acceptance criterion): the augmented file must render
// identically in a plain browser with no bridge running. The script therefore:
//   - adds no markup and no styles to the document on its own,
//   - probes the local bridge endpoint and silently no-ops when it is unreachable
//     (e.g. opened from file:// with no CLI), so a plain browser just shows the artifact.

export interface InjectConfig {
  /** Session id the SDK reports annotations against. */
  sessionId: string;
  /** Bridge base URL the SDK talks to (e.g. "http://127.0.0.1:8917"). */
  endpoint: string;
}

const MARKER_OPEN = "<!-- red:browser-bridge:begin -->";
const MARKER_CLOSE = "<!-- red:browser-bridge:end -->";

/** The browser-side SDK source, parameterised at injection time. Kept dependency-free. */
function sdkSource(config: InjectConfig): string {
  // Serialised as JSON so an attacker-controlled artifact path cannot break out of the string.
  const cfg = JSON.stringify({ sessionId: config.sessionId, endpoint: config.endpoint });
  return `(function () {
  "use strict";
  var CFG = ${cfg};
  // Only activate against a reachable http(s) bridge. file:// or a down bridge => inert,
  // so the artifact renders identically in a plain browser.
  if (!/^https?:$/.test(location.protocol) && CFG.endpoint.indexOf("http") !== 0) return;
  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    var path = [];
    while (el && el.nodeType === 1 && el.tagName.toLowerCase() !== "html") {
      var sel = el.tagName.toLowerCase();
      if (el.id) { sel = "#" + CSS.escape(el.id); path.unshift(sel); break; }
      var parent = el.parentNode;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) {
          return c.tagName === el.tagName;
        });
        if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
      }
      path.unshift(sel);
      el = el.parentNode;
    }
    return path.join(" > ");
  }
  function selectionRange(el) {
    var s = window.getSelection && window.getSelection();
    if (!s || s.rangeCount === 0 || s.isCollapsed) return null;
    var text = el.textContent || "";
    var quote = s.toString();
    var start = text.indexOf(quote);
    if (start < 0) return null;
    return { start: start, end: start + quote.length, quote: quote };
  }
  function post(annotation) {
    return fetch(CFG.endpoint + "/sessions/" + CFG.sessionId + "/annotations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(annotation)
    });
  }
  // Probe; stay inert if the bridge is not answering.
  fetch(CFG.endpoint + "/sessions/" + CFG.sessionId + "/health").then(function (r) {
    if (!r.ok) return;
    document.addEventListener("contextmenu", function (ev) {
      var el = ev.target;
      if (!(el instanceof Element)) return;
      ev.preventDefault();
      var comment = window.prompt("Annotation for <" + el.tagName.toLowerCase() + ">:");
      if (comment == null) return;
      post({ selector: cssPath(el), textRange: selectionRange(el), comment: comment });
    }, true);
  }).catch(function () { /* bridge down: stay inert */ });
})();`;
}

/**
 * Inject the bridge SDK into HTML just before </body> (or appended when absent).
 * Idempotent: re-injecting replaces a previously injected block instead of stacking.
 * The injected block is wrapped in HTML-comment markers so it can be stripped to recover
 * the byte-identical original artifact (see {@link stripBridgeSdk}).
 */
export function injectBridgeSdk(html: string, config: InjectConfig): string {
  const clean = stripBridgeSdk(html);
  const block = `${MARKER_OPEN}\n<script>\n${sdkSource(config)}\n</script>\n${MARKER_CLOSE}`;
  const lower = clean.toLowerCase();
  const bodyClose = lower.lastIndexOf("</body>");
  // Injection adds the block plus exactly one trailing newline and nothing before it,
  // so stripBridgeSdk can recover the byte-identical original (see stripBridgeSdk).
  if (bodyClose >= 0) {
    return clean.slice(0, bodyClose) + block + "\n" + clean.slice(bodyClose);
  }
  return clean + block + "\n";
}

/** Remove a previously injected bridge block, recovering the original artifact. */
export function stripBridgeSdk(html: string): string {
  const start = html.indexOf(MARKER_OPEN);
  if (start < 0) return html;
  const end = html.indexOf(MARKER_CLOSE, start);
  if (end < 0) return html;
  let after = end + MARKER_CLOSE.length;
  // Swallow the single trailing newline injection adds; never touch the char before
  // the block (it belongs to the original artifact).
  if (html[after] === "\n") after += 1;
  return html.slice(0, start) + html.slice(after);
}

/** True when the HTML already carries an injected bridge block. */
export function hasBridgeSdk(html: string): boolean {
  return html.includes(MARKER_OPEN) && html.includes(MARKER_CLOSE);
}
