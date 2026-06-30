import { describe, it, expect } from "vitest";
import {
  auditLayout,
  assertLayoutClean,
  LayoutAuditError,
  type LayoutSnapshot,
  type ElementBox,
} from "./layout-audit.js";

function box(partial: Partial<ElementBox> & { selector: string }): ElementBox {
  return {
    rect: { x: 0, y: 0, width: 100, height: 20 },
    scrollWidth: 100,
    scrollHeight: 20,
    clientWidth: 100,
    clientHeight: 20,
    overflowX: "visible",
    overflowY: "visible",
    hasText: false,
    ...partial,
  };
}

function clean(elements: ElementBox[] = []): LayoutSnapshot {
  return { viewport: { width: 1280, height: 800 }, documentScrollWidth: 1280, elements };
}

describe("auditLayout", () => {
  it("passes a clean snapshot", () => {
    const r = auditLayout(clean([box({ selector: "h1", hasText: true })]));
    expect(r.passed).toBe(true);
    expect(r.findings).toEqual([]);
  });

  it("flags page-level horizontal overflow", () => {
    const snap = clean();
    snap.documentScrollWidth = 1400;
    const r = auditLayout(snap);
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain("horizontal-overflow");
  });

  it("flags an element extending past the viewport right edge", () => {
    const snap = clean([box({ selector: ".card", rect: { x: 1200, y: 0, width: 200, height: 50 } })]);
    const r = auditLayout(snap);
    expect(r.passed).toBe(false);
    const f = r.findings.find((x) => x.kind === "horizontal-overflow");
    expect(f?.selectors).toContain(".card");
  });

  it("flags clipped text when content overflows a hard clip", () => {
    const snap = clean([
      box({
        selector: "p.title",
        hasText: true,
        scrollWidth: 400,
        clientWidth: 100,
        overflowX: "hidden",
      }),
    ]);
    const r = auditLayout(snap);
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.kind)).toContain("clipped-text");
  });

  it("does NOT flag overflow that is scrollable (auto/scroll)", () => {
    const snap = clean([
      box({
        selector: "pre.code",
        hasText: true,
        scrollWidth: 400,
        clientWidth: 100,
        overflowX: "auto",
      }),
    ]);
    expect(auditLayout(snap).passed).toBe(true);
  });

  it("flags two overlapping text boxes", () => {
    const snap = clean([
      box({ selector: "h1", hasText: true, rect: { x: 0, y: 0, width: 100, height: 40 } }),
      box({ selector: "h2", hasText: true, rect: { x: 50, y: 20, width: 100, height: 40 } }),
    ]);
    const r = auditLayout(snap);
    expect(r.passed).toBe(false);
    const f = r.findings.find((x) => x.kind === "text-overlap");
    expect(f?.selectors.sort()).toEqual(["h1", "h2"]);
  });

  it("does NOT flag a nested text box as overlap", () => {
    const snap = clean([
      box({ selector: "section", hasText: true, rect: { x: 0, y: 0, width: 200, height: 200 } }),
      box({ selector: "section > span", hasText: true, rect: { x: 10, y: 10, width: 50, height: 20 } }),
    ]);
    expect(auditLayout(snap).passed).toBe(true);
  });

  it("respects tolerance for sub-pixel noise", () => {
    const snap = clean();
    snap.documentScrollWidth = 1280.5;
    expect(auditLayout(snap).passed).toBe(true);
  });
});

describe("assertLayoutClean gate", () => {
  it("does not throw on a clean render", () => {
    expect(() => assertLayoutClean(clean([box({ selector: "h1", hasText: true })]))).not.toThrow();
  });

  it("throws LayoutAuditError on a broken render, carrying the findings", () => {
    const snap = clean();
    snap.documentScrollWidth = 2000;
    try {
      assertLayoutClean(snap);
      throw new Error("expected gate to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(LayoutAuditError);
      expect((err as LayoutAuditError).findings.length).toBeGreaterThan(0);
    }
  });
});
