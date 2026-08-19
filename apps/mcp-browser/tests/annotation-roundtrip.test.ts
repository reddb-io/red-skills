import { describe, it, expect, afterEach } from "vitest";
import { openBridge, type BrowserBridge } from "@reddb-io/browser-bridge";

const SIMPLE_HTML = `<!DOCTYPE html><html><body><p id="intro">Hello world</p></body></html>`;

describe("annotation round-trip", () => {
  let bridge: BrowserBridge | undefined;

  afterEach(async () => {
    await bridge?.close();
    bridge = undefined;
  });

  it("waitForAnnotation resolves with the posted element and char range", async () => {
    bridge = await openBridge(SIMPLE_HTML);

    const payload = {
      element: { tagName: "P", id: "intro", className: "", xpath: '//*[@id="intro"]' },
      charRange: { start: 0, end: 5, text: "Hello" },
      timestamp: new Date().toISOString(),
    };

    const [received] = await Promise.all([
      bridge.waitForAnnotation(5_000),
      fetch(`${bridge.url}/api/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    ]);

    expect(received.element.tagName).toBe("P");
    expect(received.element.id).toBe("intro");
    expect(received.element.xpath).toBe('//*[@id="intro"]');
    expect(received.charRange.start).toBe(0);
    expect(received.charRange.end).toBe(5);
    expect(received.charRange.text).toBe("Hello");
  });

  it("queues multiple annotations when called before waitForAnnotation", async () => {
    bridge = await openBridge(SIMPLE_HTML);

    const make = (text: string) => ({
      element: { tagName: "P", id: "intro", className: "", xpath: '//*[@id="intro"]' },
      charRange: { start: 0, end: text.length, text },
      timestamp: new Date().toISOString(),
    });

    await fetch(`${bridge.url}/api/annotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(make("Hello")),
    });
    await fetch(`${bridge.url}/api/annotate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(make("world")),
    });

    const first = await bridge.waitForAnnotation(5_000);
    const second = await bridge.waitForAnnotation(5_000);

    expect(first.charRange.text).toBe("Hello");
    expect(second.charRange.text).toBe("world");
  });

  it("GET / serves the HTML artifact with the annotation SDK injected", async () => {
    bridge = await openBridge(SIMPLE_HTML);

    const res = await fetch(`${bridge.url}/`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<p id="intro">Hello world</p>');
    expect(html).toContain("/api/annotate");
    expect(html).toContain("mouseup");
    expect(html).toContain("charRange");
  });
});
