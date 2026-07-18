import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import {
  openArtifact,
  recordAnnotation,
  pollAnnotations,
  listAnnotations,
  resolveAnnotation,
  closeSession,
  loadSession,
  listSessions,
} from "./session.js";
import { hasBridgeSdk, stripBridgeSdk } from "./inject.js";

let root: string;
let artifact: string;

const HTML = `<!doctype html><html><body><h1 id="t">Title</h1><p>Body text here.</p></body></html>`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-"));
  artifact = join(root, "plan.html");
  writeFileSync(artifact, HTML, "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("openArtifact", () => {
  it("creates session state and writes a portable augmented artifact", () => {
    const s = openArtifact(artifact, { root, sessionId: "s1", now: "2026-06-30T00:00:00Z" });
    expect(s.id).toBe("s1");
    expect(s.status).toBe("open");
    expect(existsSync(s.augmentedPath)).toBe(true);

    const augmented = readFileSync(s.augmentedPath, "utf8");
    expect(hasBridgeSdk(augmented)).toBe(true);
    // Portability: stripping the bridge recovers the exact original artifact.
    expect(stripBridgeSdk(augmented)).toBe(HTML);

    expect(loadSession(root, "s1")?.id).toBe("s1");
    expect(decode(readFileSync(join(root, ".red/browser-bridge/s1/session.json"), "utf8"))).toEqual(s);
    expect(listSessions(root)).toContain("s1");
  });

  it("loads legacy JSON session state", () => {
    const dir = join(root, ".red/browser-bridge/s1");
    mkdirSync(dir, { recursive: true });
    const session = {
      id: "s1",
      artifactPath: artifact,
      augmentedPath: artifact.replace(/\.html?$/i, "") + ".bridge.html",
      endpoint: "http://127.0.0.1:8917",
      status: "open" as const,
      createdAt: "2026-06-30T00:00:00Z",
    };
    const annotation = {
      id: "a1",
      selector: "#t",
      comment: "legacy",
      createdAt: "2026-06-30T01:00:00Z",
      status: "open" as const,
    };
    writeFileSync(join(dir, "session.json"), JSON.stringify(session), "utf8");
    writeFileSync(join(dir, "annotations.json"), JSON.stringify([annotation]), "utf8");

    expect(loadSession(root, "s1")).toEqual(session);
    expect(listAnnotations(root, "s1")).toEqual([annotation]);
  });
});

describe("annotation round-trip (human -> agent)", () => {
  it("captures element selector + character range and returns it to a poller", () => {
    openArtifact(artifact, { root, sessionId: "s1" });

    // Human points at an element and selects a character range inside its text.
    const stored = recordAnnotation(
      root,
      "s1",
      {
        selector: "#t",
        textRange: { start: 0, end: 5, quote: "Title" },
        comment: "make this bigger",
      },
      "2026-06-30T01:00:00Z",
    );
    expect(stored.id).toBe("a1");
    expect(stored.status).toBe("open");

    // Agent polls and receives the exact annotation.
    const first = pollAnnotations(root, "s1", 0);
    expect(first.annotations).toHaveLength(1);
    expect(first.annotations[0].selector).toBe("#t");
    expect(first.annotations[0].textRange).toEqual({ start: 0, end: 5, quote: "Title" });
    expect(first.cursor).toBe(1);

    // Long-poll semantics: polling from the cursor returns nothing until new data lands.
    expect(pollAnnotations(root, "s1", first.cursor).annotations).toHaveLength(0);

    recordAnnotation(root, "s1", { selector: "p", comment: "tighten copy" });
    const next = pollAnnotations(root, "s1", first.cursor);
    expect(next.annotations).toHaveLength(1);
    expect(next.annotations[0].id).toBe("a2");
    expect(next.annotations[0].textRange).toBeUndefined();
    expect(decode(readFileSync(join(root, ".red/browser-bridge/s1/annotations.json"), "utf8"))).toEqual({
      annotations: [
        {
          id: stored.id,
          selector: stored.selector,
          comment: stored.comment,
          createdAt: stored.createdAt,
          status: stored.status,
          textRangeStart: 0,
          textRangeEnd: 5,
          textRangeQuote: "Title",
        },
        {
          id: next.annotations[0]?.id,
          selector: next.annotations[0]?.selector,
          comment: next.annotations[0]?.comment,
          createdAt: next.annotations[0]?.createdAt,
          status: next.annotations[0]?.status,
        },
      ],
    });
  });

  it("resolves an annotation the agent acted on", () => {
    openArtifact(artifact, { root, sessionId: "s1" });
    recordAnnotation(root, "s1", { selector: "#t", comment: "x" });
    resolveAnnotation(root, "s1", "a1");
    expect(listAnnotations(root, "s1")[0].status).toBe("resolved");
  });

  it("rejects a malformed annotation", () => {
    openArtifact(artifact, { root, sessionId: "s1" });
    expect(() => recordAnnotation(root, "s1", { comment: "no selector" })).toThrow();
    expect(() =>
      recordAnnotation(root, "s1", { selector: "p", comment: "bad range", textRange: { start: 5, end: 2, quote: "" } }),
    ).toThrow();
  });

  it("rejects annotations against an unknown session", () => {
    expect(() => recordAnnotation(root, "nope", { selector: "p", comment: "x" })).toThrow(/unknown bridge session/);
  });
});

describe("closeSession", () => {
  it("marks the session closed but retains its annotations", () => {
    openArtifact(artifact, { root, sessionId: "s1" });
    recordAnnotation(root, "s1", { selector: "#t", comment: "x" });
    closeSession(root, "s1");
    expect(loadSession(root, "s1")?.status).toBe("closed");
    expect(listAnnotations(root, "s1")).toHaveLength(1);
  });
});
