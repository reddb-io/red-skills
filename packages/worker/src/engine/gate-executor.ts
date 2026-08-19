import {
  CASTLE_VALIDATION_SCHEMA,
  DEFAULT_BACKPRESSURE_TIMEOUT_MS,
  FEEDBACK_SCRIPTS,
  KILLED_EXIT_CODE,
  MECHANICAL_KINDS,
} from "./gate-constants.js";
import type { GateFinding, GateSink, GateSinkOutcome } from "./gate-sink.js";
import {
  computeValidationScope,
  scopesForValidationScope,
  type PackageLayout,
  type ValidationScope,
  type WorkspaceGraph,
} from "./validation-cone.js";
import {
  evaluateHostGateAdmission,
  type GateWeightClass,
  type HostCapabilityProfile,
  type HostGateAdmission,
} from "./host-capability-profile.js";

export type ValidationStatus = "passed" | "failed" | "skipped";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ValidationResourceClass = "light" | "heavy";
export type FeedbackExec = (args: string[], options?: { weight: ValidationResourceClass }) => Promise<ExecResult>;
export type BackpressureExec = (input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  weight?: ValidationResourceClass;
}) => Promise<ExecResult>;

export interface ScriptLayout extends PackageLayout {
  hasScript: (scope: string, script: string) => boolean;
}

export interface ValidationRecord {
  schema: typeof CASTLE_VALIDATION_SCHEMA;
  name: string;
  status: ValidationStatus;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  summary?: string;
}

export interface ValidationCheck {
  name: string;
  status: ValidationStatus;
  record: ValidationRecord;
}

export interface RunCastleGateInput {
  worktree: string;
  changedFiles: readonly string[];
  layout: ScriptLayout;
  graph: WorkspaceGraph;
  findings?: readonly GateFinding[];
  backpressureCommands?: readonly string[];
  sink: GateSink;
  feedbackExec: FeedbackExec;
  backpressureExec: BackpressureExec;
  applyMechanical: (finding: GateFinding) => Promise<void>;
  now: () => number;
  backpressureTimeoutMs?: number;
  /** This machine's durable capability declaration. Absent keeps legacy permissive routing. */
  hostProfile?: HostCapabilityProfile;
  /** Explicit gate weight when the caller has already classified the run. */
  gateWeight?: GateWeightClass;
}

export interface CastleGateResult {
  ok: boolean;
  validationScope: ValidationScope;
  checks: ValidationCheck[];
  sidecar: string[];
  sinkOutcomes: GateSinkOutcome[];
  mechanicalApplied: number;
  admission: HostGateAdmission;
}

function gateWeightForScope(scope: ValidationScope): GateWeightClass {
  if (scope.type === "whole-workspace") return "full-workspace";
  return scope.packages.length > 1 ? "heavy-cone" : "light-cone";
}

/** Castle classifies command meaning; the host only admits a generic weight. */
export function validationResourceClass(scope: string, script: string): ValidationResourceClass {
  return scope === "." && (script === "test" || script === "typecheck" || script === "build")
    ? "heavy"
    : "light";
}

export function classifyFinding(finding: GateFinding): "mechanical" | "intent" {
  return (MECHANICAL_KINDS as readonly string[]).includes(finding.kind) ? "mechanical" : "intent";
}

function scopeLabel(scope: string): string {
  return scope === "." ? "root" : scope;
}

function scopeDir(worktree: string, scope: string): string {
  return scope === "." ? worktree : `${worktree}/${scope}`;
}

function outputSummary(status: ValidationStatus, output: string): string {
  if (status === "passed") return "command exited 0";
  const trimmed = output.replace(/\n+$/, "");
  if (trimmed === "") return "command exited non-zero";
  return trimmed.split("\n").slice(-20).join(" ").slice(0, 1000);
}

function validationRecord(input: {
  name: string;
  status: ValidationStatus;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  summary?: string;
}): ValidationRecord {
  const record: ValidationRecord = {
    schema: CASTLE_VALIDATION_SCHEMA,
    name: input.name,
    status: input.status,
  };
  if (input.command !== undefined && input.command !== "") record.command = input.command;
  if (input.exitCode !== undefined && Number.isFinite(input.exitCode)) record.exitCode = Math.trunc(input.exitCode);
  if (input.durationMs !== undefined) record.durationMs = input.durationMs;
  if (input.summary !== undefined && input.summary !== "") record.summary = input.summary;
  return record;
}

function pushCheck(checks: ValidationCheck[], sidecar: string[], check: ValidationCheck): void {
  checks.push(check);
  sidecar.push(JSON.stringify(check.record));
}

async function runFeedbackChecks(
  input: RunCastleGateInput,
  scopes: readonly string[],
  checks: ValidationCheck[],
  sidecar: string[],
): Promise<boolean> {
  let ok = true;
  for (const script of FEEDBACK_SCRIPTS) {
    if (scopes.length === 0) {
      const name = `${script}:no-package`;
      pushCheck(checks, sidecar, {
        name,
        status: "skipped",
        record: validationRecord({ name, status: "skipped", summary: "no package.json" }),
      });
      continue;
    }

    for (const scope of scopes) {
      const label = scopeLabel(scope);
      const name = `${script}:${label}`;
      if (!input.layout.hasScript(scope, script)) {
        pushCheck(checks, sidecar, {
          name,
          status: "skipped",
          record: validationRecord({ name, status: "skipped", summary: "script missing" }),
        });
        continue;
      }

      const dir = scopeDir(input.worktree, scope);
      const command = `pnpm -C ${dir} ${script}`;
      const start = input.now();
      const result = await input.feedbackExec(["pnpm", "-C", dir, script], {
        weight: validationResourceClass(scope, script),
      });
      const durationMs = input.now() - start;
      const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
      if (status === "failed") ok = false;
      pushCheck(checks, sidecar, {
        name,
        status,
        record: validationRecord({
          name,
          status,
          command,
          exitCode: result.code,
          durationMs,
          summary: outputSummary(status, `${result.stdout}${result.stderr}`),
        }),
      });
    }
  }
  return ok;
}

async function runBackpressureChecks(
  input: RunCastleGateInput,
  checks: ValidationCheck[],
  sidecar: string[],
): Promise<boolean> {
  let ok = true;
  const timeoutMs = input.backpressureTimeoutMs ?? DEFAULT_BACKPRESSURE_TIMEOUT_MS;
  for (const raw of input.backpressureCommands ?? []) {
    const command = raw.trim();
    if (command === "") continue;
    const name = `backpressure:${command}`;
    const start = input.now();
    const result = await input.backpressureExec({ command, cwd: input.worktree, timeoutMs, weight: "heavy" });
    const durationMs = input.now() - start;
    const status: ValidationStatus = result.code === 0 ? "passed" : "failed";
    if (status === "failed") ok = false;
    const summary = result.code === KILLED_EXIT_CODE
      ? `command timed out after ${timeoutMs}ms`
      : outputSummary(status, `${result.stdout}${result.stderr}`);
    pushCheck(checks, sidecar, {
      name,
      status,
      record: validationRecord({ name, status, command, exitCode: result.code, durationMs, summary }),
    });
  }
  return ok;
}

export async function runCastleGate(
  input: RunCastleGateInput,
): Promise<CastleGateResult> {
  const validationScope = computeValidationScope(
    input.changedFiles,
    input.layout,
    input.graph,
  );
  const admission = evaluateHostGateAdmission(
    input.hostProfile,
    input.gateWeight ?? gateWeightForScope(validationScope),
  );
  const checks: ValidationCheck[] = [];
  const sidecar: string[] = [];
  const sinkOutcomes: GateSinkOutcome[] = [];
  let mechanicalApplied = 0;
  let ok = true;

  if (!admission.admitted) {
    return {
      ok: false,
      validationScope,
      checks,
      sidecar,
      sinkOutcomes,
      mechanicalApplied,
      admission,
    };
  }

  for (const finding of input.findings ?? []) {
    if (classifyFinding(finding) === "mechanical") {
      await input.applyMechanical(finding);
      mechanicalApplied++;
    } else {
      const outcome = await input.sink.intentFinding(finding);
      sinkOutcomes.push(outcome);
      if (outcome !== "approved") ok = false;
    }
  }

  const feedbackOk = await runFeedbackChecks(input, scopesForValidationScope(validationScope), checks, sidecar);
  ok = ok && feedbackOk;

  if (feedbackOk) {
    ok = ok && await runBackpressureChecks(input, checks, sidecar);
  }

  return {
    ok,
    validationScope,
    checks,
    sidecar,
    sinkOutcomes,
    mechanicalApplied,
    admission,
  };
}
