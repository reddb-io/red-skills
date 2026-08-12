export const GH_MIN_VERSION = "2.47.0";
export const TQ_PINNED_VERSION = "0.22.0";

export type GhInstallManager = "asdf" | "apt" | "brew" | "direct" | "unknown";
export type HostToolchainVerdict = "ok" | "error";
export type HostToolchainFindingKind = "missing" | "outdated" | "toolchain-drift";

export interface GhManagerFacts {
  readonly ghPath?: string;
  readonly toolVersions?: string;
  readonly aptManaged?: boolean;
  readonly brewManaged?: boolean;
}

export interface HostToolchainFacts extends GhManagerFacts {
  readonly ghOutput?: string;
  readonly tqOutput?: string;
  readonly tqRecordedVersion?: string;
}

export interface HostToolchainRow {
  readonly tool: "gh" | "tq";
  readonly version: string;
  readonly required: string;
  readonly manager: GhInstallManager | "cargo";
  readonly verdict: HostToolchainVerdict;
}

export interface HostToolchainFinding {
  readonly tool: "gh" | "tq";
  readonly kind: HostToolchainFindingKind;
  readonly reason: string;
  readonly remediation: string;
  readonly manager: GhInstallManager | "cargo";
}

export interface HostToolchainReport {
  readonly rows: HostToolchainRow[];
  readonly findings: HostToolchainFinding[];
}

export interface HostToolchainFixOptions {
  readonly fix: boolean;
  readonly approved: boolean;
}

interface FixCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HostToolchainFixDeps {
  readonly upgradeGhAsdf: () => Promise<FixCommandResult>;
  readonly installTq: () => Promise<FixCommandResult>;
}

export interface HostToolchainFixReceipt {
  readonly tool: "gh" | "tq";
  readonly status: "applied" | "failed" | "skipped" | "instruction";
  readonly reason: string;
}

export function parseToolVersion(output: string | undefined): string | undefined {
  return output?.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$|[-+()])/)?.[1];
}

function versionParts(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  }
  return 0;
}

export function detectGhInstallManager(facts: GhManagerFacts): GhInstallManager {
  const asdfPin = /^(?:\s*)github-cli(?:\s|$)/m.test(facts.toolVersions ?? "");
  const asdfShim = /(?:^|\/)\.?asdf\/shims\/gh$/.test(facts.ghPath ?? "");
  if (asdfPin || asdfShim) return "asdf";
  if (facts.brewManaged) return "brew";
  if (facts.aptManaged) return "apt";
  if (facts.ghPath) return "direct";
  return "unknown";
}

export function ghUpgradeRecipe(manager: GhInstallManager): string {
  switch (manager) {
    case "asdf":
      return "asdf install github-cli latest && asdf global github-cli latest && asdf reshim github-cli";
    case "apt":
      return "sudo apt-get update && sudo apt-get install --only-upgrade gh";
    case "brew":
      return "brew upgrade gh";
    case "direct":
      return `replace the gh binary with gh >= ${GH_MIN_VERSION} from https://github.com/cli/cli/releases/latest`;
    case "unknown":
      return `install gh >= ${GH_MIN_VERSION} using https://github.com/cli/cli#installation`;
  }
}

export function tqInstallRecipe(): string {
  return `cargo install reddb-io-tq --version ${TQ_PINNED_VERSION} --locked --force`;
}

export function auditHostToolchain(facts: HostToolchainFacts): HostToolchainReport {
  const manager = detectGhInstallManager(facts);
  const ghVersion = parseToolVersion(facts.ghOutput);
  const tqVersion = parseToolVersion(facts.tqOutput);
  const findings: HostToolchainFinding[] = [];

  if (!ghVersion) {
    findings.push({
      tool: "gh",
      kind: "missing",
      manager,
      reason: `gh is missing; required >= ${GH_MIN_VERSION}`,
      remediation: ghUpgradeRecipe(manager),
    });
  } else if (compareVersions(ghVersion, GH_MIN_VERSION) < 0) {
    findings.push({
      tool: "gh",
      kind: "outdated",
      manager,
      reason: `gh ${ghVersion} is below required ${GH_MIN_VERSION}`,
      remediation: ghUpgradeRecipe(manager),
    });
  }

  if (!tqVersion) {
    findings.push({
      tool: "tq",
      kind: "missing",
      manager: "cargo",
      reason: `tq is missing; required ${TQ_PINNED_VERSION}`,
      remediation: tqInstallRecipe(),
    });
  } else if (tqVersion !== TQ_PINNED_VERSION || facts.tqRecordedVersion !== TQ_PINNED_VERSION) {
    findings.push({
      tool: "tq",
      kind: "toolchain-drift",
      manager: "cargo",
      reason: `tq toolchain drift: required ${TQ_PINNED_VERSION}, config ${facts.tqRecordedVersion ?? "missing"}, observed ${tqVersion}`,
      remediation: tqInstallRecipe(),
    });
  }

  return {
    rows: [
      {
        tool: "gh",
        version: ghVersion ?? "missing",
        required: `>=${GH_MIN_VERSION}`,
        manager,
        verdict: findings.some((finding) => finding.tool === "gh") ? "error" : "ok",
      },
      {
        tool: "tq",
        version: tqVersion ?? "missing",
        required: TQ_PINNED_VERSION,
        manager: "cargo",
        verdict: findings.some((finding) => finding.tool === "tq") ? "error" : "ok",
      },
    ],
    findings,
  };
}

function commandReceipt(tool: "gh" | "tq", result: FixCommandResult): HostToolchainFixReceipt {
  return result.code === 0
    ? { tool, status: "applied", reason: "command completed" }
    : { tool, status: "failed", reason: `command exited ${result.code}` };
}

export async function applyHostToolchainFixes(
  report: HostToolchainReport,
  options: HostToolchainFixOptions,
  deps: HostToolchainFixDeps,
): Promise<HostToolchainFixReceipt[]> {
  if (!options.fix) return [];

  const receipts: HostToolchainFixReceipt[] = [];
  for (const finding of report.findings) {
    if (!options.approved) {
      receipts.push({ tool: finding.tool, status: "skipped", reason: "approval required" });
      continue;
    }

    if (finding.tool === "gh") {
      if (finding.manager === "asdf") {
        receipts.push(commandReceipt("gh", await deps.upgradeGhAsdf()));
      } else {
        const reason = finding.manager === "apt"
          ? "sudo-backed apt upgrade is report-only"
          : `${finding.manager} gh upgrade is report-only`;
        receipts.push({ tool: "gh", status: "instruction", reason });
      }
      continue;
    }

    receipts.push(commandReceipt("tq", await deps.installTq()));
  }
  return receipts;
}
