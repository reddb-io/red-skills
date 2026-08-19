import { encode as encodeToon } from "@reddb-io/toon";

/**
 * mcp-load-doctor.ts — did the plugin's declared MCP servers actually LOAD in
 * the session that is asking?
 *
 * A host CLI registers MCP servers at **plugin load**, so a plugin installed or
 * updated mid-session writes the declaration and starts no process. `.mcp.json`,
 * the manifests and the launchers are all valid on disk while the session sees
 * zero tools — a lifecycle gap that wears the exact shape of an outage, and one
 * every surface of ours used to stay silent about (#3062). The cure is one line
 * (`/reload-plugins`, or a new session); the diagnosis, without this check, is a
 * forensic investigation.
 *
 * Pure and IO-free like the other `core/` doctors: both halves are injected —
 * what the plugin DECLARES, and what the session SEES. The second half is the
 * honest seam: this classifier's caller is a CLI process that cannot introspect
 * its host's loaded servers, so the invoking agent states them with
 * `--session-mcp`, and an unstated session is reported (`session-unobserved`),
 * never assumed clean.
 */

/** The flag the invoking agent uses to state what its session actually sees. */
export const MCP_SESSION_FLAG = "--session-mcp";

/**
 * The cure, verbatim. It is one string so the doctor, the skills and the tests
 * cannot drift into three near-identical sentences.
 */
export const MCP_RELOAD_CURE =
  "restart the session, or run /reload-plugins, to load the plugin's declared MCP servers";

/** What to run when the doctor was never told what the session sees. */
export const MCP_SESSION_UNOBSERVED_FIX =
  `re-run with ${MCP_SESSION_FLAG} "<the MCP servers this session sees, or none>"`;

export type McpLoadVerdict = "ok" | "warn" | "error";

export type McpLoadFindingKind =
  /** Every declared server is missing — the mid-session install shape. */
  | "declared-unloaded"
  /** Some loaded, some did not — one server failed, not the whole load. */
  | "partially-loaded"
  /** Nobody told this doctor what the session sees. */
  | "session-unobserved";

export interface McpLoadFacts {
  readonly plugin: string;
  /** Server names from the plugin's `.mcp.json`; empty when it declares none. */
  readonly declared: readonly string[];
  /** Where the declaration was read from — the row's evidence. */
  readonly declarationSource?: string;
  /**
   * The MCP servers the invoking session sees, bare (`redskilled`) or host-prefixed
   * (`mcp__plugin_dev_rs_dev__project_status`). `null` means the doctor was not
   * told, which is a warn and never an `ok`.
   */
  readonly sessionServers: readonly string[] | null;
}

export interface McpLoadFinding {
  readonly plugin: string;
  readonly kind: McpLoadFindingKind;
  readonly verdict: Exclude<McpLoadVerdict, "ok">;
  readonly missing: string[];
  readonly reason: string;
  readonly remediation: string;
}

export interface McpLoadRow {
  readonly plugin: string;
  readonly declared: string[];
  readonly loaded: string[];
  readonly missing: string[];
  readonly source: string;
  readonly verdict: McpLoadVerdict;
}

export interface McpLoadReport {
  readonly findings: McpLoadFinding[];
  readonly rows: McpLoadRow[];
}

/**
 * Read the server out of one token the session named.
 *
 * Hosts expose a plugin's MCP tools as `mcp__<slug>__<tool>`, where the slug is
 * derived from the server name (`rs_dev` → `plugin_dev_rs_dev`). An agent
 * listing its own tools reads the prefixed form, so accepting only bare names
 * would report every loaded server as missing.
 */
export function sessionServerSlug(token: string): string {
  const trimmed = token.trim();
  const prefixed = /^mcp__(.+)$/.exec(trimmed);
  if (!prefixed) return trimmed;
  const rest = prefixed[1]!;
  const cut = rest.indexOf("__");
  return cut === -1 ? rest : rest.slice(0, cut);
}

/**
 * Parse the `--session-mcp` value. An empty value and the literal `none` are
 * the same explicit statement — "this session sees no MCP server" — which is
 * the observation the whole check turns on, so neither may read as unstated.
 */
export function parseSessionMcpServers(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Whether one declared server is among the slugs the session named. */
function serverIsLoaded(server: string, slugs: readonly string[]): boolean {
  return slugs.some(
    (slug) =>
      slug === server ||
      slug.endsWith(`_${server}`) ||
      slug.endsWith(`-${server}`) ||
      slug.endsWith(`:${server}`),
  );
}

function auditOne(facts: McpLoadFacts): { finding?: McpLoadFinding; row: McpLoadRow } {
  const { plugin } = facts;
  const declared = [...facts.declared];
  const source = facts.declarationSource ?? "—";

  // A plugin that declares no server can have none unloaded.
  if (declared.length === 0) {
    return { row: { plugin, declared, loaded: [], missing: [], source, verdict: "ok" } };
  }

  if (facts.sessionServers === null) {
    return {
      finding: {
        plugin,
        kind: "session-unobserved",
        verdict: "warn",
        missing: declared,
        reason:
          `${plugin} declares ${declared.join(", ")} in ${source} and this run was not told ` +
          "which MCP servers the session sees, so the load state is unknown",
        remediation: MCP_SESSION_UNOBSERVED_FIX,
      },
      row: { plugin, declared, loaded: [], missing: declared, source, verdict: "warn" },
    };
  }

  const slugs = facts.sessionServers.map(sessionServerSlug).filter((slug) => slug.length > 0);
  const loaded = declared.filter((server) => serverIsLoaded(server, slugs));
  const missing = declared.filter((server) => !serverIsLoaded(server, slugs));

  if (missing.length === 0) {
    return { row: { plugin, declared, loaded, missing, source, verdict: "ok" } };
  }

  const everyOne = loaded.length === 0;
  return {
    finding: {
      plugin,
      kind: everyOne ? "declared-unloaded" : "partially-loaded",
      verdict: everyOne ? "error" : "warn",
      missing,
      reason: everyOne
        ? `${plugin} declares ${declared.join(", ")} in ${source} and the session sees none of ` +
          "them — a plugin installed or updated mid-session has its declaration written and its " +
          "server processes never started"
        : `${plugin} declares ${declared.join(", ")} in ${source} and the session is missing ` +
          `${missing.join(", ")}`,
      remediation: MCP_RELOAD_CURE,
    },
    row: { plugin, declared, loaded, missing, source, verdict: everyOne ? "error" : "warn" },
  };
}

export function auditMcpLoad(facts: readonly McpLoadFacts[]): McpLoadReport {
  const findings: McpLoadFinding[] = [];
  const rows: McpLoadRow[] = [];

  for (const fact of facts) {
    const result = auditOne(fact);
    rows.push(result.row);
    if (result.finding) findings.push(result.finding);
  }

  return { findings, rows };
}

export function renderMcpLoadReportToon(report: McpLoadReport): string {
  return encodeToon({
    plugins: report.rows.map((row) => ({
      plugin: row.plugin,
      declared: row.declared.join(" "),
      loaded: row.loaded.join(" "),
      missing: row.missing.join(" "),
      source: row.source,
      verdict: row.verdict,
    })),
    findings: report.findings.map((finding) => ({
      plugin: finding.plugin,
      kind: finding.kind,
      verdict: finding.verdict,
      missing: finding.missing.join(" "),
      remediation: finding.remediation,
    })),
  });
}
