import type { Exec } from "./merge.js";

interface PiPackageRestageDeps {
  mergeExec: Exec;
  landingPhase?(phase: "gate", detail: Record<string, unknown>): void | Promise<void>;
}

interface PiPackageRestageInput {
  readonly branch: string;
  readonly changedFiles?: readonly string[];
  readonly issue: number;
  readonly locked: boolean;
  readonly remote: string;
}

export interface PiPackageRestageFailure {
  readonly ok: false;
  readonly reason: "infra";
  readonly locked: boolean;
  readonly infraReason: string;
}

/** Inputs whose canonical bytes are copied into the staged Pi packages. */
export function requiresPiPackageRestage(changedFiles: readonly string[]): boolean {
  return changedFiles.some((path) => {
    const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
    return /^plugins\/[^/]+\/skills(?:\/|$)/.test(normalized) ||
      /^plugins\/[^/]+\/\.claude-plugin\/plugin\.json$/.test(normalized) ||
      normalized === ".claude-plugin/marketplace.json";
  });
}

function commandEvidence(result: { readonly code: number; readonly stdout: string; readonly stderr: string }): string {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || `exit code ${result.code}`;
}

export async function restagePiPackages(
  deps: PiPackageRestageDeps,
  input: PiPackageRestageInput,
  dir: string,
  publishWorkerBranch: boolean,
): Promise<PiPackageRestageFailure | undefined> {
  if (!requiresPiPackageRestage(input.changedFiles ?? [])) return undefined;

  await deps.landingPhase?.("gate", { step: "pi-restage", status: "start" });
  const built = await deps.mergeExec(["pnpm", "-C", dir, "pi:packages:build"]);
  if (built.code !== 0) {
    return {
      ok: false,
      reason: "infra",
      locked: input.locked,
      infraReason: `Pi package restage failed: ${commandEvidence(built)}`,
    };
  }

  const status = await deps.mergeExec(["git", "-C", dir, "status", "--porcelain", "--", "packaging/pi"]);
  if (status.code !== 0) {
    return {
      ok: false,
      reason: "infra",
      locked: input.locked,
      infraReason: `Pi package restage status failed: ${commandEvidence(status)}`,
    };
  }
  if (status.stdout.trim() === "") {
    await deps.landingPhase?.("gate", { step: "pi-restage", status: "done" });
    return undefined;
  }

  const added = await deps.mergeExec(["git", "-C", dir, "add", "--", "packaging/pi"]);
  if (added.code !== 0) {
    return {
      ok: false,
      reason: "infra",
      locked: input.locked,
      infraReason: `Pi package restage add failed: ${commandEvidence(added)}`,
    };
  }
  const committed = await deps.mergeExec([
    "git", "-C", dir, "commit",
    "-m", "chore: regenerate staged Pi packages",
    "-m", `Refs #${input.issue}`,
  ]);
  if (committed.code !== 0) {
    return {
      ok: false,
      reason: "infra",
      locked: input.locked,
      infraReason: `Pi package restage commit failed: ${commandEvidence(committed)}`,
    };
  }

  if (publishWorkerBranch) {
    const published = await deps.mergeExec([
      "git", "-C", dir, "push", input.remote, `HEAD:refs/heads/${input.branch}`,
    ]);
    if (published.code !== 0) {
      return {
        ok: false,
        reason: "infra",
        locked: input.locked,
        infraReason: `Pi package restage publish failed: ${commandEvidence(published)}`,
      };
    }
  }

  await deps.landingPhase?.("gate", { step: "pi-restage", status: "done" });
  return undefined;
}
