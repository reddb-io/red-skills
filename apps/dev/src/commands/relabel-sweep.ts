// commands/relabel-sweep.ts — the IO half of `dev relabel-sweep` (issue #1292).
//
// A one-shot operator sweep for the Spec/Ticket vocabulary flip (ADR 0093): it
// migrates OPEN Tickets' labels `type:prd → type:spec` and `prd:N → spec:N`,
// creating the target labels on demand. Closed Tickets are never listed, so
// history is never rewritten; `req:*` and every other label family are left
// untouched. The pure remove/add planner lives in `core/relabel-sweep.ts`.
//
// The tool ships INERT — wiring it into the CLI does not run it. `--dry-run`
// prints the complete per-Ticket plan and writes nothing; the real run applies
// exactly that plan and is idempotent (a replay finds no old-vocabulary labels
// left and no-ops). Executing the real sweep against the repo is a separate
// operator Ticket, run once with the fleet stopped.

import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { execTool, type ExecFn } from "../runtime/exec.js";
import { resolveRepoSlug } from "../runtime/wire.js";
import {
  planRelabelSweep,
  targetLabelsToEnsure,
  type TicketLabelState,
  type TicketRelabelPlan,
} from "../core/relabel-sweep.js";

/** The gh surface the sweep needs, injectable so the command's control flow is
 * testable without touching the network. */
export interface RelabelSweepGh {
  /** Every OPEN Ticket with its number, title, and label-name list. */
  listOpenTickets(): Promise<TicketLabelState[]>;
  /** The set of label names that already exist in the repo. */
  existingLabels(): Promise<Set<string>>;
  /** Create a label (best-effort; a pre-existing label is a harmless no-op). */
  createLabel(name: string): Promise<void>;
  /** Apply the remove/add edit to one Ticket. */
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
}

const FLAG_SCHEMA = {
  repo: { kind: "value", aliases: ["R"], coerce: (raw: string): string => raw },
  "dry-run": { kind: "boolean" },
} satisfies FlagSchema;

const NEW_LABEL_DESCRIPTION = "Spec/Ticket vocabulary (ADR 0093)";

function ghFor(cwd: string, repo: string): RelabelSweepGh {
  const repoArgs = repo ? ["--repo", repo] : [];
  const run = (args: readonly string[]): ReturnType<ExecFn> =>
    execTool("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return {
    async listOpenTickets() {
      const out = await run([
        "issue",
        "list",
        ...repoArgs,
        "--state",
        "open",
        "--limit",
        "1000",
        "--json",
        "number,title,labels",
      ]);
      if (out.code !== 0) {
        throw new Error(`list open tickets failed: ${out.stderr.trim() || out.stdout.trim()}`);
      }
      const raw = JSON.parse(out.stdout || "[]") as Array<{
        number?: number;
        title?: string;
        labels?: Array<{ name?: string }>;
      }>;
      return raw
        .map((row) => ({
          number: Number(row.number ?? 0),
          title: typeof row.title === "string" ? row.title : undefined,
          labels: Array.isArray(row.labels) ? row.labels.map((l) => String(l.name ?? "")).filter(Boolean) : [],
        }))
        .filter((t) => t.number > 0);
    },
    async existingLabels() {
      const out = await run(["label", "list", ...repoArgs, "--limit", "1000", "--json", "name"]);
      if (out.code !== 0) {
        throw new Error(`list labels failed: ${out.stderr.trim() || out.stdout.trim()}`);
      }
      const raw = JSON.parse(out.stdout || "[]") as Array<{ name?: string }>;
      return new Set(raw.map((l) => String(l.name ?? "")).filter(Boolean));
    },
    async createLabel(name) {
      // Best-effort: a label that already exists exits non-zero and is ignored.
      await run(["label", "create", name, ...repoArgs, "--description", NEW_LABEL_DESCRIPTION]);
    },
    async editLabels(issue, remove, add) {
      const args = ["issue", "edit", String(issue), ...repoArgs];
      for (const l of remove) args.push("--remove-label", l);
      for (const l of add) args.push("--add-label", l);
      const out = await run(args);
      if (out.code !== 0) {
        throw new Error(`edit labels #${issue} failed: ${out.stderr.trim() || out.stdout.trim()}`);
      }
    },
  };
}

async function resolveRepo(cwd: string, explicit?: string): Promise<string> {
  if (explicit) return explicit;
  return resolveRepoSlug(cwd);
}

function renderPlanLine(plan: TicketRelabelPlan): string {
  const title = plan.title ? ` ${plan.title}` : "";
  return `#${plan.number}${title}: remove=[${plan.remove.join(", ")}] add=[${plan.add.join(", ")}]`;
}

/**
 * `relabel-sweep` — one-shot Spec/Ticket relabel (ADR 0093, issue #1292).
 *
 * Lists open Tickets, plans the `type:prd → type:spec` / `prd:N → spec:N`
 * migration, then either prints the plan (`--dry-run`, writes nothing) or
 * applies it: create the missing target labels, then edit each Ticket. Real
 * runs are idempotent — a replay finds no old-vocabulary labels and no-ops.
 */
export async function relabelSweepCommand(
  args: readonly string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  ghOverride?: RelabelSweepGh,
): Promise<number> {
  const { values } = parseFlags(args, FLAG_SCHEMA);
  const dryRun = values["dry-run"] === true;

  const repo = ghOverride ? "" : await resolveRepo(cwd, values.repo as string | undefined);
  const gh = ghOverride ?? ghFor(cwd, repo);

  const tickets = await gh.listOpenTickets();
  const plans = planRelabelSweep(tickets);

  if (plans.length === 0) {
    stdout.write("relabel-sweep: no open Tickets carry type:prd or prd:N — nothing to migrate.\n");
    return 0;
  }

  const mode = dryRun ? "dry-run" : "apply";
  stdout.write(`relabel-sweep (${mode}): ${plans.length} open Ticket${plans.length === 1 ? "" : "s"} to migrate\n`);
  for (const plan of plans) stdout.write(`  ${renderPlanLine(plan)}\n`);

  const targets = targetLabelsToEnsure(plans);

  if (dryRun) {
    stdout.write(`relabel-sweep (dry-run): would ensure labels exist: [${targets.join(", ")}]\n`);
    stdout.write("relabel-sweep (dry-run): no changes written.\n");
    return 0;
  }

  // Create every target label the plans introduce that does not already exist.
  const existing = await gh.existingLabels();
  for (const label of targets) {
    if (existing.has(label)) continue;
    await gh.createLabel(label);
    stdout.write(`relabel-sweep: created label ${label}\n`);
  }

  for (const plan of plans) {
    await gh.editLabels(plan.number, plan.remove, plan.add);
    stdout.write(`relabel-sweep: migrated #${plan.number}\n`);
  }

  stdout.write(`relabel-sweep: done — ${plans.length} Ticket${plans.length === 1 ? "" : "s"} migrated.\n`);
  return 0;
}
