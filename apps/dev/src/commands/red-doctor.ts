import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { Writable } from "node:stream";
import { encode as encodeToon } from "@reddb-io/toon";
import { afkPaths, collectPrecheckFacts, resolveRepoContext } from "../runtime/wire.js";
import { editBody, listCandidates, listIssueStates, postClaimComment, type GhContext } from "../runtime/gh.js";
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
import { getConfig, loadConfig } from "../core/config.js";
import { auditExecutableAcceptanceCriteria, type ExecutableAcceptanceDoctorReport } from "../core/executable-acceptance-doctor.js";
import { LABEL_READY } from "../core/triage-labels.js";
import { fastForwardLocalTarget } from "../core/merge.js";
import { execTool } from "../runtime/exec.js";
import * as gitx from "../runtime/git.js";
import { launchFleet } from "./fleet.js";

interface RedDoctorFlags {
  fix: boolean;
  json: boolean;
  yes: boolean;
  root: string;
}

function parseFlags(args: readonly string[], cwd: string): RedDoctorFlags {
  const flags: RedDoctorFlags = { fix: false, json: false, yes: false, root: cwd };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--fix") {
      flags.fix = true;
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
    ...report.plan.logs.reclaim,
    ...report.plan.scratch.reclaim,
    ...report.plan.diagnostics.reclaim,
    ...report.plan.feedbackWorktrees.reclaim,
    ...report.plan.legacySlotLogs.reclaim,
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

function renderHuman(
  root: string,
  probeReport: OperationalProbeReport,
  castleReport: CastleStateDoctorReport,
  executableAcceptanceReport: ExecutableAcceptanceDoctorReport,
  report: TmpJanitorReport,
  hostReport: HostToolchainReport,
  applied?: TmpJanitorApplyResult,
  probeFixes: readonly OperationalProbeFixResult[] = [],
  hostFixes: readonly HostToolchainFixReceipt[] = [],
): string {
  const expired = flattenExpired(report).map((path) => rel(root, path));
  const workers = report.staleWorkers.reclaim.map((entry) => rel(root, entry.path));
  const unknown = report.plan.unknownTmpRoots.map((name) => `.red/tmp/${name}`);
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
  ];
  if (applied) {
    lines.push(
      `applied expired lanes: ${applied.expiredLanes.length}`,
      `applied stale workers: ${applied.staleWorkers.length}`,
      `applied unknown tmp roots: ${applied.unknownTmpRoots.length}`,
      `protected live workers: ${applied.protectedLiveWorkers.length}`,
      `protected live feedback worktrees: ${applied.protectedLiveFeedback.length}`,
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
  applied?: TmpJanitorApplyResult,
  probeFixes: readonly OperationalProbeFixResult[] = [],
  hostFixes: readonly HostToolchainFixReceipt[] = [],
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
    appliedTmpJanitor: applied
      ? {
          expiredLanes: applied.expiredLanes.map((path) => rel(root, path)),
          staleWorkers: applied.staleWorkers.map((path) => rel(root, path)),
          unknownTmpRoots: applied.unknownTmpRoots.map((path) => rel(root, path)),
          protectedLiveWorkers: applied.protectedLiveWorkers.map((path) => rel(root, path)),
          protectedLiveFeedback: applied.protectedLiveFeedback.map((path) => rel(root, path)),
          removals: applied.removals.map((removal) => ({
            path: rel(root, removal.path),
            livenessVerdict: removal.livenessVerdict,
          })),
        }
      : null,
  });
}

const discardStream = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

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
          confirmRelaunch: async () => flags.yes,
          relaunchFleet: async (request) => {
            const args = [
              String(request.target ?? 2),
              ...(request.runner ? ["--runner", request.runner] : []),
              ...(request.args ?? []),
            ];
            const launched = await launchFleet(args, ctx.root, discardStream);
            return { status: launched.status, pid: launched.pid };
          },
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
    const applied = flags.fix ? await applyTmpJanitorReport(paths.tmpDir, report) : undefined;
    process.stdout.write(
      flags.json
        ? renderToon(ctx.root, probeReport, castleReport, executableAcceptanceReport, report, hostReport, applied, probeFixes, hostFixes)
        : renderHuman(ctx.root, probeReport, castleReport, executableAcceptanceReport, report, hostReport, applied, probeFixes, hostFixes),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`[red-doctor] ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
