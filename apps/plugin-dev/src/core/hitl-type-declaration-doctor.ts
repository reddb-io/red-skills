/**
 * `/red-doctor` check 25: a repo carrying HUMAN-ONLY type labels that
 * `afk.labels.hitl_types` does not declare (#3013).
 *
 * The pair is the protection (#2966). A repo that installed the labels and
 * skipped the declaration LOOKS protected while every unblocked decision Ticket
 * goes to the autonomous queue, which is why the missing half is a finding
 * rather than an optional nicety. Detection is read-only; the merge lands only
 * under `--fix --yes`, after the diff preview.
 */
import { parseConfigYaml } from "./config.js";
import {
  declaredHitlTypeLabels,
  hitlTypeLabelsAmong,
  planHitlTypeDeclaration,
  type HitlTypeDeclarationPlan,
} from "./hitl-type-declaration.js";

type DoctorVerdict = "ok" | "warn" | "error";

export interface HitlTypeDeclarationFinding {
  /** The installed type label whose declaration is missing; `""` when the
   * finding is about reading the repo at all rather than one label. */
  label: string;
  verdict: Exclude<DoctorVerdict, "ok">;
  reason: string;
  remediation: string;
}

export interface HitlTypeDeclarationReport {
  row: {
    check: "hitl-type-declaration";
    verdict: DoctorVerdict;
    evidence: string;
    fixHome: "→ /red-doctor --fix";
  };
  checked: {
    installedTypeLabels: number;
    declaredTypes: number;
  };
  findings: HitlTypeDeclarationFinding[];
  /** The merge `--fix` would apply, or null when there is nothing to write. */
  plan: HitlTypeDeclarationPlan | null;
}

export interface HitlTypeDeclarationAuditInput {
  /** Every label the tracker carries, or null when there is no tracker to ask. */
  readonly installedLabels: readonly string[] | null;
  /** `.red/config.yaml` as read, or null when the file is absent. */
  readonly configText: string | null;
  readonly transportFailures?: readonly string[];
}

const FIX_HOME = "→ /red-doctor --fix" as const;
const REMEDIATION =
  "declare the type in .red/config.yaml under plugins.dev.afk.labels.hitl_types (red-doctor --fix --yes merges it)";

function report(
  verdict: DoctorVerdict,
  evidence: string,
  findings: HitlTypeDeclarationFinding[],
  checked: HitlTypeDeclarationReport["checked"],
  plan: HitlTypeDeclarationPlan | null = null,
): HitlTypeDeclarationReport {
  return { row: { check: "hitl-type-declaration", verdict, evidence, fixHome: FIX_HOME }, checked, findings, plan };
}

export function auditHitlTypeDeclaration(input: HitlTypeDeclarationAuditInput): HitlTypeDeclarationReport {
  const transportFailures = input.transportFailures ?? [];
  if (transportFailures.length > 0) {
    return report(
      "error",
      `label-list-unavailable: ${transportFailures.join("; ")}`,
      [{
        label: "",
        verdict: "error",
        reason: `could not list the tracker's labels: ${transportFailures.join("; ")}`,
        remediation: "restore GitHub label visibility, then re-run /red-doctor",
      }],
      { installedTypeLabels: 0, declaredTypes: 0 },
    );
  }
  if (input.installedLabels === null) {
    return report("ok", "no issue tracker configured; nothing installs type labels here", [], {
      installedTypeLabels: 0,
      declaredTypes: 0,
    });
  }

  const installed = hitlTypeLabelsAmong(input.installedLabels);
  let declared: string[];
  try {
    declared = declaredHitlTypeLabels(parseConfigYaml(input.configText ?? ""));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return report(
      "error",
      `.red/config.yaml does not parse (${detail}); the declaration cannot be read or written`,
      [{
        label: "",
        verdict: "error",
        reason: `.red/config.yaml does not parse (${detail})`,
        remediation: "repair the YAML syntax, then re-run /red-doctor",
      }],
      { installedTypeLabels: installed.length, declaredTypes: 0 },
    );
  }

  const checked = { installedTypeLabels: installed.length, declaredTypes: declared.length };
  if (installed.length === 0) {
    return report("ok", "no HUMAN-ONLY type label is installed; nothing to declare", [], checked);
  }

  const undeclared = installed.filter((label) => !declared.includes(label));
  if (undeclared.length === 0) {
    return report("ok", `${installed.length} HUMAN-ONLY type labels are declared in afk.labels.hitl_types`, [], checked);
  }

  // A repo with no `.red/config.yaml` is still a finding — the labels are
  // installed and nothing routes them — but not one this doctor writes: only
  // `/red-setup` may create a repository's `.red/` (ADR 0067).
  const plan = input.configText === null ? null : planHitlTypeDeclaration(input.configText, undeclared);
  const remediation = plan === null
    ? "run /red-setup to create .red/config.yaml, then re-run /red-doctor --fix"
    : REMEDIATION;
  return report(
    "warn",
    `${undeclared.join(", ")} installed but undeclared in afk.labels.hitl_types; ` +
      `unblocked Tickets of these types would route to the autonomous queue`,
    undeclared.map((label) => ({
      label,
      verdict: "warn" as const,
      reason: `the ${label} label exists but afk.labels.hitl_types does not name it`,
      remediation,
    })),
    checked,
    plan?.changed ? plan : null,
  );
}

export interface HitlTypeDeclarationFixOptions {
  readonly fix: boolean;
  readonly approved: boolean;
}

export interface HitlTypeDeclarationFixDeps {
  writeConfig(text: string): Promise<void>;
  showDiffPreview?(diff: string): Promise<void>;
}

export interface HitlTypeDeclarationFixReceipt {
  readonly status: "applied" | "declined" | "noop";
  readonly evidence: string;
}

/** Merge the missing types into `.red/config.yaml`. A decline leaves the file
 * byte-identical and the finding open. */
export async function applyHitlTypeDeclarationFix(
  audit: HitlTypeDeclarationReport,
  options: HitlTypeDeclarationFixOptions,
  deps: HitlTypeDeclarationFixDeps,
): Promise<HitlTypeDeclarationFixReceipt> {
  if (!options.fix) return { status: "noop", evidence: "diagnose-only run" };
  if (!audit.plan) return { status: "noop", evidence: "no declaration merge is available" };
  await deps.showDiffPreview?.(audit.plan.diff);
  if (!options.approved) return { status: "declined", evidence: "approval required (--yes)" };
  await deps.writeConfig(audit.plan.after);
  return { status: "applied", evidence: `declared ${audit.plan.added.join(", ")} in afk.labels.hitl_types` };
}
