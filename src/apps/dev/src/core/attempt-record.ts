// attempt-record — the AFK→Memory "reasoning attempt" recording seam (ADR 0017).
//
// After AFK posts a TERMINAL Envelope it records the attempt into the Memory
// graph, best-effort, through the existing memory bridge/CLI (ADR 0009). This
// module owns only the PURE shape + the PURE mapping from the AFK-side attempt
// context to the bridge payload; the IO (serialise to a temp file + exec the
// bridge) lives behind the injected `recordAttempt` port wired in run.ts.
//
// The dependency is strictly one-directional (ADR 0009): `memory` hard-requires
// `dev`; `dev` only ever soft-uses `memory`. Recording therefore degrades to a
// silent no-op — the bridge itself gates on memory availability, and the port's
// implementation swallows every error so a memory failure can NEVER fail the
// AFK close.

import type { ProcessOutcome } from "./process-issue.js";

/**
 * The AFK-side fields needed to build the Memory `ReasoningAttemptPayload`
 * (src/apps/memory/src/reasoning/attempt-writer.ts). Only the fields AFK
 * actually knows at a terminal exit are carried; optional ones are omitted when
 * AFK has no value, so the Memory writer never receives an empty placeholder.
 *
 * The JSON the bridge ultimately reads matches the Memory `ReasoningAttemptPayload`
 * key names exactly (`repository`, `issueNumber`, `attemptNumber`, …) — see
 * {@link toMemoryPayload}.
 */
export interface AttemptRecordPayload {
  /** Canonical repo identifier, e.g. `reddb-io/red-skills` (gh `owner/repo`). */
  repository: string;
  /** GitHub issue number this attempt belonged to. */
  issueNumber: number;
  /** Attempt ordinal as recorded by the orchestrator (1-based). */
  attemptNumber: number;
  /** Terminal AFK outcome (done / blocked / no-sentinel / merge-conflict / …). */
  status: ProcessOutcome | string;
  /** Issue title at the time of recording. */
  issueTitle?: string;
  /** Issue URL at the time of recording. */
  issueUrl?: string;
  /** Issue body — the Memory writer scans it for an explicit parent-PRD marker. */
  issueBody?: string;
  /** AFK worker / runner identifier. */
  workerId?: string;
  /** Worker branch the attempt ran on. */
  branch?: string;
  /** Wall-clock duration of the attempt, in milliseconds. */
  durationMs?: number;
  /** Diffstat summary string from the terminal envelope. */
  diffstat?: string;
  /** Merge commit SHA when the attempt landed on the base branch. */
  mergeCommit?: string;
  /** Reference to the terminal Envelope comment, when known. */
  envelopeRef?: string;
  /** Free-form notes / why summary captured by the orchestrator. */
  notes?: string;
  /** Aggregate validation summary (the feedback sidecar, joined). */
  validationSummary?: string;
}

/** Terminal AFK outcomes the Memory writer recognises natively. The rest are
 * forwarded as their string outcome (the Memory side accepts `string`). */
const KNOWN_MEMORY_STATUS = new Set(["done", "blocked", "no-sentinel", "merge-conflict"]);

/** The AFK-side context one terminal exit carries, from which the payload is
 * built. Kept separate from {@link AttemptRecordPayload} so the call sites pass
 * raw lifecycle values and the mapping (duration→ms, status normalisation,
 * field omission) lives in one pure function. */
export interface AttemptContext {
  repo: string;
  issue: number;
  attempt: number;
  outcome: ProcessOutcome | string;
  title?: string;
  url?: string;
  body?: string;
  workerId?: string;
  branch?: string;
  /** Attempt duration in SECONDS (the lifecycle clock unit); mapped to ms. */
  durationS?: number;
  diffstat?: string;
  mergeSha?: string;
  envelopeRef?: string;
  notes?: string;
  validationSummary?: string;
}

/** Drop empty/undefined string fields so the payload never carries blank values
 * (the Memory writer treats absent and empty differently for some fields). */
function nonEmpty(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.trim();
  return t.length > 0 ? s : undefined;
}

/**
 * PURE mapping: AFK terminal context → {@link AttemptRecordPayload}. Maps the
 * outcome to the Memory status vocabulary (known outcomes pass through verbatim;
 * any other outcome forwards as its string), converts the lifecycle's SECONDS
 * duration to milliseconds, and OMITS every optional field AFK has no value for
 * so the Memory writer receives only real evidence.
 */
export function buildAttemptRecordPayload(ctx: AttemptContext): AttemptRecordPayload {
  const status = KNOWN_MEMORY_STATUS.has(ctx.outcome) ? ctx.outcome : String(ctx.outcome);
  const payload: AttemptRecordPayload = {
    repository: ctx.repo,
    issueNumber: ctx.issue,
    attemptNumber: ctx.attempt,
    status,
  };
  const title = nonEmpty(ctx.title);
  if (title !== undefined) payload.issueTitle = title;
  const url = nonEmpty(ctx.url);
  if (url !== undefined) payload.issueUrl = url;
  const body = nonEmpty(ctx.body);
  if (body !== undefined) payload.issueBody = body;
  const workerId = nonEmpty(ctx.workerId);
  if (workerId !== undefined) payload.workerId = workerId;
  const branch = nonEmpty(ctx.branch);
  if (branch !== undefined) payload.branch = branch;
  if (ctx.durationS !== undefined && Number.isFinite(ctx.durationS) && ctx.durationS >= 0) {
    payload.durationMs = Math.round(ctx.durationS * 1000);
  }
  const diffstat = nonEmpty(ctx.diffstat);
  if (diffstat !== undefined) payload.diffstat = diffstat;
  const mergeSha = nonEmpty(ctx.mergeSha);
  if (mergeSha !== undefined) payload.mergeCommit = mergeSha;
  const envelopeRef = nonEmpty(ctx.envelopeRef);
  if (envelopeRef !== undefined) payload.envelopeRef = envelopeRef;
  const notes = nonEmpty(ctx.notes);
  if (notes !== undefined) payload.notes = notes;
  const validationSummary = nonEmpty(ctx.validationSummary);
  if (validationSummary !== undefined) payload.validationSummary = validationSummary;
  return payload;
}

/**
 * Serialise an {@link AttemptRecordPayload} to the exact JSON object the Memory
 * `attempt` CLI / `ReasoningAttemptPayload` reads. The key names already match
 * one-to-one, so this is just a stable JSON.stringify — kept as a named function
 * so the wire format has a single owner and the temp-file write reads clearly.
 */
export function toMemoryPayload(payload: AttemptRecordPayload): string {
  return JSON.stringify(payload);
}

/**
 * Injected filesystem/PATH probes so {@link resolveMemoryCli} stays pure and
 * fully testable. `exists` mirrors `[[ -f path ]]` / a PATH-bin lookup;
 * `readJsonVersion` mirrors the bridge's `node -e require(manifest).version`
 * read used by the dynamic-fetch cache candidate (undefined when the manifest is
 * absent or has no version).
 */
export interface MemoryCliProbes {
  /** True iff a regular file exists at `path` (mirrors bash `[[ -f path ]]`). */
  exists: (path: string) => boolean;
  /** The `version` field of the JSON manifest at `path`, or undefined. */
  readJsonVersion?: (path: string) => string | undefined;
  /** Raw text of a file at `path`, or undefined if absent. Used by the ADR 0042
   * gate to detect a `plugins.memory` block in `.red/config.yaml`. */
  readText?: (path: string) => string | undefined;
}

/**
 * Whether `.red/config.yaml` text declares a `plugins.memory` block — the
 * ADR 0042 memory opt-in signal that replaces the legacy
 * `.red/memory/config.json` existence gate. A pure, dependency-free scan over
 * the same constrained-subset grammar `dev`'s config parser uses: find the
 * top-level `plugins:` mapping, then a `memory:` child indented exactly two
 * spaces under it. Comment/blank lines are ignored; a `memory:` key elsewhere
 * (not nested under `plugins:`) does not count.
 */
export function memoryConfiguredInYaml(text: string | undefined): boolean {
  if (!text) return false;
  let inPlugins = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = (line.match(/^ */)?.[0] ?? "").length;
    const key = line.slice(indent).replace(/:.*$/, "").trim();
    if (indent === 0) inPlugins = key === "plugins";
    else if (inPlugins && indent === 2 && key === "memory") return true;
  }
  return false;
}

/** POSIX-style path join that does not depend on node:path, so the resolver is
 * a pure function over its inputs (the only IO is the injected probes). */
function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
}

/**
 * Resolve the memory-CLI invocation as a command+args array, replicating the
 * `plugins/dev/scripts/memory-bridge.sh` gating (`memory_available` →
 * `memory_record_attempt`) and its `_memory_resolve_cli` candidate ORDER so the
 * native dev-CLI record-attempt path no longer shells out to the bridge.
 *
 * Returns `undefined` (→ silent no-op, memory not installed/opted-in) when:
 *   - Gate 1: memory is not opted in for this root — neither a `plugins.memory`
 *     block in `<gitRoot>/.red/config.yaml` (ADR 0042) nor the legacy
 *     `<gitRoot>/.red/memory/config.json` (ADR 0009 back-compat) is present, or
 *   - Gate 2: no usable CLI resolves through the candidate chain.
 *
 * Candidate order (faithful to `_memory_resolve_cli`):
 *   1. `RED_MEMORY_CLI` (absolute path to a built cli.js) → `["node", $RED_MEMORY_CLI]`.
 *      When set but the file is absent, resolution STOPS (undefined) — the host
 *      pinned an exact binary and a fallback would be wrong (bridge `return 1`).
 *   2. a `memory` bin on PATH → `["memory"]`.
 *   3. dynamic-fetch cache bundle: for each memory plugin manifest
 *      (`${CLAUDE_PLUGIN_ROOT}/../memory/.claude-plugin/plugin.json`,
 *      `${MEMORY_REPO_ROOT}/plugins/memory/.claude-plugin/plugin.json`), read its
 *      version and use `<cacheRoot>/<version>/memory-cli.mjs` when present, where
 *      cacheRoot = `<RED_MEMORY_CACHE_DIR | XDG_CACHE_HOME | $HOME/.cache>/reddb-memory`
 *      → `["node", <cache-cli>]`.
 *   4&5. built dist of a sibling/in-repo memory plugin:
 *      `${CLAUDE_PLUGIN_ROOT}/../memory/dist/cli.js`,
 *      `${MEMORY_REPO_ROOT}/plugins/memory/dist/cli.js` → `["node", <dist-cli>]`
 *      (each candidate skipped when its env var is empty, mirroring the bridge's
 *      guard against a bare `/../memory/dist/cli.js`).
 */
export function resolveMemoryCli(
  gitRoot: string,
  env: NodeJS.ProcessEnv,
  probes: MemoryCliProbes,
): string[] | undefined {
  // Gate 1 (opt-in): memory must be configured for this root. Canonical signal
  // is a `plugins.memory` block in `.red/config.yaml` (ADR 0042); the legacy
  // `.red/memory/config.json` existence is still honoured (ADR 0009 back-compat).
  const yamlText = probes.readText?.(joinPath(gitRoot, ".red", "config.yaml"));
  const optedIn =
    memoryConfiguredInYaml(yamlText) ||
    probes.exists(joinPath(gitRoot, ".red", "memory", "config.json"));
  if (!optedIn) return undefined;

  // 1. Explicit override.
  const override = env.RED_MEMORY_CLI;
  if (override !== undefined && override.length > 0) {
    return probes.exists(override) ? ["node", override] : undefined;
  }

  // 2. A `memory` bin on PATH.
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(":")) {
    if (dir.length === 0) continue;
    if (probes.exists(joinPath(dir, "memory"))) return ["memory"];
  }

  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? "";
  const repoRoot = env.MEMORY_REPO_ROOT ?? "";

  // 3. Dynamic-fetch cache bundle, version-keyed off the memory plugin manifest.
  const readVersion = probes.readJsonVersion;
  if (readVersion) {
    const manifests: string[] = [];
    if (pluginRoot.length > 0)
      manifests.push(joinPath(pluginRoot, "..", "memory", ".claude-plugin", "plugin.json"));
    if (repoRoot.length > 0)
      manifests.push(joinPath(repoRoot, "plugins", "memory", ".claude-plugin", "plugin.json"));
    const cacheBase =
      env.RED_MEMORY_CACHE_DIR ?? env.XDG_CACHE_HOME ?? joinPath(env.HOME ?? "", ".cache");
    for (const manifest of manifests) {
      if (!probes.exists(manifest)) continue;
      const version = readVersion(manifest);
      if (!version) continue;
      const cacheCli = joinPath(cacheBase, "reddb-memory", version, "memory-cli.mjs");
      if (probes.exists(cacheCli)) return ["node", cacheCli];
    }
  }

  // 4 & 5. Built dist of a sibling / in-repo memory plugin.
  const distCandidates: string[] = [];
  if (pluginRoot.length > 0) distCandidates.push(joinPath(pluginRoot, "..", "memory", "dist", "cli.js"));
  if (repoRoot.length > 0) distCandidates.push(joinPath(repoRoot, "plugins", "memory", "dist", "cli.js"));
  for (const cand of distCandidates) {
    if (probes.exists(cand)) return ["node", cand];
  }

  return undefined;
}
