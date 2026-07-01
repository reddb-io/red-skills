// Layout-audit gate: the ground-truth check that stops an agent from declaring a
// generated HTML render "done" while it is visually broken. It runs over a layout
// *snapshot* — geometry the browser SDK reads from the rendered DOM (or that tests
// supply synthetically) — so the audit logic is pure and browser-free here.
//
// Three failure classes it catches:
//   - horizontal-overflow: content wider than the viewport (the classic side-scroll bug)
//   - clipped-text       : a text element whose content is cut off by a non-scrollable clip
//   - text-overlap       : two text elements whose boxes collide

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Geometry + overflow state for one element, as read from the rendered DOM. */
export interface ElementBox {
  /** CSS selector path, for pointing the agent at the offending node. */
  selector: string;
  rect: Rect;
  /** Full content extent (element.scrollWidth/scrollHeight). */
  scrollWidth: number;
  scrollHeight: number;
  /** Visible box (element.clientWidth/clientHeight). */
  clientWidth: number;
  clientHeight: number;
  /** Computed overflow-x / overflow-y ("visible" | "hidden" | "clip" | "auto" | "scroll"). */
  overflowX: string;
  overflowY: string;
  /** Whether this element directly renders text (so clipping/overlap matter). */
  hasText: boolean;
}

export interface LayoutSnapshot {
  viewport: { width: number; height: number };
  /** document.documentElement.scrollWidth — the page-level horizontal extent. */
  documentScrollWidth: number;
  elements: ElementBox[];
}

export type LayoutFindingKind = "horizontal-overflow" | "clipped-text" | "text-overlap";
export type LayoutSeverity = "error" | "warning";

export interface LayoutFinding {
  kind: LayoutFindingKind;
  severity: LayoutSeverity;
  /** Selectors implicated (one for overflow/clip, two for overlap). */
  selectors: string[];
  detail: string;
}

export interface AuditOptions {
  /** Sub-pixel slack to absorb rounding noise (px). Default 1. */
  tolerancePx?: number;
  /** Minimum overlapping area (px^2) before two text boxes count as colliding. Default 4. */
  minOverlapArea?: number;
}

export interface LayoutAuditResult {
  passed: boolean;
  findings: LayoutFinding[];
}

const OVERFLOW_CLIPS = new Set(["hidden", "clip"]);

function right(r: Rect): number {
  return r.x + r.width;
}
function bottom(r: Rect): number {
  return r.y + r.height;
}

/** Overlapping area of two rects (0 when they do not intersect). */
function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const h = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/** True when `outer` fully contains `inner` (nesting is legitimate, not an overlap bug). */
function contains(outer: Rect, inner: Rect, tol: number): boolean {
  return (
    inner.x >= outer.x - tol &&
    inner.y >= outer.y - tol &&
    right(inner) <= right(outer) + tol &&
    bottom(inner) <= bottom(outer) + tol
  );
}

/**
 * Audit a layout snapshot for overflow, clipping, and overlap.
 * Returns every finding plus a `passed` flag (true only when no `error` findings exist).
 */
export function auditLayout(snapshot: LayoutSnapshot, opts: AuditOptions = {}): LayoutAuditResult {
  const tol = opts.tolerancePx ?? 1;
  const minOverlapArea = opts.minOverlapArea ?? 4;
  const findings: LayoutFinding[] = [];
  const viewportW = snapshot.viewport.width;

  // 1. Page-level horizontal overflow.
  if (snapshot.documentScrollWidth > viewportW + tol) {
    findings.push({
      kind: "horizontal-overflow",
      severity: "error",
      selectors: ["html"],
      detail: `document scrollWidth ${snapshot.documentScrollWidth}px exceeds viewport width ${viewportW}px`,
    });
  }

  for (const el of snapshot.elements) {
    // 2a. Element-level horizontal overflow: a box extends past the right viewport edge.
    if (right(el.rect) > viewportW + tol) {
      findings.push({
        kind: "horizontal-overflow",
        severity: "error",
        selectors: [el.selector],
        detail: `element right edge ${right(el.rect)}px exceeds viewport width ${viewportW}px`,
      });
    }

    // 2b. Clipped text: content overflows the visible box AND overflow is a hard clip
    // (hidden/clip) rather than scrollable (auto/scroll) — so the text is actually cut off.
    if (el.hasText) {
      const clippedX = el.scrollWidth > el.clientWidth + tol && OVERFLOW_CLIPS.has(el.overflowX);
      const clippedY = el.scrollHeight > el.clientHeight + tol && OVERFLOW_CLIPS.has(el.overflowY);
      if (clippedX || clippedY) {
        const axes = [clippedX ? "horizontally" : "", clippedY ? "vertically" : ""]
          .filter(Boolean)
          .join(" and ");
        findings.push({
          kind: "clipped-text",
          severity: "error",
          selectors: [el.selector],
          detail: `text content is clipped ${axes} (content ${el.scrollWidth}x${el.scrollHeight} vs box ${el.clientWidth}x${el.clientHeight})`,
        });
      }
    }
  }

  // 3. Text overlap: any two text-bearing boxes that collide without one nesting the other.
  const textEls = snapshot.elements.filter((e) => e.hasText);
  for (let i = 0; i < textEls.length; i++) {
    for (let j = i + 1; j < textEls.length; j++) {
      const a = textEls[i];
      const b = textEls[j];
      if (contains(a.rect, b.rect, tol) || contains(b.rect, a.rect, tol)) continue;
      if (overlapArea(a.rect, b.rect) >= minOverlapArea) {
        findings.push({
          kind: "text-overlap",
          severity: "error",
          selectors: [a.selector, b.selector],
          detail: `text boxes overlap (~${Math.round(overlapArea(a.rect, b.rect))}px^2)`,
        });
      }
    }
  }

  const passed = findings.every((f) => f.severity !== "error");
  return { passed, findings };
}

/** Raised by {@link assertLayoutClean} when the layout-audit gate fails. */
export class LayoutAuditError extends Error {
  readonly findings: LayoutFinding[];
  constructor(findings: LayoutFinding[]) {
    super(`layout-audit gate failed with ${findings.length} finding(s): ${summarizeFindings(findings)}`);
    this.name = "LayoutAuditError";
    this.findings = findings;
  }
}

/** One-line summary of findings, for logs and gate messages. */
export function summarizeFindings(findings: LayoutFinding[]): string {
  if (findings.length === 0) return "no findings";
  return findings.map((f) => `${f.kind} [${f.selectors.join(", ")}]`).join("; ");
}

/**
 * Gate helper: throws {@link LayoutAuditError} when the snapshot has any error-level
 * finding. Call this before an agent reports a render "done".
 */
export function assertLayoutClean(snapshot: LayoutSnapshot, opts?: AuditOptions): void {
  const { passed, findings } = auditLayout(snapshot, opts);
  if (!passed) {
    throw new LayoutAuditError(findings.filter((f) => f.severity === "error"));
  }
}
