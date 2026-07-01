import { describe, it, expect } from "vitest";
import { injectBridgeSdk, stripBridgeSdk, hasBridgeSdk } from "./inject.js";

const ORIGINAL = `<!doctype html>
<html><head><title>Plan</title></head>
<body>
<h1>Quarter plan</h1>
<p>Ship the bridge.</p>
</body></html>`;

const cfg = { sessionId: "sess-1", endpoint: "http://127.0.0.1:8917" };

describe("injectBridgeSdk portability", () => {
  it("preserves the original markup verbatim (additive only)", () => {
    const out = injectBridgeSdk(ORIGINAL, cfg);
    expect(out).toContain("<h1>Quarter plan</h1>");
    expect(out).toContain("<p>Ship the bridge.</p>");
    expect(out).toContain("<title>Plan</title>");
  });

  it("inserts the SDK before </body>", () => {
    const out = injectBridgeSdk(ORIGINAL, cfg);
    expect(out.indexOf("red:browser-bridge:begin")).toBeLessThan(out.indexOf("</body>"));
    expect(hasBridgeSdk(out)).toBe(true);
  });

  it("round-trips back to the byte-identical original (renders identically in a plain browser)", () => {
    const out = injectBridgeSdk(ORIGINAL, cfg);
    expect(stripBridgeSdk(out)).toBe(ORIGINAL);
  });

  it("is idempotent — re-injecting replaces rather than stacks", () => {
    const once = injectBridgeSdk(ORIGINAL, cfg);
    const twice = injectBridgeSdk(once, cfg);
    expect(once).toBe(twice);
    expect((twice.match(/red:browser-bridge:begin/g) ?? []).length).toBe(1);
  });

  it("appends when there is no </body>", () => {
    const frag = `<h1>fragment</h1>`;
    const out = injectBridgeSdk(frag, cfg);
    expect(out).toContain("<h1>fragment</h1>");
    expect(stripBridgeSdk(out)).toBe(frag);
  });

  it("bakes the session config into the SDK as JSON (no breakout)", () => {
    const out = injectBridgeSdk(ORIGINAL, cfg);
    expect(out).toContain('"sessionId":"sess-1"');
    expect(out).toContain('"endpoint":"http://127.0.0.1:8917"');
  });
});
