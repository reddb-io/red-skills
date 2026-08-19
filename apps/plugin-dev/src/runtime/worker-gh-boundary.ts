// worker-gh-boundary — the inner agent spends the Worker's GitHub budget (#3269).
//
// The engine's own `gh` calls already cross the daemon-backed reserved band and
// the bounded quota retry. The agent it launches did not: a raw `gh` resolved
// straight to the host binary, so fleet width multiplied an invisible caller
// until GraphQL was empty. This module puts a tiny `gh` shim first on the inner
// agent's PATH and forwards that argv back through the same two policies. The
// real binary is captured before PATH changes, so forwarding cannot recurse.

import { constants } from "node:fs";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createGithubAttributionLedger,
  tryRouteGithubArgs,
  type GithubAttributionLedger,
} from "@reddb-io/github";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";

import { execTool, type ExecFn, type ExecOutput } from "./exec.js";
import { resolveGhBandGate, type GhBandGate } from "./gh/band.js";
import {
  resolveGhQuotaBackoff,
  withGhQuotaBackoff,
  type GhQuotaBackoffOpts,
} from "./gh/quota.js";

export const WORKER_GH_REAL_ENV = "RED_AFK_GH_REAL";
export const WORKER_GH_ACTOR_ENV = "RED_AFK_GH_ACTOR";

export interface InstallWorkerGhBoundaryInput {
  readonly workerRoot: string;
  readonly path: string;
  readonly realGh: string;
  readonly node: string;
  readonly entry: string;
  readonly actor: string;
  readonly platform?: NodeJS.Platform;
}

export interface InstalledWorkerGhBoundary {
  readonly shimPath: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Quote one word for the POSIX shim. Inputs are local executable paths only. */
function shellWord(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Materialise the private PATH prefix in the Worker's disposable workspace.
 * Nothing lands in the repository worktree, so the boundary cannot dirty the
 * branch the inner agent is required to commit cleanly.
 */
export async function installWorkerGhBoundary(
  input: InstallWorkerGhBoundaryInput,
): Promise<InstalledWorkerGhBoundary> {
  if (input.actor.trim() === "") throw new Error("worker gh boundary requires a non-empty actor");
  const platform = input.platform ?? process.platform;
  const binDir = join(input.workerRoot, "github-boundary", "bin");
  const shimPath = join(binDir, platform === "win32" ? "gh.cmd" : "gh");
  await mkdir(binDir, { recursive: true });

  const contents = platform === "win32"
    ? `@"${input.node.replaceAll('"', '""')}" "${input.entry.replaceAll('"', '""')}" worker-gh %*\r\n`
    : `#!/bin/sh\nexec ${shellWord(input.node)} ${shellWord(input.entry)} worker-gh "$@"\n`;
  await writeFile(shimPath, contents, { encoding: "utf8", mode: 0o700 });
  if (platform !== "win32") await chmod(shimPath, 0o700);

  return {
    shimPath,
    env: {
      PATH: `${binDir}${delimiter}${input.path}`,
      [WORKER_GH_REAL_ENV]: input.realGh,
      [WORKER_GH_ACTOR_ENV]: input.actor,
    },
  };
}

/** Resolve the original gh before the shim is prepended. */
export async function findRealGh(pathValue: string | undefined): Promise<string | null> {
  const names = process.platform === "win32" ? ["gh.exe", "gh.cmd", "gh"] : ["gh"];
  for (const directory of (pathValue ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(directory, name);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Keep searching the captured PATH; absence is an ordinary answer.
      }
    }
  }
  return null;
}

export interface RunWorkerGhBoundaryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly exec?: ExecFn;
  readonly band?: GhBandGate;
  readonly attribution?: GithubAttributionLedger;
  readonly quotaBackoff?: GhQuotaBackoffOpts;
}

/**
 * Run one agent-issued gh argv through classification, admission, attribution,
 * and bounded quota retry. Raw agent calls are convenience work: lifecycle-
 * essential claims and landings are owned by the engine on its own boundary.
 */
export async function runWorkerGhBoundary(
  args: readonly string[],
  options: RunWorkerGhBoundaryOptions = {},
): Promise<ExecOutput> {
  const env = options.env ?? process.env;
  const realGh = (env[WORKER_GH_REAL_ENV] ?? "").trim();
  const actor = (env[WORKER_GH_ACTOR_ENV] ?? "").trim();
  if (realGh === "" || actor === "") {
    return {
      code: 127,
      stdout: "",
      stderr: "worker gh boundary is missing its captured binary or Worker attribution\n",
    };
  }

  const operation = tryRouteGithubArgs(args);
  if (operation == null) {
    return {
      code: 2,
      stdout: "",
      stderr:
        "worker gh boundary refused an unclassified GitHub operation\n" +
        "batch the read through a classified summary or add the operation to packages/github/surface.ts\n",
    };
  }

  const refusal = await resolveGhBandGate(options.band).admit(args, "convenience");
  if (refusal != null) {
    // Never echo raw argv here: a write may carry a body or another sensitive
    // value. The canonical operation key and admission reason contain the full
    // budget verdict without turning a refusal into an outbound leak.
    return {
      code: 75,
      stdout: "",
      stderr: `worker gh boundary refused ${operation.key}: ${refusal.admission.reason}\n`,
    };
  }

  const attribution = options.attribution ?? createGithubAttributionLedger({
    path: join(redskilledHomeDir(homedir()), "state", "github", "spend.toonl"),
  });
  const run = options.exec ?? execTool;
  const invoke = async (): Promise<ExecOutput> => {
    const result = await run(realGh, args, { cwd: options.cwd ?? process.cwd(), env });
    // `gh` does not expose GraphQL's actual node cost. One is therefore the
    // minimum transport-observed spend, while total_count remains exact and the
    // actor answers the incident question without pretending to be a balance.
    await attribution.record({ operation, cost: 1, actor });
    return result;
  };
  return await withGhQuotaBackoff(invoke, resolveGhQuotaBackoff(options.quotaBackoff));
}
