// operator — the verbs a shipped skill still names, published as tools
// (ADR 0147 rule 1, issue #4024).
//
// ADR 0147 deletes the dev CLI and splits its commands by ONE question: does a
// shipped skill still name it? The ones that do are here, as tools of the plugin's
// MCP; the ones that do not are recorded for deletion in
// `core/skill-named-verb-tools.ts` and die with the bundle.
//
// **A TOOL RETURNS THE ANSWER, NOT THE PRINTOUT.** Every verb below already had a
// value-returning core behind a renderer that turned it into a table an operator
// read. The tool reaches the core; nothing here captures a command's output and
// parses it back into data, because a surface that re-reads its own printout is
// two implementations of one answer and the printout wins every disagreement.
import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

export interface ManagerToolInput {
  intent?: string;
  action?: "intake" | "route" | "artifact" | "status" | "checkpoint";
  effort?: string;
  skill?: string;
  artifact?: string;
  checkpoint?: "export" | "import";
  path?: string;
}

export interface RedDoctorToolInput {
  checks?: string[];
}

export interface AuditSkillsToolInput {
  mechanical_only?: boolean;
  runner?: string;
}

export interface InstallTypeLabelsToolInput {
  labels?: string[];
  repo?: string;
  dry_run?: boolean;
}

export interface CodexStatuslineToolInput {
  config?: string;
}

export interface CodexMonitorAgentToolInput {
  project_root?: string;
  mode?: string;
  interval_seconds?: number;
}

export interface ReconcileEngineToolInput {
  version?: string;
}

export interface OperatorDependencies {
  manager(input: ManagerToolInput): Promise<unknown>;
  redDoctor(input: RedDoctorToolInput): Promise<unknown>;
  auditSkills(input: AuditSkillsToolInput): Promise<unknown>;
  installTypeLabels(input: InstallTypeLabelsToolInput): Promise<unknown>;
  codexStatusline(input: CodexStatuslineToolInput): Promise<unknown>;
  codexMonitorAgent(input: CodexMonitorAgentToolInput): Promise<unknown>;
  reconcileEngine(input: ReconcileEngineToolInput): Promise<unknown>;
}

export function createOperatorTools(deps: OperatorDependencies): CastleMcpTool[] {
  return [
    {
      name: "manager",
      title: "Route work through the Manager",
      description:
        "MUTATING: take one operator intent into the Manager — intake, route an effort to a skill, attach an artifact, read effort status, or export/import the checkpoint — and return the effort record it acted on.",
      inputSchema: {
        intent: z.string().min(1).optional(),
        action: z.enum(["intake", "route", "artifact", "status", "checkpoint"]).optional(),
        effort: z.string().min(1).optional(),
        skill: z.string().min(1).optional(),
        artifact: z.string().min(1).optional(),
        checkpoint: z.enum(["export", "import"]).optional(),
        path: z.string().min(1).optional(),
      },
      invoke: (input) => deps.manager(input as unknown as ManagerToolInput),
    },
    {
      name: "red_doctor",
      title: "Diagnose this repository's RedSkills setup",
      description:
        "READ-ONLY: return every doctor finding for this repository — operational probes, host toolchain, lane and process census, executable acceptance, HUMAN-ONLY type declarations and disposable-lane hygiene — each paired with the route that repairs it. Applying a repair is the `/red-doctor` skill's own fix lane, never a side effect of the read.",
      inputSchema: {
        checks: z.array(z.string().min(1)).optional(),
      },
      invoke: (input) => deps.redDoctor(input as unknown as RedDoctorToolInput),
    },
    {
      name: "audit_skills",
      title: "Audit the shipped skills",
      description:
        "Return the ranked skill-audit scores for this repository's skill tree. Pass `mechanical_only` to score without the judge, which makes the read deterministic and free of agent cost.",
      inputSchema: {
        mechanical_only: z.boolean().optional(),
        runner: z.string().min(1).optional(),
      },
      invoke: (input) => deps.auditSkills(input as unknown as AuditSkillsToolInput),
    },
    {
      name: "install_type_labels",
      title: "Install Wayfinder type labels",
      description:
        "MUTATING: create the Wayfinder ticket type labels on the tracker AND declare the HUMAN-ONLY ones in this project's configuration, in one act — the two are one protection with two halves, and installing only the labels leaves the repository looking protected while unblocked decision Tickets enter the autonomous queue (#3013).",
      inputSchema: {
        labels: z.array(z.string().min(1)).optional(),
        repo: z.string().min(1).optional(),
        dry_run: z.boolean().optional(),
      },
      invoke: (input) => deps.installTypeLabels(input as unknown as InstallTypeLabelsToolInput),
    },
    {
      name: "codex_statusline",
      title: "Inspect the Codex footer preference",
      description:
        "READ-ONLY: return the active Codex configuration's status-line inspection — the file read, the current preference, and the problem that keeps the RedSkills footer from rendering.",
      inputSchema: {
        config: z.string().min(1).optional(),
      },
      invoke: (input) => deps.codexStatusline(input as unknown as CodexStatuslineToolInput),
    },
    {
      name: "codex_monitor_agent",
      title: "Build the Codex monitor agent brief",
      description:
        "Return the read-only monitor brief a Codex sub-agent is spawned with: what to poll, how often, and the conditions under which it closes itself. It spawns nothing — the host's own spawn primitive does.",
      inputSchema: {
        project_root: z.string().min(1).optional(),
        mode: z.string().min(1).optional(),
        interval_seconds: z.number().int().positive().optional(),
      },
      invoke: (input) => deps.codexMonitorAgent(input as unknown as CodexMonitorAgentToolInput),
    },
    {
      name: "reconcile_engine",
      title: "Reconcile this project's engine delivery",
      description:
        "MUTATING: warm the published engine bundle into the stable cache path and re-point a standing registration at it in one operation, then return the version, the bundle path, and what happened to the registration.",
      inputSchema: {
        version: z.string().min(1).optional(),
      },
      invoke: (input) => deps.reconcileEngine(input as unknown as ReconcileEngineToolInput),
    },
  ];
}
