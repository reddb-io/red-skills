import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  toMemoryPayload,
  resolveMemoryCli,
  type AttemptRecordPayload,
} from "../../core/attempt-record.js";
import { configFile } from "@reddb-io/shared/red-paths.js";
import { pluginEnabledInConfig } from "@reddb-io/shared/plugin-gate.js";
import type { OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import type { ExecFn } from "../../runtime/exec.js";
import * as fsx from "../../runtime/fs.js";

type AttemptDirContext = {
  attemptDir: string;
};

/** Read the `version` field of a JSON manifest file, or undefined when the file
 * is missing / unparseable / has no version. The version-keyed cache-bundle
 * candidate in {@link resolveMemoryCli} uses this to locate the fetched CLI. */
function readManifestVersion(path: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the best-effort `recordAttempt` port (ADR 0017). On each call it resolves
 * the memory CLI ({@link resolveMemoryCli}, which gates on the ADR 0009 opt-in
 * config + the bridge's candidate order), writes the payload to a temp JSON file
 * under the current attempt dir, and execs the memory CLI DIRECTLY:
 * `<memoryCli> attempt record --root <gitRoot>` with the payload piped on stdin
 * — exactly what the bridge's `memory_record_attempt` did, minus the shell hop.
 * `MEMORY_REPO_ROOT` is set in the child env (as the bridge expected) so an
 * in-repo memory checkout resolves. When no CLI resolves the call is a silent
 * no-op (memory not installed). Every error (write failure, non-zero exit, spawn
 * error) is SWALLOWED — at most one warn line is written.
 *
 * `exec` is the test-injection seam (mirrors the rest of buildProcessDeps); in
 * production it is undefined and the real `execTool` is used.
 */
export function makeRecordAttempt(
  gitRoot: string,
  current: AttemptDirContext,
  exec?: ExecFn,
): (payload: AttemptRecordPayload) => Promise<void> {
  return async (payload: AttemptRecordPayload): Promise<void> => {
    try {
      const env = { ...process.env, MEMORY_REPO_ROOT: process.env.MEMORY_REPO_ROOT ?? gitRoot };
      const memoryCli = resolveMemoryCli(gitRoot, env, {
        exists: existsSync,
        readJsonVersion: readManifestVersion,
        readText: (path) => {
          try {
            return readFileSync(path, "utf8");
          } catch {
            return undefined;
          }
        },
      });
      if (!memoryCli) return; // memory not opted-in / no CLI resolves — silent skip.
      const dir = current.attemptDir || gitRoot;
      const payloadFile = join(dir, `memory-attempt-${payload.issueNumber}.json`);
      await fsx.ensureDir(dir);
      const json = toMemoryPayload(payload);
      await writeFile(payloadFile, json, "utf8");
      const run = exec ?? (await import("../../runtime/exec.js")).execTool;
      const [cmd, ...head] = memoryCli;
      await run(cmd, [...head, "attempt", "record", "--root", gitRoot], {
        cwd: gitRoot,
        env,
        input: json,
      });
    } catch (err) {
      process.stderr.write(`[afk] memory attempt-record skipped (best-effort): ${String(err)}\n`);
    }
  };
}

export function makeRecordOutcomeEvent(
  gitRoot: string,
  current: AttemptDirContext,
  exec?: ExecFn,
): (event: OutcomeEvent) => Promise<void> {
  return async (event: OutcomeEvent): Promise<void> => {
    try {
      const configPath = configFile(gitRoot);
      const configText = readFileSync(configPath, "utf8");
      if (!pluginEnabledInConfig(configText, "brain")) return;
      const env = { ...process.env, BRAIN_REPO_ROOT: process.env.BRAIN_REPO_ROOT ?? gitRoot };
      const brainCli = resolveBrainCli(gitRoot, env);
      if (!brainCli) return;
      const dir = current.attemptDir || gitRoot;
      await fsx.ensureDir(dir);
      const json = JSON.stringify(event);
      await writeFile(join(dir, `brain-outcome-event-${event.context?.issueNumber ?? "unknown"}.json`), json, "utf8");
      const run = exec ?? (await import("../../runtime/exec.js")).execTool;
      const [cmd, ...head] = brainCli;
      await run(cmd, [...head, "outcome-event", "record", "--root", gitRoot], {
        cwd: gitRoot,
        env,
        input: json,
      });
    } catch (err) {
      process.stderr.write(`[afk] brain outcome-event skipped (best-effort): ${String(err)}\n`);
    }
  };
}

function resolveBrainCli(gitRoot: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const override = env.RED_BRAIN_CLI;
  if (override) return existsSync(override) ? ["node", override] : undefined;
  const pathHit = findOnPath("brain", env.PATH);
  if (pathHit) return ["brain"];
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT ?? env.CODEX_PLUGIN_ROOT;
  if (pluginRoot) {
    const sibling = join(pluginRoot, "..", "brain", "dist", "cli.js");
    if (existsSync(sibling)) return ["node", sibling];
  }
  const inRepo = join(gitRoot, "plugins", "brain", "dist", "cli.js");
  if (existsSync(inRepo)) return ["node", inRepo];
  return undefined;
}

function findOnPath(bin: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
