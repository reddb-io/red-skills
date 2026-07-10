import { encode as encodeToon } from "@reddb-io/toon";

/**
 * runtime-doctor.ts — the per-plugin runtime-distribution audit half of the
 * adoption doctor (`/dev:doctor`, issue #1034, PRD #1013). It turns the former
 * *silent no-op* class — a plugin marked `enabled: true` whose runtime bundle
 * never arrived — into visible, named findings.
 *
 * It audits the ADR 0084 control-plane contract for each plugin (dev, memory,
 * brain): the config flag says the plugin is on, so the cached bundle that the
 * launcher (`red-fetch` / `afk.mjs`, ADR 0034/0038) resolves MUST actually be
 * present, readable, checksum-valid, and current. Three failure axes:
 *
 *   1. Enabled vs runtime present — `plugins.<name>.enabled: true` but no cached
 *      bundle (`runtime-missing`), or only the inert marker a failed fetch left
 *      behind (`inert-marker`). Both are hard errors: the plugin is "on" but
 *      does nothing.
 *   2. Version drift — the cached bundle is behind the latest compatible Release
 *      (`version-drift`), stale beyond the self-update expectation (#1033). A
 *      warn: it still runs, just not the current runtime.
 *   3. Cache integrity — the cached bundle is unreadable or its bytes no longer
 *      match the published sha256 (`cache-corrupt`). A hard error.
 *
 * Pure + IO-free, exactly like {@link file://./hook-doctor.ts}: every filesystem
 * fact (cache presence, readability, checksum, versions) is INJECTED as data, so
 * the audit can be unit-tested with fixtures and can never accidentally fetch a
 * bundle or touch the network. The doctor stays read-only by default; the
 * `--fix` re-fetch each finding names is gated (`fixGate: "confirm"`) per the
 * doctor's hard-to-reverse gating — the audit itself never mutates anything.
 */

/** The three doctor verdicts, mapped to `✅` / `⚠️` / `❌` in the scorecard. */
export type RuntimeVerdict = "ok" | "warn" | "error";

/** Per-plugin scorecard verdict, including the non-finding rows. */
export type RuntimeRowVerdict = RuntimeVerdict | "skip";

/** The named finding classes, one per audited failure axis. */
export type RuntimeFindingKind =
  | "runtime-missing"
  | "inert-marker"
  | "version-drift"
  | "cache-corrupt";

/**
 * The observed state of a plugin's cached runtime bundle on disk. `present`
 * carries the version the bundle reports plus its integrity facts; `inert` is
 * the marker a failed fetch left behind; `absent` is neither a bundle nor a
 * marker. All facts are injected — this module never reads the filesystem.
 */
export type CacheState =
  | {
      readonly kind: "present";
      /** Version the cached bundle carries (channel-keyed upstream). */
      readonly version: string;
      /** Whether the cached bundle file could be read. */
      readonly readable: boolean;
      /** Whether the read bytes match the published sha256 manifest. */
      readonly checksumOk: boolean;
    }
  | { readonly kind: "inert" }
  | { readonly kind: "absent" };

/** The injected facts the audit needs about one plugin. */
export interface PluginRuntimeFacts {
  /** Plugin name (`dev` | `memory` | `brain`). */
  readonly plugin: string;
  /** `plugins.<name>.enabled: true` in the nearest `.red/config.yaml`. */
  readonly enabled: boolean;
  /** Installed plugin version, from `.claude-plugin/plugin.json`. */
  readonly installedVersion: string;
  /** The cached-bundle state for this plugin's active channel. */
  readonly cache: CacheState;
  /**
   * Latest compatible Release version, if it could be resolved. Absent (the
   * offline / rate-limited case) suppresses the drift check — never a false
   * positive when we simply could not ask.
   */
  readonly latestVersion?: string;
}

/** A single named finding for an unhealthy plugin runtime. */
export interface RuntimeFinding {
  readonly plugin: string;
  readonly kind: RuntimeFindingKind;
  readonly verdict: RuntimeVerdict;
  /** One-line evidence for the scorecard. */
  readonly reason: string;
  /** The launcher-owned remediation (never a hand edit of a fetched asset). */
  readonly remediation: string;
  /**
   * How `--fix` must gate this finding. A re-fetch hits the network and rewrites
   * the cache, so it is `confirm` (hard-to-reverse) — never a safe batch.
   */
  readonly fixGate: "confirm";
}

/** One row of the per-plugin scorecard (green + skip rows included). */
export interface RuntimeRow {
  readonly plugin: string;
  readonly enabled: boolean;
  /** A short human-readable state token for the scorecard cell. */
  readonly state: string;
  readonly verdict: RuntimeRowVerdict;
}

export interface RuntimeReport {
  /** One finding per unhealthy, enabled plugin (empty when all healthy). */
  readonly findings: RuntimeFinding[];
  /** Per-plugin scorecard rows, in input order. */
  readonly rows: RuntimeRow[];
}

/** The launcher fetch a `--fix` re-trigger names; one home for every finding. */
const REFETCH_HINT =
  "re-trigger the launcher fetch (red-fetch.mjs <plugin> <version>) or rebuild locally";

/**
 * Compare two dotted numeric versions (`1.261.1`). Returns <0 / 0 / >0 like a
 * comparator. Non-numeric or ragged segments compare by their numeric prefix;
 * a missing segment counts as 0 so `1.2` < `1.2.1`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

/**
 * Audit one plugin's runtime distribution against the control-plane contract.
 *
 * Resolution order is deliberate — a disabled plugin is inert BY DESIGN (the
 * ADR 0067 gate), so it never produces a finding whatever its cache looks like.
 * For an enabled plugin the hard errors (missing / inert / corrupt) are reported
 * before the soft drift warn, and corrupt outranks drift when both hold (you
 * cannot trust the version of a bundle whose bytes are wrong).
 */
export function auditPluginRuntime(f: PluginRuntimeFacts): {
  verdict: RuntimeRowVerdict;
  finding?: RuntimeFinding;
  row: RuntimeRow;
} {
  const mk = (
    verdict: RuntimeRowVerdict,
    state: string,
    finding?: RuntimeFinding,
  ): { verdict: RuntimeRowVerdict; finding?: RuntimeFinding; row: RuntimeRow } => ({
    verdict,
    finding,
    row: { plugin: f.plugin, enabled: f.enabled, state, verdict },
  });

  // Disabled → inert by design (ADR 0067). Never a finding.
  if (!f.enabled) return mk("skip", "disabled");

  const finding = (
    kind: RuntimeFindingKind,
    verdict: RuntimeVerdict,
    reason: string,
    remediation: string,
  ): RuntimeFinding => ({ plugin: f.plugin, kind, verdict, reason, remediation, fixGate: "confirm" });

  // 1a. Enabled but no cached bundle at all.
  if (f.cache.kind === "absent") {
    return mk(
      "error",
      "missing",
      finding(
        "runtime-missing",
        "error",
        `enabled but runtime missing — no cached bundle for ${f.plugin}@${f.installedVersion}`,
        REFETCH_HINT,
      ),
    );
  }

  // 1b. Only the inert marker a failed fetch left behind.
  if (f.cache.kind === "inert") {
    return mk(
      "error",
      "inert",
      finding(
        "inert-marker",
        "error",
        `enabled but runtime inert — a failed fetch left an inert marker for ${f.plugin}`,
        REFETCH_HINT,
      ),
    );
  }

  // 3. Cache integrity — unreadable or checksum mismatch. Outranks drift: a
  // bundle whose bytes are wrong has no version you can trust.
  if (!f.cache.readable) {
    return mk(
      "error",
      "corrupt",
      finding(
        "cache-corrupt",
        "error",
        `cached ${f.plugin} bundle is unreadable`,
        REFETCH_HINT,
      ),
    );
  }
  if (!f.cache.checksumOk) {
    return mk(
      "error",
      "corrupt",
      finding(
        "cache-corrupt",
        "error",
        `cached ${f.plugin} bundle failed checksum verification (corrupt)`,
        REFETCH_HINT,
      ),
    );
  }

  // 2. Version drift — behind the latest compatible Release. Suppressed when the
  // latest could not be resolved (no false positive on an offline probe).
  if (f.latestVersion !== undefined && compareVersions(f.cache.version, f.latestVersion) < 0) {
    return mk(
      "warn",
      "stale",
      finding(
        "version-drift",
        "warn",
        `cached ${f.plugin} bundle ${f.cache.version} is behind latest release ${f.latestVersion}`,
        REFETCH_HINT,
      ),
    );
  }

  return mk("ok", "ready");
}

/** Audit every plugin and aggregate the findings + the per-plugin scorecard. */
export function auditRuntimes(facts: readonly PluginRuntimeFacts[]): RuntimeReport {
  const findings: RuntimeFinding[] = [];
  const rows: RuntimeRow[] = [];
  for (const f of facts) {
    const { finding, row } = auditPluginRuntime(f);
    rows.push(row);
    if (finding) findings.push(finding);
  }
  return { findings, rows };
}

/**
 * Render the runtime report as TOON — the repo mandate for AI-facing CLI output
 * (ADR #910 / #928). Two uniform tables: the per-plugin scorecard and the
 * findings list. Empty findings still render as `findings[0]:` (visible zero).
 */
export function renderRuntimeReportToon(report: RuntimeReport): string {
  return encodeToon({
    plugins: report.rows.map((r) => ({
      plugin: r.plugin,
      enabled: r.enabled,
      state: r.state,
      verdict: r.verdict,
    })),
    findings: report.findings.map((f) => ({
      plugin: f.plugin,
      kind: f.kind,
      verdict: f.verdict,
    })),
  });
}
