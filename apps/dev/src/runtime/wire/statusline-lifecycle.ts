/**
 * The Statusline Lifecycle wire: one bounded, probe-only redskilled read and a
 * last-known Shared-render tail in the statusline state lane.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { probeStatusline } from "@reddb-io/redskilled/statusline-command";
import type { RedskilledStatuslineProjectMatch } from "@reddb-io/redskilled-render";
import { statuslineStateDir } from "@reddb-io/shared/red-paths.js";
import { encodeDevSnapshotToon } from "../../core/toon-snapshot.js";
import {
  lifecycleTailLines,
  resolveStatuslineLifecycle,
  type StatuslineLifecycleState,
  type StatuslineRegistrationPresence,
} from "../../core/statusline-lifecycle.js";
import { decodeCacheDocument, withTimeout } from "./statusline-git.js";

export const STATUSLINE_SOCKET_DEADLINE_MS = 150;
const STATUSLINE_TAIL_CACHE = "statusline-tail-cache.toon";

/** The minimum daemon reply the lifecycle wire needs after the Shared render. */
export interface StatuslineTailProbe {
  readonly lines: readonly string[];
  readonly generatedAt: string;
  readonly payloadAgeMs: number | null;
  readonly stalenessWindowMs: number;
  readonly payloadStale: boolean;
  readonly mode: "local" | "global";
  readonly projectMatch: RedskilledStatuslineProjectMatch;
}

export type StatuslineTailProbeFn = (
  args: readonly string[],
  root: string,
  deadlineMs: number,
) => Promise<StatuslineTailProbe>;

interface StatuslineTailCache {
  readonly version: 1;
  readonly lines: readonly string[];
  readonly generatedAt: string;
  readonly cachedAtMs: number;
}

export interface StatuslineTailWireDeps {
  readonly nowMs?: () => number;
  readonly deadlineMs?: number;
  readonly probe?: StatuslineTailProbeFn;
  readonly readCache?: (path: string) => string | null;
  readonly writeCache?: (path: string, text: string) => void;
}

export interface StatuslineTailResult {
  readonly state: StatuslineLifecycleState;
  readonly lines: readonly string[];
}

type ProbeOutcome =
  | { readonly kind: "answered"; readonly value: StatuslineTailProbe }
  | { readonly kind: "unreachable" }
  | { readonly kind: "connecting" };

function readCacheFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function writeCacheFile(path: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, path);
  } catch {
    // Best effort: an unwritable cache costs last-known data, never the bedrock.
  }
}

function decodeTailCache(text: string | null): StatuslineTailCache | null {
  if (text == null) return null;
  try {
    const value = decodeCacheDocument(text) as Partial<StatuslineTailCache>;
    if (
      value.version !== 1 ||
      !Array.isArray(value.lines) ||
      !value.lines.every((line) => typeof line === "string") ||
      typeof value.generatedAt !== "string" ||
      typeof value.cachedAtMs !== "number"
    ) return null;
    return value as StatuslineTailCache;
  } catch {
    return null;
  }
}

function cacheAgeMs(cache: StatuslineTailCache, nowMs: number): number {
  const generatedMs = Date.parse(cache.generatedAt);
  return nowMs - (Number.isFinite(generatedMs) ? generatedMs : cache.cachedAtMs);
}

function registrationPresence(probe: StatuslineTailProbe): StatuslineRegistrationPresence {
  if (probe.mode === "global" || probe.projectMatch === "matched") return "present";
  if (probe.projectMatch === "name-only") return "pending";
  return "absent";
}

async function productionProbe(
  args: readonly string[],
  root: string,
  deadlineMs: number,
): Promise<StatuslineTailProbe> {
  const observed = await probeStatusline(args, {
    cwd: root,
    client: { requestTimeoutMs: deadlineMs },
  });
  return {
    lines: observed.render.lines,
    generatedAt: observed.payload.generated_at,
    payloadAgeMs: observed.payload.staleness.age_ms,
    stalenessWindowMs: observed.payload.staleness.threshold_ms,
    payloadStale: observed.payload.staleness.stale,
    mode: observed.render.mode,
    projectMatch: observed.render.project_match,
  };
}

/**
 * Read and classify the daemon tail without ever spawning the daemon.
 *
 * The outer race is the prompt's wall-clock guarantee; the production probe
 * gives the socket transport the same deadline so its losing request is also
 * closed rather than left resident. A deadline miss with a cache serves that
 * tail as degraded; with no cache it states that the probe is still connecting.
 */
export async function collectStatuslineTail(
  root: string,
  args: readonly string[],
  deps: StatuslineTailWireDeps = {},
): Promise<StatuslineTailResult> {
  const nowMs = (deps.nowMs ?? Date.now)();
  const deadlineMs = deps.deadlineMs ?? STATUSLINE_SOCKET_DEADLINE_MS;
  const cachePath = join(statuslineStateDir(root), STATUSLINE_TAIL_CACHE);
  const cache = decodeTailCache((deps.readCache ?? readCacheFile)(cachePath));
  const attempt: Promise<ProbeOutcome> = (deps.probe ?? productionProbe)(args, root, deadlineMs).then(
    (value) => ({ kind: "answered" as const, value }),
    () => ({ kind: "unreachable" as const }),
  );
  const outcome = await withTimeout<ProbeOutcome>(attempt, deadlineMs, { kind: "connecting" });

  if (outcome.kind === "connecting") {
    if (cache != null) {
      return {
        state: "degraded",
        lines: lifecycleTailLines({
          state: "degraded",
          tail: cache.lines,
          cachedAgeMs: cacheAgeMs(cache, nowMs),
        }),
      };
    }
    return { state: "connecting", lines: lifecycleTailLines({ state: "connecting" }) };
  }
  if (outcome.kind === "unreachable") {
    return { state: "bedrock-only", lines: lifecycleTailLines({ state: "bedrock-only" }) };
  }

  const reply = outcome.value;
  const state = resolveStatuslineLifecycle({
    probe: "answered",
    registration: registrationPresence(reply),
    payloadAgeMs: reply.payloadAgeMs,
    stalenessWindowMs: reply.stalenessWindowMs,
    payloadStale: reply.payloadStale,
  });
  if (state === "live") {
    const value: StatuslineTailCache = {
      version: 1,
      lines: reply.lines,
      generatedAt: reply.generatedAt,
      cachedAtMs: nowMs,
    };
    (deps.writeCache ?? writeCacheFile)(cachePath, encodeDevSnapshotToon(value as never));
  }
  return {
    state,
    lines: lifecycleTailLines({ state, tail: state === "live" ? reply.lines : undefined }),
  };
}
