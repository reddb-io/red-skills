import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { encode as encodeToon } from "@reddb-io/toon";
import { afkPaths, collectPrecheckFacts, resolveRepoContext } from "../runtime/wire.js";
import { editBody, listCandidates, listIssueStates, listLabelNames, postClaimComment, type GhContext } from "../runtime/gh.js";
import { applyTmpJanitorReport, collectTmpJanitorReport, type TmpJanitorApplyResult, type TmpJanitorReport } from "../runtime/tmp-janitor.js";
import { branchLockPath, clearBranchLock, writeBranchLock } from "../runtime/lock.js";
import {
  applyOperationalProbeFixes,
  runOperationalProbes,
  terminateSupervisorPid,
  type OperationalProbeFixResult,
  type OperationalProbeReport,
} from "../core/operational-probes.js";
import { auditCastleStateLane, type CastleStateDoctorReport } from "../core/castle-state-doctor.js";
import {
  applyHostToolchainFixes,
  auditHostToolchain,
  ghUpgradeRecipe,
  tqInstallRecipe,
  type HostToolchainFixReceipt,
  type HostToolchainReport,
} from "../core/host-toolchain-doctor.js";
import {
  auditRedskilledProvisioning,
  readRedskilledProvisionFacts,
  REDSKILLED_PROVISION_FIX,
  type RedskilledProvisionReport,
} from "@reddb-io/redskilled/provision";
import { getConfig, loadConfig } from "../core/config.js";
import { auditExecutableAcceptanceCriteria, type ExecutableAcceptanceDoctorReport } from "../core/executable-acceptance-doctor.js";
import {
  applyHitlTypeDeclarationFix,
  auditHitlTypeDeclaration,
  type HitlTypeDeclarationFixReceipt,
  type HitlTypeDeclarationReport,
} from "../core/hitl-type-declaration-doctor.js";
import {
  collectDoctorClassifierReports,
  type DoctorClassifierReports,
} from "../runtime/doctor-classifiers.js";
import {
  applyMarketplaceSourceFixes,
  RED_SKILLS_MARKETPLACE_REPO,
  type MarketplaceSourceFixReceipt,
  type MarketplaceSourceVerdict,
} from "../core/marketplace-source-doctor.js";
import {
  MCP_SESSION_FLAG,
  parseSessionMcpServers,
  type McpLoadVerdict,
} from "../core/mcp-load-doctor.js";
import { collectDeadendAuditReport } from "../runtime/deadend-audit-report.js";
import { emptyDeadendReport, type DeadendAuditReport } from "../core/deadend-audit.js";
import { LABEL_READY } from "../core/triage-labels.js";
import { fastForwardLocalTarget } from "../core/merge.js";
import { execTool } from "../runtime/exec.js";
import * as gitx from "../runtime/git.js";
import { createRedskilledBirthPort } from "../runtime/redskilled-birth.js";

interface RegistrationLivenessReport {
  readonly verdict: "ok" | "error" | "unknown";
  readonly ready: number;
  readonly lapsedAt: string;
  readonly reason: string;
}

async function collectRegistrationLiveness(
  root: string,
  ready: number,
): Promise<RegistrationLivenessReport> {
  try {
    const state = await createRedskilledBirthPort({ root }).registrationState();
    if (state.held == null && state.lapse != null && ready > 0) {
      return {
        verdict: "error",
        ready,
        lapsedAt: state.lapse.at,
        reason: state.lapse.detail,
      };
    }
    return { verdict: "ok", ready, lapsedAt: "", reason: "" };
  } catch (error) {
    return {
      verdict: "unknown",
      ready,
      lapsedAt: "",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

interface RedDoctorFlags {
  fix: boolean;
  json: boolean;
  yes: boolean;
  root: string;
  /** Check 27's session half; `null` when the caller stated nothing. */
  sessionMcpServers: readonly string[] | null;
}

function parseFlags(args: readonly string[], cwd: string): RedDoctorFlags {
  const flags: RedDoctorFlags = {
    fix: false,
    json: false,
    yes: false,
    root: cwd,
    sessionMcpServers: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--fix") {
      flags.fix = true;
      continue;
    }
    // The honest seam for check 27: this process cannot introspect its host's
    // loaded MCP servers, so the invoking agent states them. An empty value is
    // a statement ("I see none"), not an omission — hence the `undefined` test
    // rather than a falsy one.
    if (arg === MCP_SESSION_FLAG) {
      const value = args[++i];
      if (value === undefined) throw new Error(`${MCP_SESSION_FLAG} requires a value`);
      flags.sessionMcpServers = parseSessionMcpServers(value);
      continue;
    }
    if (arg.startsWith(`${MCP_SESSION_FLAG}=`)) {
      flags.sessionMcpServers = parseSessionMcpServers(arg.slice(MCP_SESSION_FLAG.length + 1));
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--root") {
      const value = args[++i];
      if (!value) throw new Error("--root requires a value");
      flags.root = value;
      continue;
    }
    if (arg.startsWith("--root=")) {
      flags.root = arg.slice("--root=".length);
      continue;
    }
    throw new Error(`unknown red-doctor argument: ${arg}`);
  }
  return flags;
}

function rel(root: string, path: string): string {
  const out = relative(root, path);
  return out === "" ? "." : out;
}

function flattenExpired(report: TmpJanitorReport): string[] {
  return [
    ...report.plan.scratch.reclaim,
    ...report.plan.diagnostics.reclaim,
    ...report.plan.feedbackWorktrees.reclaim,
  ].map((entry) => entry.path);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function collectHostToolchainReport(root: string): Promise<HostToolchainReport> {
  const [gh, tq, ghPathResult, repoToolVersions, userToolVersions] = await Promise.all([
    execTool("gh", ["--version"], { cwd: root }),
    execTool("tq", ["--version"], { cwd: root }),
    execTool("sh", ["-c", "command -v gh"], { cwd: root }),
    readOptional(join(root, ".tool-versions")),
    readOptional(join(homedir(), ".tool-versions")),
  ]);
  const ghPath = ghPathResult.code === 0 ? ghPathResult.stdout.trim() : undefined;
  const [apt, brew] = ghPath
    ? await Promise.all([
        execTool("dpkg-query", ["-S", ghPath], { cwd: root }),
        execTool("brew", ["--prefix", "gh"], { cwd: root }),
      ])
    : [{ code: 1 }, { code: 1 }];
  const config = loadConfig(join(root, ".red", "config.yaml"), {
    ignoreActivationGate: true,
    warn: () => undefined,
  });

  return auditHostToolchain({
    ghOutput: gh.code === 0 ? gh.stdout : undefined,
    tqOutput: tq.code === 0 ? tq.stdout : undefined,
    ghPath,
    toolVersions: [repoToolVersions, userToolVersions].filter(Boolean).join("\n"),
    aptManaged: apt.code === 0,
    brewManaged: brew.code === 0,
    tqRecordedVersion: getConfig(config, "host_binaries.tq.version") || undefined,
  });
}

/**
 * Whether this host has a daemon at all — read-only, and never spawning one.
 *
 * A collection failure degrades to a named `missing` row rather than to a failed
 * doctor: a machine with no daemon is the very state this check exists to
 * report, so the report must survive reading it.
 */
async function collectRedskilledProvisionReport(root: string): Promise<RedskilledProvisionReport> {
  try {
    // The repository is handed in because an absent home is two states, not one:
    // this project's declared workspace target is what decides whether the
    // absence is a defect or the ordinary shape of a `local` machine (#2958).
    return auditRedskilledProvisioning(await readRedskilledProvisionFacts({ projectRoot: root }));
  } catch (error) {
    const evidence = error instanceof Error ? error.message : String(error);
    return {
      verdict: "missing",
      rows: [{ check: "home", verdict: "missing", evidence, fix: REDSKILLED_PROVISION_FIX }],
      findings: [{ check: "home", verdict: "missing", evidence, fix: REDSKILLED_PROVISION_FIX }],
    };
  }
}

const MARKETPLACE_VERDICT_ICON: Record<MarketplaceSourceVerdict, string> = {
  ok: "✅",
  warn: "⚠️",
  error: "❌",
};

const MCP_LOAD_VERDICT_ICON: Record<McpLoadVerdict, string> = {
  ok: "✅",
  warn: "⚠️",
  error: "❌",
};

/**
 * The scorecard sections for the checks whose classifiers live under `core/` and
 * are injected-facts-only (checks 12, 13, 15, 17, 18, 19, 21, 26, 27). Rendered from one
 * collected report so a check that could not gather its facts prints a named
 * note instead of a silently clean section.
 */
function renderClassifierSections(
  classifiers: DoctorClassifierReports,
  marketplaceFixes: readonly MarketplaceSourceFixReceipt[] = [],
): string[] {
  const {
    worktreeSetup,
    feedbackAuthority,
    validationMoments,
    hooks,
    hookPoints,
    runtime,
    runtimeUnresolved,
    hostBinaries,
    marketplaceSources,
    pluginVersion,
    warmPath,
    mcpLoad,
    dependencyEdges,
    dependencyEdgesUnread,
    askRedRouter,
    redTaxonomy,
    unlandedDocs,
    setupOwnedDirt,
    notes,
  } = classifiers;
  return [
    "",
    "red-doctor AFK worktree setup declaration",
    `verdict: ${worktreeSetup.verdict}`,
    ...worktreeSetup.findings.map(
      (finding) =>
        `  ${finding.verdict} ${finding.command ?? "(undeclared)"}: ${finding.reason}`,
    ),
    "",
    "red-doctor AFK feedback command authority",
    `declared: ${feedbackAuthority.declared}`,
    `verdict: ${feedbackAuthority.verdict}`,
    `commands: ${feedbackAuthority.commands.length}`,
    `required checks: ${feedbackAuthority.requiredChecks?.join(",") || "none/unavailable"}`,
    ...feedbackAuthority.findings.map(
      (finding) => `  ${finding.verdict} ${finding.kind}: ${finding.reason}`,
    ),
    ...feedbackAuthority.findings.map((finding) => `  fix: ${finding.remediation}`),
    "",
    "red-doctor Validation declaration vs engine",
    `verdict: ${validationMoments.verdict}`,
    `findings: ${validationMoments.findings.length}`,
    ...validationMoments.findings.map(
      (finding) => `  ${finding.kind} ${finding.moment}: ${finding.reason}`,
    ),
    ...validationMoments.findings.map((finding) => `  fix: ${finding.remediation}`),
    "",
    "red-doctor AFK hook / backpressure static validation",
    `declared hook points: ${hookPoints.length}`,
    ...hookPoints.map((point) => `  ${point.hook} exit=${point.exit} commands=${point.commands}`),
    `backpressure commands: ${hooks.backpressure.length}`,
    ...hooks.backpressure.map((finding) => `  ${finding.verdict} ${finding.command}: ${finding.reason}`),
    `hook commands: ${hooks.hooks.length}`,
    ...hooks.hooks.map((entry) => `  ${entry.finding.verdict} ${entry.hook} ${entry.finding.command}: ${entry.finding.reason}`),
    `unknown hook names: ${hooks.unknownHooks.length}`,
    ...hooks.unknownHooks.map((name) => `  unknown hook name '${name}'`),
    "",
    "red-doctor per-plugin runtime distribution",
    ...runtime.rows.map((row) => `  ${row.verdict} ${row.plugin} enabled=${row.enabled} state=${row.state}`),
    `runtime findings: ${runtime.findings.length}`,
    ...runtime.findings.map((finding) => `  ${finding.verdict} ${finding.plugin} ${finding.kind}: ${finding.reason}`),
    ...runtime.findings.map((finding) => `  fix: ${finding.remediation}`),
    ...(runtimeUnresolved.length > 0 ? [`unaudited plugins: ${runtimeUnresolved.join(" ")}`] : []),
    "",
    "red-doctor required host binaries",
    ...hostBinaries.rows.map(
      (row) => `  ${row.verdict === "ok" ? "✅" : "❌"} ${row.binary} catalog=${row.catalog} config=${row.recorded} observed=${row.observed}`,
    ),
    `host binary findings: ${hostBinaries.findings.length}`,
    ...hostBinaries.findings.map((finding) => `  ${finding.kind}: ${finding.reason}`),
    ...hostBinaries.findings.map((finding) => `  fix: ${finding.remediation}`),
    "",
    "red-doctor plugin version",
    `  installed=${pluginVersion.installed ?? "none"} published=${pluginVersion.published ?? "unknown"} → ${pluginVersion.verdict}`,
    ...(pluginVersion.verdict === "current" ? [] : [`  ${pluginVersion.detail}`]),
    ...(pluginVersion.fix == null ? [] : [`  fix: ${pluginVersion.fix}`]),
    "",
    "red-doctor warm path (the fetcher that runs on this host)",
    `  fetcher=${warmPath.fetcherVersion ?? "none"} unwarmed=${warmPath.unwarmed.join(",") || "none"} → ${warmPath.verdict}`,
    ...(warmPath.verdict === "complete" ? [] : [`  ${warmPath.detail}`]),
    ...(warmPath.fix == null ? [] : [`  fix: ${warmPath.fix}`]),
    "red-doctor marketplace registration source",
    ...marketplaceSources.rows.map(
      (row) => `  ${MARKETPLACE_VERDICT_ICON[row.verdict]} ${row.host} ${row.marketplace} source=${row.source} (${row.detail})`,
    ),
    `marketplace findings: ${marketplaceSources.findings.length}`,
    ...marketplaceSources.findings.map((finding) => `  ${finding.kind}: ${finding.reason}`),
    ...marketplaceSources.findings.map((finding) => `  fix: ${finding.remediation}`),
    ...marketplaceFixes.map((fix) => `  fix ${fix.host}: ${fix.status} (${fix.reason})`),
    "",
    "red-doctor declared MCP servers loaded in this session",
    ...mcpLoad.rows.map(
      (row) =>
        `  ${MCP_LOAD_VERDICT_ICON[row.verdict]} ${row.plugin} declared=${row.declared.join(",") || "—"} ` +
        `loaded=${row.loaded.join(",") || "—"} missing=${row.missing.join(",") || "—"}`,
    ),
    `mcp load findings: ${mcpLoad.findings.length}`,
    ...mcpLoad.findings.map((finding) => `  ${finding.verdict} ${finding.kind}: ${finding.reason}`),
    ...mcpLoad.findings.map((finding) => `  fix: ${finding.remediation}`),
    "",
    "red-doctor native blocked-by vs req:N divergence",
    `tickets compared: ${dependencyEdges.rows.length}`,
    `dependency edge findings: ${dependencyEdges.findings.length}`,
    ...dependencyEdges.findings.map((finding) => `  ${finding.verdict} ${finding.kind}: ${finding.reason}`),
    ...dependencyEdges.findings.map((finding) => `  fix: ${finding.remediation}`),
    // Never a silent cap: a compare that skipped Tickets says which ones.
    `tickets unread: ${dependencyEdgesUnread.length}`,
    ...(dependencyEdgesUnread.length > 0 ? [`  unread: ${dependencyEdgesUnread.join(" ")}`] : []),
    "",
    "red-doctor ask-red router coverage sync",
    `router-covered skills: ${askRedRouter.rows.filter((row) => row.inRouter).length}`,
    `router findings: ${askRedRouter.findings.length}`,
    ...askRedRouter.findings.map((finding) => `  ${finding.verdict} ${finding.kind}: ${finding.reason}`),
    ...askRedRouter.findings.map((finding) => `  fix: ${finding.remediation}`),
    "",
    "red-doctor .red lifecycle taxonomy",
    `taxonomy findings: ${redTaxonomy.findings.length}`,
    ...redTaxonomy.findings.map((finding) => `  ${finding.verdict} ${finding.kind} ${finding.path}: ${finding.reason}`),
    ...redTaxonomy.findings.map((finding) => `  target: ${finding.target}`),
    "",
    "red-doctor unlanded .red docs",
    `verdict: ${unlandedDocs.row.verdict}`,
    `evidence: ${unlandedDocs.row.evidence}`,
    `unlanded docs findings: ${unlandedDocs.findings.length}`,
    ...unlandedDocs.findings.map((finding) => `  ${finding.verdict} ${finding.kind}: ${finding.reason}`),
    ...unlandedDocs.findings.map((finding) => `  fix: ${finding.remediation}`),
    "",
    "red-doctor uncommitted /red-setup output",
    `verdict: ${setupOwnedDirt.row.verdict}`,
    `evidence: ${setupOwnedDirt.row.evidence}`,
    `setup-owned dirt findings: ${setupOwnedDirt.findings.length}`,
    ...setupOwnedDirt.findings.map((finding) => `  ${finding.verdict} ${finding.kind}: ${finding.reason}`),
    ...setupOwnedDirt.findings.map((finding) => `  paths: ${finding.paths.join(" ")}`),
    ...setupOwnedDirt.findings.map((finding) => `  fix: ${finding.remediation}`),
    ...(notes.length > 0
      ? ["", "red-doctor classifier notes", ...notes.map((note) => `  ${note}`)]
      : []),
  ];
}

function renderHuman(
  root: string,
  probeReport: OperationalProbeReport,
  castleReport: CastleStateDoctorReport,
  executableAcceptanceReport: ExecutableAcceptanceDoctorReport,
  report: TmpJanitorReport,
  hostReport: HostToolchainReport,
  deadendReport: DeadendAuditReport,
  redskilledReport: RedskilledProvisionReport,
  registrationLiveness: RegistrationLivenessReport,
  hitlTypeReport: HitlTypeDeclarationReport,
  classifiers: DoctorClassifierReports,
  applied?: TmpJanitorApplyResult,
  probeFixes: readonly OperationalProbeFixResult[] = [],
  hostFixes: readonly HostToolchainFixReceipt[] = [],
  hitlTypeFix?: HitlTypeDeclarationFixReceipt,
  marketplaceFixes: readonly MarketplaceSourceFixReceipt[] = [],
): string {
  const expired = flattenExpired(report).map((path) => rel(root, path));
  const workers = report.staleWorkers.reclaim.map((entry) => rel(root, entry.path));
  const unknown = report.plan.unknownTmpRoots.map((name) => `.red/tmp/${name}`);
  const reclaimPlan = report.workerReclaim;
  const lines = [
    "red-doctor host toolchain",
    ...hostReport.rows.map((row) => `  ${row.verdict === "ok" ? "✅" : "❌"} ${row.tool} ${row.version} (required ${row.required}; manager ${row.manager})`),
    ...hostReport.findings.map((finding) => `  ${finding.reason}`),
    ...hostReport.findings.map((finding) => `  fix: ${finding.remediation}`),
    ...hostFixes.map((fix) => `  fix ${fix.tool}: ${fix.status} (${fix.reason})`),
    "",
    "red-doctor operational probes",
    `probes: ${probeReport.probes.length}`,
    ...probeReport.probes.map((probe) => `  ${probe.verdict} ${probe.name}`),
    `red probes: ${probeReport.findings.length}`,
    ...probeReport.findings.map((finding) => `  ${finding.name}: ${finding.evidence}`),
    ...probeReport.findings.map((finding) => `  fix: ${finding.canonicalFix}`),
    ...probeFixes.map((fix) => `  fix ${fix.probeId}: ${fix.status} (${fix.evidence})`),
    "",
    "red-doctor castle state lane",
    `castle lane: ${castleReport.checked.castleLanePresent ? "present" : "absent"}`,
    `legacy afk lane: ${castleReport.checked.legacyLanePresent ? "present" : "absent"}`,
    `castle findings: ${castleReport.findings.length}`,
    ...castleReport.findings.map((finding) => `  ${finding.verdict} ${finding.kind}: ${finding.path} — ${finding.reason}`),
    ...castleReport.findings.map((finding) => `  fix: ${finding.canonicalFix}`),
    "",
    "red-doctor executable acceptance criteria",
    `candidates: ${executableAcceptanceReport.checked.candidates}`,
    `verdict: ${executableAcceptanceReport.row.verdict}`,
    `evidence: ${executableAcceptanceReport.row.evidence}`,
    `acceptance findings: ${executableAcceptanceReport.findings.length}`,
    ...executableAcceptanceReport.findings.map((finding) => (
      finding.issue > 0
        ? `  ${finding.verdict} #${finding.issue}: ${finding.reason}`
        : `  ${finding.verdict}: ${finding.reason}`
    )),
    ...executableAcceptanceReport.findings.map((finding) => `  fix: ${finding.remediation}`),
    "",
    "red-doctor tmp janitor",
    `expired lanes: ${expired.length}`,
    ...expired.map((path) => `  ${path}`),
    `stale workers: ${workers.length}`,
    ...workers.map((path) => `  ${path}`),
    `unknown tmp roots: ${unknown.length}`,
    ...unknown.map((path) => `  ${path}`),
    // The daemon-keyed view (Spec #2772 US 46). `dropped` is printed in full: a
    // plan that quietly held artifacts back would read here as a clean sweep.
    `worker artifacts considered: ${reclaimPlan.totals.considered}`,
    `worker artifacts reclaimable: ${reclaimPlan.totals.reclaim}`,
    `worker artifacts retained: ${reclaimPlan.totals.retain}`,
    `worker artifacts dropped: ${reclaimPlan.dropped.length}${reclaimPlan.truncated ? " (truncated)" : ""}`,
    ...reclaimPlan.dropped.map(
      (drop) => `  ${drop.reason} ${drop.path ? rel(root, drop.path) : (drop.worker_id ?? "")}: ${drop.detail}`,
    ),
    "",
    "red-doctor redskilled daemon",
    `provisioning: ${redskilledReport.verdict}`,
    ...redskilledReport.rows.map((row) => `  ${row.verdict === "ok" ? "✅" : "❌"} ${row.check}: ${row.evidence}`),
    ...redskilledReport.findings.map((finding) => `  fix: ${finding.fix}`),
    "",
    "red-doctor project registration",
    ...(registrationLiveness.verdict === "error"
      ? [
          `  ❌ lapsed-with-work: lapsed at ${registrationLiveness.lapsedAt}; ${registrationLiveness.reason}`,
          `  ready-for-agent queue contains ${registrationLiveness.ready} item(s)`,
        ]
      : [
          `  ${registrationLiveness.verdict === "ok" ? "✅" : "?"} ${registrationLiveness.verdict}: ${registrationLiveness.reason || "no lapsed registration with queued work"}`,
        ]),
    "",
    "red-doctor HUMAN-ONLY type declaration",
    `installed HUMAN-ONLY type labels: ${hitlTypeReport.checked.installedTypeLabels}`,
    `declared hitl_types: ${hitlTypeReport.checked.declaredTypes}`,
    `verdict: ${hitlTypeReport.row.verdict}`,
    `evidence: ${hitlTypeReport.row.evidence}`,
    ...hitlTypeReport.findings.map((finding) => `  ${finding.verdict} ${finding.label || "(repo)"}: ${finding.reason}`),
    ...hitlTypeReport.findings.map((finding) => `  fix: ${finding.remediation}`),
    ...(hitlTypeFix ? [`  fix hitl-type-declaration: ${hitlTypeFix.status} (${hitlTypeFix.evidence})`] : []),
    "",
    "red-doctor deadend audit",
    `deadends: ${deadendReport.total}`,
    ...deadendReport.classes.flatMap((cls) =>
      cls.findings.map((finding) => `  ${finding.deadendClass} ${finding.subject} → cure: ${finding.cure} (${finding.detail})`),
    ),
    ...renderClassifierSections(classifiers, marketplaceFixes),
  ];
  if (applied) {
    lines.push(
      `applied expired lanes: ${applied.expiredLanes.length}`,
      `applied stale workers: ${applied.staleWorkers.length}`,
      `applied unknown tmp roots: ${applied.unknownTmpRoots.length}`,
      `protected live workers: ${applied.protectedLiveWorkers.length}`,
      `protected live feedback worktrees: ${applied.protectedLiveFeedback.length}`,
      `applied worker workspaces: ${applied.workerWorkspaces.length}`,
      `protected live workspaces: ${applied.protectedLiveWorkspaces.length}`,
      `refused outside tmp: ${applied.refusedOutsideTmp.length}`,
      ...applied.removals.map(
        (removal) => `  remove=${rel(root, removal.path)} liveness=${removal.livenessVerdict}`,
      ),
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderToon(
  root: string,
  probeReport: OperationalProbeReport,
  castleReport: CastleStateDoctorReport,
  executableAcceptanceReport: ExecutableAcceptanceDoctorReport,
  report: TmpJanitorReport,
  hostReport: HostToolchainReport,
  deadendReport: DeadendAuditReport,
  redskilledReport: RedskilledProvisionReport,
  registrationLiveness: RegistrationLivenessReport,
  hitlTypeReport: HitlTypeDeclarationReport,
  classifiers: DoctorClassifierReports,
  applied?: TmpJanitorApplyResult,
  probeFixes: readonly OperationalProbeFixResult[] = [],
  hostFixes: readonly HostToolchainFixReceipt[] = [],
  hitlTypeFix?: HitlTypeDeclarationFixReceipt,
  marketplaceFixes: readonly MarketplaceSourceFixReceipt[] = [],
): string {
  return encodeToon({
    hostToolchain: {
      binaries: hostReport.rows.map((row) => ({
        tool: row.tool,
        version: row.version,
        required: row.required,
        manager: row.manager,
        verdict: row.verdict,
      })),
      findings: hostReport.findings.map((finding) => ({
        tool: finding.tool,
        kind: finding.kind,
        remediation: finding.remediation,
      })),
      appliedFixes: hostFixes.map((fix) => ({
        tool: fix.tool,
        status: fix.status,
        reason: fix.reason,
      })),
    },
    probes: probeReport.probes.map((probe) => ({
      id: probe.id,
      name: probe.name,
      verdict: probe.verdict,
    })),
    findings: probeReport.findings.map((finding) => ({
      id: finding.id,
      name: finding.name,
      verdict: finding.verdict,
      fix: finding.canonicalFix,
    })),
    tmpJanitor: {
      expiredLanes: flattenExpired(report).map((path) => rel(root, path)),
      staleWorkers: report.staleWorkers.reclaim.map((entry) => rel(root, entry.path)),
      unknownTmpRoots: report.plan.unknownTmpRoots.map((name) => `.red/tmp/${name}`),
      workerReclaim: {
        ...report.workerReclaim.totals,
        truncated: report.workerReclaim.truncated,
        dropped: report.workerReclaim.dropped.map((drop) => ({
          reason: drop.reason,
          path: drop.path ? rel(root, drop.path) : "",
          detail: drop.detail,
        })),
      },
    },
    appliedFixes: probeFixes.map((fix) => ({
      probeId: fix.probeId,
      status: fix.status,
      evidence: fix.evidence,
    })),
    castleState: {
      status: castleReport.status,
      castleLanePresent: castleReport.checked.castleLanePresent,
      legacyLanePresent: castleReport.checked.legacyLanePresent,
      findings: castleReport.findings.map((finding) => ({
        path: finding.path,
        kind: finding.kind,
        verdict: finding.verdict,
        fix: finding.canonicalFix,
      })),
    },
    redskilled: {
      verdict: redskilledReport.verdict,
      checks: redskilledReport.rows.map((row) => ({
        check: row.check,
        verdict: row.verdict,
        evidence: row.evidence,
      })),
      findings: redskilledReport.findings.map((finding) => ({
        check: finding.check,
        verdict: finding.verdict,
        fix: finding.fix,
      })),
    },
    projectRegistration: {
      verdict: registrationLiveness.verdict,
      ready: registrationLiveness.ready,
      lapsedAt: registrationLiveness.lapsedAt,
      reason: registrationLiveness.reason,
    },
    hitlTypeDeclaration: {
      scorecard: {
        check: hitlTypeReport.row.check,
        verdict: hitlTypeReport.row.verdict,
        evidence: hitlTypeReport.row.evidence,
        fixHome: hitlTypeReport.row.fixHome,
      },
      installedTypeLabels: hitlTypeReport.checked.installedTypeLabels,
      declaredTypes: hitlTypeReport.checked.declaredTypes,
      findings: hitlTypeReport.findings.map((finding) => ({
        label: finding.label,
        verdict: finding.verdict,
        reason: finding.reason,
        remediation: finding.remediation,
      })),
      appliedFix: hitlTypeFix ? { status: hitlTypeFix.status, evidence: hitlTypeFix.evidence } : null,
    },
    deadendAudit: {
      total: deadendReport.total,
      classes: deadendReport.classes.map((cls) => ({
        deadendClass: cls.deadendClass,
        cure: cls.cure,
        count: cls.count,
        findings: cls.findings.map((finding) => ({
          subject: finding.subject,
          cure: finding.cure,
          detail: finding.detail,
        })),
      })),
    },
    executableAcceptance: {
      scorecard: {
        check: executableAcceptanceReport.row.check,
        verdict: executableAcceptanceReport.row.verdict,
        evidence: executableAcceptanceReport.row.evidence,
        fixHome: executableAcceptanceReport.row.fixHome,
      },
      candidates: executableAcceptanceReport.checked.candidates,
      findings: executableAcceptanceReport.findings.map((finding) => ({
        issue: finding.issue,
        verdict: finding.verdict,
        reason: finding.reason,
        remediation: finding.remediation,
      })),
    },
    afkHooks: {
      points: classifiers.hookPoints.map((point) => ({
        hook: point.hook,
        exit: point.exit,
        commands: point.commands,
      })),
      backpressure: classifiers.hooks.backpressure.map((finding) => ({
        command: finding.command,
        verdict: finding.verdict,
        reason: finding.reason,
      })),
      hookCommands: classifiers.hooks.hooks.map((entry) => ({
        hook: entry.hook,
        command: entry.finding.command,
        verdict: entry.finding.verdict,
        reason: entry.finding.reason,
      })),
      unknownHooks: classifiers.hooks.unknownHooks,
    },
    afkWorktreeSetup: {
      verdict: classifiers.worktreeSetup.verdict,
      findings: classifiers.worktreeSetup.findings.map((finding) => ({
        command: finding.command ?? "",
        verdict: finding.verdict,
        reason: finding.reason,
      })),
    },
    afkFeedbackAuthority: {
      declared: classifiers.feedbackAuthority.declared,
      verdict: classifiers.feedbackAuthority.verdict,
      commands: [...classifiers.feedbackAuthority.commands],
      requiredChecks: classifiers.feedbackAuthority.requiredChecks === null
        ? null
        : [...classifiers.feedbackAuthority.requiredChecks],
      findings: classifiers.feedbackAuthority.findings.map((finding) => ({
        kind: finding.kind,
        verdict: finding.verdict,
        reason: finding.reason,
        remediation: finding.remediation,
      })),
    },
    validationMoments: {
      verdict: classifiers.validationMoments.verdict,
      findings: classifiers.validationMoments.findings.map((finding) => ({
        kind: finding.kind,
        moment: finding.moment,
        reason: finding.reason,
        remediation: finding.remediation,
      })),
    },
    pluginRuntime: {
      plugins: classifiers.runtime.rows.map((row) => ({
        plugin: row.plugin,
        enabled: row.enabled,
        state: row.state,
        verdict: row.verdict,
      })),
      findings: classifiers.runtime.findings.map((finding) => ({
        plugin: finding.plugin,
        kind: finding.kind,
        verdict: finding.verdict,
        remediation: finding.remediation,
      })),
      unaudited: classifiers.runtimeUnresolved,
    },
    hostBinaries: {
      binaries: classifiers.hostBinaries.rows.map((row) => ({
        binary: row.binary,
        catalog: row.catalog,
        recorded: row.recorded,
        observed: row.observed,
        verdict: row.verdict,
      })),
      findings: classifiers.hostBinaries.findings.map((finding) => ({
        binary: finding.binary,
        kind: finding.kind,
        verdict: finding.verdict,
        remediation: finding.remediation,
      })),
    },
    marketplaceSources: {
      marketplaces: classifiers.marketplaceSources.rows.map((row) => ({
        host: row.host,
        marketplace: row.marketplace,
        source: row.source,
        detail: row.detail,
        verdict: row.verdict,
      })),
      findings: classifiers.marketplaceSources.findings.map((finding) => ({
        host: finding.host,
        marketplace: finding.marketplace,
        kind: finding.kind,
        verdict: finding.verdict,
        remediation: finding.remediation,
      })),
      appliedFixes: marketplaceFixes.map((fix) => ({
        host: fix.host,
        marketplace: fix.marketplace,
        status: fix.status,
        reason: fix.reason,
      })),
    },
    mcpLoad: {
      plugins: classifiers.mcpLoad.rows.map((row) => ({
        plugin: row.plugin,
        declared: row.declared.join(" "),
        loaded: row.loaded.join(" "),
        missing: row.missing.join(" "),
        source: row.source,
        verdict: row.verdict,
      })),
      findings: classifiers.mcpLoad.findings.map((finding) => ({
        plugin: finding.plugin,
        kind: finding.kind,
        verdict: finding.verdict,
        missing: finding.missing.join(" "),
        remediation: finding.remediation,
      })),
    },
    dependencyEdges: {
      tickets: classifiers.dependencyEdges.rows.map((row) => ({
        ticket: row.ticket,
        reqLabels: row.reqLabels,
        nativeBlockedBy: row.nativeBlockedBy,
        verdict: row.verdict,
      })),
      findings: classifiers.dependencyEdges.findings.map((finding) => ({
        ticket: finding.ticket,
        blocker: finding.blocker,
        kind: finding.kind,
        verdict: finding.verdict,
      })),
      unread: classifiers.dependencyEdgesUnread,
    },
    askRedRouter: {
      skills: classifiers.askRedRouter.rows.map((row) => ({
        skill: row.skill,
        inRegisteredSet: row.inRegisteredSet,
        inRouter: row.inRouter,
        verdict: row.verdict,
      })),
      findings: classifiers.askRedRouter.findings.map((finding) => ({
        skill: finding.skill,
        kind: finding.kind,
        verdict: finding.verdict,
      })),
    },
    redTaxonomy: {
      findings: classifiers.redTaxonomy.findings.map((finding) => ({
        path: finding.path,
        kind: finding.kind,
        verdict: finding.verdict,
        target: finding.target,
      })),
    },
    unlandedDocs: {
      scorecard: {
        check: classifiers.unlandedDocs.row.check,
        verdict: classifiers.unlandedDocs.row.verdict,
        evidence: classifiers.unlandedDocs.row.evidence,
        fixHome: classifiers.unlandedDocs.row.fixHome,
      },
      findings: classifiers.unlandedDocs.findings.map((finding) => ({
        kind: finding.kind,
        verdict: finding.verdict,
        base: finding.base,
        files: finding.files,
      })),
    },
    setupOwnedDirt: {
      scorecard: {
        check: classifiers.setupOwnedDirt.row.check,
        verdict: classifiers.setupOwnedDirt.row.verdict,
        evidence: classifiers.setupOwnedDirt.row.evidence,
        fixHome: classifiers.setupOwnedDirt.row.fixHome,
      },
      findings: classifiers.setupOwnedDirt.findings.map((finding) => ({
        kind: finding.kind,
        verdict: finding.verdict,
        paths: finding.paths.join(" "),
      })),
    },
    classifierNotes: classifiers.notes,
    appliedTmpJanitor: applied
      ? {
          expiredLanes: applied.expiredLanes.map((path) => rel(root, path)),
          staleWorkers: applied.staleWorkers.map((path) => rel(root, path)),
          unknownTmpRoots: applied.unknownTmpRoots.map((path) => rel(root, path)),
          protectedLiveWorkers: applied.protectedLiveWorkers.map((path) => rel(root, path)),
          protectedLiveFeedback: applied.protectedLiveFeedback.map((path) => rel(root, path)),
          workerWorkspaces: applied.workerWorkspaces.map((path) => rel(root, path)),
          protectedLiveWorkspaces: applied.protectedLiveWorkspaces.map((path) => rel(root, path)),
          refusedOutsideTmp: applied.refusedOutsideTmp.map((path) => rel(root, path)),
          removals: applied.removals.map((removal) => ({
            path: rel(root, removal.path),
            livenessVerdict: removal.livenessVerdict,
          })),
        }
      : null,
  });
}


export async function redDoctorCommand(args: readonly string[], cwd = process.cwd()): Promise<number> {
  try {
    const flags = parseFlags(args, cwd);
    const ctx = await resolveRepoContext(flags.root);
    const paths = afkPaths(ctx.root);
    const precheckFacts = await collectPrecheckFacts(ctx, { includeNpmBundleCoherence: true });
    const probeReport = await runOperationalProbes(precheckFacts);
    const castleReport = await auditCastleStateLane(ctx.root);
    const hostReport = await collectHostToolchainReport(ctx.root);
    const executableAcceptanceTransportFailures: string[] = [];
    const executableCandidates = await listCandidates({ cwd: ctx.root, repo: ctx.repo } satisfies GhContext, LABEL_READY, {
      onTransportFailure: (failure) => executableAcceptanceTransportFailures.push(failure.message ?? "unknown transport failure"),
    });
    const executableAcceptanceReport = auditExecutableAcceptanceCriteria(executableCandidates, {
      transportFailures: executableAcceptanceTransportFailures,
    });
    const registrationLiveness = await collectRegistrationLiveness(
      ctx.root,
      executableCandidates.length,
    );
    // The label half and the `afk.labels.hitl_types` half are one protection
    // (#3013), so both are read from the same doctor pass: the tracker's real
    // labels, and the config text as written (not as folded by the loader).
    const configPath = join(ctx.root, ".red", "config.yaml");
    const configText = await readOptional(configPath);
    const trackerLabels = ctx.repo
      ? await listLabelNames({ cwd: ctx.root, repo: ctx.repo } satisfies GhContext)
      : null;
    const hitlTypeReport = auditHitlTypeDeclaration({
      installedLabels: trackerLabels && "names" in trackerLabels ? trackerLabels.names : null,
      configText: configText ?? null,
      transportFailures: trackerLabels && "failure" in trackerLabels ? [trackerLabels.failure] : [],
    });
    const issueStates = ctx.repo
      ? await listIssueStates({ cwd: ctx.root, repo: ctx.repo } satisfies GhContext)
      : new Map();
    const report = await collectTmpJanitorReport(paths.tmpDir, Math.floor(Date.now() / 1000), (issue) => {
      const state = issueStates.get(issue)?.state;
      return state === "CLOSED" ? "CLOSED" : state === "OPEN" ? "OPEN" : "UNKNOWN";
    });
    const gitCtx: gitx.GitContext = { cwd: ctx.root };
    const lockPath = branchLockPath(ctx.root);
    const probeFixes = flags.fix
      ? await applyOperationalProbeFixes(probeReport, {
          confirm: async () => flags.yes,
          setRemoteUrl: async (name, url) => gitx.setRemoteUrl(gitCtx, name, url),
          removeBranchLock: async () => clearBranchLock(lockPath),
          writeBranchLock: async (branch) => writeBranchLock(lockPath, branch),
          fastForwardLocalBase: async ({ remote, target }) =>
            fastForwardLocalTarget(gitx.mergeExec(gitCtx), { gitRepo: ctx.root, remote, target }),
          terminateSupervisor: terminateSupervisorPid,
          concedeClaim: async (issue, body) => {
            await postClaimComment({ cwd: ctx.root, repo: ctx.repo } satisfies GhContext, issue, body);
          },
          updateIssueBody: async (issue, body) => {
            await editBody({ cwd: ctx.root, repo: ctx.repo } satisfies GhContext, issue, body);
          },
          readText: async (path) => {
            try {
              return await readFile(path, "utf8");
            } catch {
              return null;
            }
          },
          writeText: async (path, text) => {
            await writeFile(path, text, "utf8");
          },
          showDiffPreview: async (_finding, diff) => {
            process.stdout.write(`diff preview:\n${diff}`);
          },
          // No relaunch is wired, and that is the fix: ADR 0130 Amendment 4
          // removed the per-project process, so a repair that "restarts the
          // fleet" has nothing to restart. The probe reports the route —
          // register through `project_start` — instead of a doctor reaching for
          // a launcher that no longer exists (#2909).
        })
      : [];
    const hostFixes = await applyHostToolchainFixes(
      hostReport,
      { fix: flags.fix, approved: flags.yes },
      {
        upgradeGhAsdf: () => execTool("sh", ["-c", ghUpgradeRecipe("asdf")], { cwd: ctx.root }),
        installTq: () => execTool("sh", ["-c", tqInstallRecipe()], { cwd: ctx.root }),
      },
    );
    // `worktreePrune` is wired so a doctor that removes a worktree's bytes also
    // drops git's registration of it — half a reclaim leaves the trap (#2866).
    const applied = flags.fix
      ? await applyTmpJanitorReport(paths.tmpDir, report, {
          worktreePrune: () => gitx.worktreePrune({ cwd: ctx.root }),
        })
      : undefined;
    // Detection only — /red-doctor consumes the same read-only deadend audit
    // the `deadend_audit` MCP tool serves; it renders findings and never mutates.
    // A gather failure degrades to an empty section, never a failed doctor.
    const deadendReport = await collectDeadendAuditReport(ctx.root).catch(() =>
      emptyDeadendReport(Date.now()),
    );
    // Read-only: the provisioning report probes the socket and never spawns the
    // daemon it is reporting on, which would answer its own question.
    const redskilledReport = await collectRedskilledProvisionReport(ctx.root);
    // The pure classifiers the SKILL.md names for checks 12, 13, 15, 17, 18, 19, 26,
    // 27 and 21. They are injected-facts-only, so the doctor is the surface that
    // reads the repo, the bundle cache and the tracker for them; before this
    // wiring existed the command imported none of them and reported clean on
    // seven dimensions it never examined (#3034).
    const classifiers = await collectDoctorClassifierReports(ctx, {
      sessionMcpServers: flags.sessionMcpServers,
    });
    // Repointing a frozen marketplace re-registers it on the host CLI, so it is
    // confirmed like every other hard-to-reverse repair. Remove-then-add is the
    // whole fix: the CLI keeps no editable source field.
    const marketplaceFixes = await applyMarketplaceSourceFixes(
      classifiers.marketplaceSources,
      { fix: flags.fix, approved: flags.yes },
      {
        repoint: async (host, marketplace) => {
          const removed = await execTool(host, ["plugin", "marketplace", "remove", marketplace], {
            cwd: ctx.root,
          });
          if (removed.code !== 0) return removed;
          return execTool(host, ["plugin", "marketplace", "add", RED_SKILLS_MARKETPLACE_REPO], {
            cwd: ctx.root,
          });
        },
      },
    );
    // The declaration merge is the one config write this doctor performs, and
    // it is gated like every other confirmed repair: preview the diff, then
    // write only with explicit approval.
    const hitlTypeFix = await applyHitlTypeDeclarationFix(
      hitlTypeReport,
      { fix: flags.fix, approved: flags.yes },
      {
        writeConfig: async (text) => {
          await writeFile(configPath, text, "utf8");
        },
        showDiffPreview: async (diff) => {
          process.stdout.write(`diff preview:\n${diff}`);
        },
      },
    );
    process.stdout.write(
      flags.json
        ? renderToon(ctx.root, probeReport, castleReport, executableAcceptanceReport, report, hostReport, deadendReport, redskilledReport, registrationLiveness, hitlTypeReport, classifiers, applied, probeFixes, hostFixes, flags.fix ? hitlTypeFix : undefined, marketplaceFixes)
        : renderHuman(ctx.root, probeReport, castleReport, executableAcceptanceReport, report, hostReport, deadendReport, redskilledReport, registrationLiveness, hitlTypeReport, classifiers, applied, probeFixes, hostFixes, flags.fix ? hitlTypeFix : undefined, marketplaceFixes),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`[red-doctor] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
