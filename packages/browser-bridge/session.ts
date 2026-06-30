// Bridge session store — the local, no-cloud state behind the CLI<->browser bridge.
//
// State lives under <root>/.red/browser-bridge/<sessionId>/:
//   session.json     — metadata (artifact path, augmented path, status)
//   annotations.json — append-only list the browser SDK posts and the agent polls
//
// The HTTP/long-poll transport (server.ts) is a thin adapter over these functions:
// a POST calls recordAnnotation, a GET long-poll calls pollAnnotations. Keeping the
// store filesystem-pure makes the annotation round-trip testable without a browser.

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { injectBridgeSdk, type InjectConfig } from "./inject.js";
import { normalizeAnnotationInput, type Annotation, type AnnotationInput } from "./annotation.js";

export const BRIDGE_DIR = ".red/browser-bridge";

export type SessionStatus = "open" | "closed";

export interface Session {
  id: string;
  /** Absolute or repo-relative path to the source HTML artifact. */
  artifactPath: string;
  /** Path to the augmented artifact the human opens (artifact + injected SDK). */
  augmentedPath: string;
  endpoint: string;
  status: SessionStatus;
  createdAt: string;
}

export interface OpenArtifactOptions {
  /** Root the bridge state dir hangs under. Default process.cwd(). */
  root?: string;
  /** Bridge endpoint baked into the injected SDK. Default "http://127.0.0.1:8917". */
  endpoint?: string;
  /** Deterministic session id (tests/CLI). Default derived from artifact + counter. */
  sessionId?: string;
  /** Injected as the augmented artifact alongside the source. Default true. */
  writeAugmented?: boolean;
  /** ISO timestamp for createdAt (injected for determinism). Default new Date(). */
  now?: string;
}

function sessionDir(root: string, id: string): string {
  return join(root, BRIDGE_DIR, id);
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "artifact";
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Open an HTML artifact for review: create the session state, inject the portable SDK,
 * and write the augmented artifact the human opens. Returns the {@link Session}.
 */
export function openArtifact(htmlPath: string, opts: OpenArtifactOptions = {}): Session {
  const root = opts.root ?? process.cwd();
  const endpoint = opts.endpoint ?? "http://127.0.0.1:8917";
  const createdAt = opts.now ?? new Date().toISOString();
  const html = readFileSync(htmlPath, "utf8");
  const id = opts.sessionId ?? `${slugify(htmlPath)}-${String(html.length)}`;

  const dir = sessionDir(root, id);
  mkdirSync(dir, { recursive: true });

  const augmentedPath = htmlPath.replace(/\.html?$/i, "") + ".bridge.html";
  if (opts.writeAugmented !== false) {
    const cfg: InjectConfig = { sessionId: id, endpoint };
    writeFileSync(augmentedPath, injectBridgeSdk(html, cfg), "utf8");
  }

  const session: Session = {
    id,
    artifactPath: htmlPath,
    augmentedPath,
    endpoint,
    status: "open",
    createdAt,
  };
  writeFileSync(join(dir, "session.json"), JSON.stringify(session, null, 2), "utf8");
  if (!existsSync(join(dir, "annotations.json"))) {
    writeFileSync(join(dir, "annotations.json"), "[]", "utf8");
  }
  return session;
}

/** Load a session by id, or null when it does not exist. */
export function loadSession(root: string, id: string): Session | null {
  const path = join(sessionDir(root, id), "session.json");
  if (!existsSync(path)) return null;
  return readJson<Session | null>(path, null);
}

/** All annotations for a session, in submission order. */
export function listAnnotations(root: string, id: string): Annotation[] {
  return readJson<Annotation[]>(join(sessionDir(root, id), "annotations.json"), []);
}

/**
 * Record a human annotation (the browser SDK's POST lands here). Validates the input,
 * stamps id/createdAt/status, appends it, and returns the stored {@link Annotation}.
 */
export function recordAnnotation(
  root: string,
  id: string,
  input: AnnotationInput | unknown,
  now?: string,
): Annotation {
  const dir = sessionDir(root, id);
  if (!existsSync(join(dir, "session.json"))) {
    throw new Error(`unknown bridge session: ${id}`);
  }
  const normalized = normalizeAnnotationInput(input);
  const existing = listAnnotations(root, id);
  const annotation: Annotation = {
    id: `a${existing.length + 1}`,
    selector: normalized.selector,
    textRange: normalized.textRange,
    comment: normalized.comment,
    createdAt: now ?? new Date().toISOString(),
    status: "open",
  };
  existing.push(annotation);
  writeFileSync(join(dir, "annotations.json"), JSON.stringify(existing, null, 2), "utf8");
  return annotation;
}

export interface PollResult {
  annotations: Annotation[];
  /** Cursor to pass to the next poll to receive only newer annotations. */
  cursor: number;
}

/**
 * Poll annotations newer than `cursor` (the count already seen). This is the read half
 * of the long-poll loop; server.ts wraps it to hold the connection until new data lands.
 */
export function pollAnnotations(root: string, id: string, cursor = 0): PollResult {
  const all = listAnnotations(root, id);
  const safeCursor = cursor < 0 ? 0 : cursor;
  return { annotations: all.slice(safeCursor), cursor: all.length };
}

/** Mark one annotation resolved (the agent acted on it). */
export function resolveAnnotation(root: string, id: string, annotationId: string): void {
  const dir = sessionDir(root, id);
  const all = listAnnotations(root, id);
  const target = all.find((a) => a.id === annotationId);
  if (!target) throw new Error(`unknown annotation ${annotationId} in session ${id}`);
  target.status = "resolved";
  writeFileSync(join(dir, "annotations.json"), JSON.stringify(all, null, 2), "utf8");
}

/** Close a session (sets status; state is retained for the record). */
export function closeSession(root: string, id: string): void {
  const session = loadSession(root, id);
  if (!session) throw new Error(`unknown bridge session: ${id}`);
  session.status = "closed";
  writeFileSync(join(sessionDir(root, id), "session.json"), JSON.stringify(session, null, 2), "utf8");
}

/** List all session ids present under the bridge state dir. */
export function listSessions(root: string): string[] {
  const base = join(root, BRIDGE_DIR);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}
