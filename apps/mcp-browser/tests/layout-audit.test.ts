import { describe, it, expect, afterEach } from "vitest";
import { openBridge, type BrowserBridge } from "@reddb-io/browser-bridge";

const HTML = `<!DOCTYPE html><html><body><p>Test</p></body></html>`;

describe("layout-audit gate", () => {
  let bridge: BrowserBridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("blocks done when overflow violations are present", async () => {
    bridge = await openBridge(HTML);

    const [result] = await Promise.all([
      bridge.layoutAudit(5_000),
      fetch(`${bridge.url}/api/layout-audit-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          violations: [
            {
              type: "overflow",
              selector: "div#wrapper",
              detail: "scrollWidth=300 clientWidth=200",
            },
          ],
        }),
      }),
    ]);

    expect(result.pass).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].type).toBe("overflow");
    expect(result.violations[0].selector).toBe("div#wrapper");
  });

  it("blocks done when cutoff violations are present", async () => {
    bridge = await openBridge(HTML);

    const [result] = await Promise.all([
      bridge.layoutAudit(5_000),
      fetch(`${bridge.url}/api/layout-audit-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          violations: [
            {
              type: "cutoff",
              selector: "section#hero",
              detail: "scrollWidth=500 clientWidth=320",
            },
          ],
        }),
      }),
    ]);

    expect(result.pass).toBe(false);
    expect(result.violations[0].type).toBe("cutoff");
  });

  it("blocks done when overlap violations are present", async () => {
    bridge = await openBridge(HTML);

    const [result] = await Promise.all([
      bridge.layoutAudit(5_000),
      fetch(`${bridge.url}/api/layout-audit-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          violations: [
            {
              type: "overlap",
              selector: "header + aside",
              detail: "elements overlap",
            },
          ],
        }),
      }),
    ]);

    expect(result.pass).toBe(false);
    expect(result.violations[0].type).toBe("overlap");
  });

  it("allows done when there are no violations", async () => {
    bridge = await openBridge(HTML);

    const [result] = await Promise.all([
      bridge.layoutAudit(5_000),
      fetch(`${bridge.url}/api/layout-audit-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ violations: [] }),
      }),
    ]);

    expect(result.pass).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("GET / serves the HTML artifact with the layout-audit SDK injected", async () => {
    bridge = await openBridge(HTML);

    const res = await fetch(`${bridge.url}/`);
    const html = await res.text();

    expect(html).toContain("/api/layout-audit-result");
    expect(html).toContain("scrollWidth");
    expect(html).toContain("getBoundingClientRect");
  });
});
