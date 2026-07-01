// Annotation model for the CLI<->browser bridge.
//
// A human points at an exact element in a rendered HTML artifact and (optionally)
// selects a character range inside that element's text. The browser SDK posts the
// annotation to the local bridge; the agent polls it back and acts on *that exact*
// element + range — strictly better than "screenshot + describe in prose".

/** A character range inside an element's text content, with the quoted slice for verification. */
export interface TextRange {
  /** Inclusive start offset into the element's textContent. */
  start: number;
  /** Exclusive end offset into the element's textContent. */
  end: number;
  /** The exact substring the human selected (textContent.slice(start, end)). */
  quote: string;
}

export type AnnotationStatus = "open" | "resolved";

/** A single human annotation captured from the live artifact. */
export interface Annotation {
  /** Stable id, monotonic within a session ("a1", "a2", ...). */
  id: string;
  /** CSS selector path to the pointed-at element (e.g. "#plan > section:nth-child(2) > h2"). */
  selector: string;
  /** Optional character range inside the element's text. */
  textRange?: TextRange;
  /** The human's note. */
  comment: string;
  /** ISO timestamp when the human submitted it. */
  createdAt: string;
  status: AnnotationStatus;
}

/** Shape the browser SDK posts; the bridge stamps id/createdAt/status. */
export interface AnnotationInput {
  selector: string;
  textRange?: TextRange;
  comment: string;
}

/** Validate and normalise an annotation posted from the browser. Throws on malformed input. */
export function normalizeAnnotationInput(raw: unknown): AnnotationInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("annotation must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const selector = obj.selector;
  if (typeof selector !== "string" || selector.trim() === "") {
    throw new Error("annotation.selector must be a non-empty string");
  }
  const comment = obj.comment;
  if (typeof comment !== "string") {
    throw new Error("annotation.comment must be a string");
  }
  let textRange: TextRange | undefined;
  if (obj.textRange !== undefined && obj.textRange !== null) {
    const tr = obj.textRange as Record<string, unknown>;
    const start = tr.start;
    const end = tr.end;
    const quote = tr.quote;
    if (typeof start !== "number" || typeof end !== "number") {
      throw new Error("annotation.textRange.start/end must be numbers");
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
      throw new Error("annotation.textRange must be a valid [start, end) integer range");
    }
    if (typeof quote !== "string") {
      throw new Error("annotation.textRange.quote must be a string");
    }
    textRange = { start, end, quote };
  }
  return { selector: selector.trim(), comment, textRange };
}
