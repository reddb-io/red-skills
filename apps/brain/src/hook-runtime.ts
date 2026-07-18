import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { withBrainRuntime } from "./runtime.js";

export type Runner = "codex" | "claude" | "hermes" | "unknown";

/** The SessionStart breadcrumb Brain drops on disk each session. */
export interface LastSessionRecord {
  runner: string;
  lifecycle: string;
  rootDir: string;
  connectionString: string;
  startedAt: string;
}

/**
 * Encode the SessionStart breadcrumb as TOON (the stack's on-disk doctrine —
 * every Brain-authored structured file is TOON, never JSON). The write and read
 * halves convert together: {@link decodeLastSession} sniff-decodes the same
 * format.
 */
export function encodeLastSession(record: LastSessionRecord): string {
  return encode(record as unknown as JsonValue);
}

/**
 * Sniff-decode a SessionStart breadcrumb: legacy raw JSON first, TOON fallback,
 * so a file written by an older bundle (JSON) still reads after the flip. TOON
 * `decode` throws on the JSON `{` header, so the JSON-first order never
 * mis-parses a TOON document.
 */
export function decodeLastSession(text: string): LastSessionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = decode(text);
  }
  const rec = (parsed ?? {}) as Partial<LastSessionRecord>;
  return {
    runner: typeof rec.runner === "string" ? rec.runner : "",
    lifecycle: typeof rec.lifecycle === "string" ? rec.lifecycle : "",
    rootDir: typeof rec.rootDir === "string" ? rec.rootDir : "",
    connectionString: typeof rec.connectionString === "string" ? rec.connectionString : "",
    startedAt: typeof rec.startedAt === "string" ? rec.startedAt : "",
  };
}

export async function handleHook(lifecycle: string, runner: Runner): Promise<Record<string, unknown>> {
  if (lifecycle !== "SessionStart") return {};
  const config = await withBrainRuntime(async ({ config, store }) => {
    await store.status();
    return config;
  });
  const stateDir = join(config.rootDir, ".red", "brain", "sessions");
  await mkdir(stateDir, { recursive: true });
  // Filename retained (wave-1 in-place convention); only the content flips to
  // TOON, and decodeLastSession sniff-reads either format.
  await writeFile(
    join(stateDir, "last-session.json"),
    encodeLastSession({
      runner,
      lifecycle,
      rootDir: config.rootDir,
      connectionString: config.connectionString,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  return {};
}
