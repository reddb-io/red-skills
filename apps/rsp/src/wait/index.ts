/**
 * index.ts — `rsp wait`, the exceptional coordination primitive.
 *
 * A wait is a process whose EXIT is the message: 0 the target succeeded, 1 it
 * failed, 2 nobody can say. Callers run it in the background and treat process
 * exit as the wake-up, which is why hand-written sleep loops are never needed.
 *
 * This file owns the sequence, and only the sequence:
 *
 *   parse → register → execute → complete → deregister
 *
 * Each step lives in its own module (`args`, `registry`, `lifecycle`,
 * `completion`), and the ordering guarantees are all here:
 *
 * - The cancellation signal is installed BEFORE the registry entry exists, so
 *   there is no window where a SIGTERM leaves an orphaned record.
 * - The result is sealed to disk BEFORE any hook can wake another process.
 * - The registry entry is removed on EVERY exit path, including a throw.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import type { JsonObject } from "@reddb-io/toon";
import { envDuration, parseWaitArgs } from "./args.js";
import { completeWait, persistResult, renderResult, renderStructured } from "./completion.js";
import { pollUntilDone, runCommandWait, type WaitExecution } from "./lifecycle.js";
import {
  indeterminate,
  isWaitKind,
  POLL_TIERS,
  WAIT_LIST_SCHEMA,
  WAIT_SCHEMA_VERSION,
  type ParsedWait,
  type WaitKind,
  type WaitRegistryEntry,
} from "./model.js";
import { waitRegistryDir, waitSpoolDir } from "./paths.js";
import { createPrProbe, latestRunId, probeJob, probeRelease, probeRun } from "./probes.js";
import type { GhCallOptions } from "./github.js";
import { pidStartTime } from "./process-tree.js";
import { listWaits, newRegistryEntry, registryPathFor, writeRegistryEntry } from "./registry.js";
import { renderWaitHelp } from "./help.js";
import { createWebhookWakeSource } from "./webhook-wake-source.js";

export { listWaits } from "./registry.js";
export { renderWaitHelp } from "./help.js";
export type { WaitKind, WaitStatus } from "./model.js";

export async function runWait(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  let parsed: ParsedWait;
  try {
    parsed = await parseWaitArgs(argv);
  } catch (err) {
    // A bad invocation still answers in the result vocabulary, so a caller that
    // only reads the envelope is never left guessing.
      return await reportArgumentError(argv, err);
  }

  if (parsed.kind === "help" || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(renderWaitHelp());
    return 0;
  }
  if (parsed.kind === "ls") {
    const listed = {
      schema: WAIT_LIST_SCHEMA,
      version: WAIT_SCHEMA_VERSION,
      waits: await listWaits(cwd),
    } as JsonObject;
    process.stdout.write(renderStructured(listed, parsed.options.format));
    return 0;
  }
  if (!isWaitKind(parsed.kind)) {
    process.stdout.write(renderWaitHelp());
    return 2;
  }

  return await executeWait({ ...parsed, kind: parsed.kind }, cwd);
}

async function executeWait(parsed: ParsedWait & { kind: WaitKind }, cwd: string): Promise<number> {
  const kind = parsed.kind;
  const entry = newRegistryEntry({
    id: randomUUID(),
    kind,
    target: waitTarget(parsed),
    reason: parsed.options.reason,
    pid: process.pid,
    pid_start_time: await pidStartTime(process.pid),
    started_at: new Date().toISOString(),
    deadline_at: new Date(Date.now() + parsed.options.timeoutMs).toISOString(),
    timeout_ms: parsed.options.timeoutMs,
    poll_tier: POLL_TIERS[kind],
    status: "running",
    attempts: 0,
  });
  const registryPath = registryPathFor(cwd, entry.id);

  // Install cancellation first: a SIGTERM that arrives during setup must still
  // unwind through the same path as one that arrives mid-wait.
  const abort = new AbortController();
  let interruptedBy: NodeJS.Signals | undefined;
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedBy = signal;
    abort.abort();
  };
  const onSigint = () => interrupt("SIGINT");
  const onSigterm = () => interrupt("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await mkdir(waitRegistryDir(cwd), { recursive: true });
    await writeRegistryEntry(registryPath, entry);

    let execution = await dispatchWait(parsed, cwd, registryPath, entry, abort.signal);
    if (interruptedBy) {
      // An interrupt outranks whatever the execution managed to conclude: the
      // wait did not observe its target to completion.
      execution = {
        ...execution,
        verdict: indeterminate(`wait interrupted by ${interruptedBy}`, execution.verdict.details),
      };
    }

    const outcome = await completeWait({
      kind,
      entry,
      verdict: execution.verdict,
      options: parsed.options,
      cwd,
      cleanupProven: execution.cleanupProven,
      survivors: execution.survivors,
    });
    process.stdout.write(renderStructured(outcome.result, parsed.options.format));
    return outcome.exitCode;
  } catch (err) {
    // An internal failure is indeterminate, never a target verdict: we did not
    // learn that the PR failed, we learned that we failed to look.
    const verdict = indeterminate(err instanceof Error ? err.message : String(err));
    const result = renderResult(kind, entry, verdict, { status: "success" }, new Date().toISOString());
    await persistResult(parsed.options.resultFile, result, parsed.options.format).catch(() => undefined);
    process.stdout.write(renderStructured(result, parsed.options.format));
    return 2;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await rm(registryPath, { force: true }).catch(() => undefined);
  }
}

/** Route to the execution shape this kind needs. */
async function dispatchWait(
  parsed: ParsedWait & { kind: WaitKind },
  cwd: string,
  registryPath: string,
  entry: WaitRegistryEntry,
  signal: AbortSignal,
): Promise<WaitExecution> {
  const call: GhCallOptions = { cwd, signal, timeoutMs: parsed.options.probeTimeoutMs };

  switch (parsed.kind) {
    case "cmd":
      return await runCommandWait({
        commandLine: parsed.commandLine ?? "",
        options: parsed.options,
        cwd,
        spoolDir: waitSpoolDir(cwd),
        registryPath,
        entry,
        signal,
      });

    case "pr": {
      const number = parsed.target ?? "";
      if (!/^[1-9][0-9]*$/.test(number)) return { verdict: indeterminate("missing PR number") };
      entry.webhook_mode = "polling";
      const webhook = createWebhookWakeSource({ cwd, cancelSignal: signal });
      webhook.once("mode-changed", () => {
        entry.webhook_mode = "webhook";
      });
      await webhook.start();
      try {
        return await pollUntilDone({
          probe: createPrProbe(number, call, {
            emptyChecksGraceMs: envDuration("RSP_WAIT_PR_EMPTY_CHECKS_GRACE_MS", 30_000),
          }),
          timeoutMs: parsed.options.timeoutMs,
          baseSleepMs: envDuration("RSP_WAIT_PR_POLL_MS", 15_000),
          makeWakeSignal: webhook.makeWakeSignalFor("pr", number),
          registryPath,
          entry,
          signal,
        });
      } finally {
        await webhook.stop();
      }
    }

    case "run": {
      const id = await resolveRunTarget(parsed, call, registryPath, entry);
      if (!id.ok) return { verdict: indeterminate(id.reason) };
      entry.webhook_mode = "polling";
      const webhook = createWebhookWakeSource({ cwd, cancelSignal: signal });
      webhook.once("mode-changed", () => {
        entry.webhook_mode = "webhook";
      });
      await webhook.start();
      try {
        return await pollUntilDone({
          probe: () => probeRun(id.value, call),
          timeoutMs: parsed.options.timeoutMs,
          baseSleepMs: envDuration("RSP_WAIT_RUN_POLL_MS", 15_000),
          makeWakeSignal: webhook.makeWakeSignalFor("run", id.value),
          registryPath,
          entry,
          signal,
        });
      } finally {
        await webhook.stop();
      }
    }

    case "job": {
      const id = parsed.target ?? "";
      if (!/^[1-9][0-9]*$/.test(id)) return { verdict: indeterminate("missing job id") };
      return await pollUntilDone({
        probe: () => probeJob(id, call),
        timeoutMs: parsed.options.timeoutMs,
        baseSleepMs: envDuration("RSP_WAIT_JOB_POLL_MS", 15_000),
        registryPath,
        entry,
        signal,
      });
    }

    case "release":
      return await pollUntilDone({
        probe: () => probeRelease(parsed.tagGlob, new Date(entry.started_at), call, parsed.existing),
        timeoutMs: parsed.options.timeoutMs,
        baseSleepMs: envDuration("RSP_WAIT_RELEASE_POLL_MS", 60_000),
        registryPath,
        entry,
        signal,
      });
  }
}

/**
 * Settle on ONE run ID before polling begins.
 *
 * `--branch <b> --latest` is resolved exactly once and written back to the
 * registry, so the target visible in `rsp wait ls` is the run actually being
 * watched — and a run pushed mid-wait cannot quietly take its place.
 */
async function resolveRunTarget(
  parsed: ParsedWait & { kind: WaitKind },
  call: GhCallOptions,
  registryPath: string,
  entry: WaitRegistryEntry,
): Promise<{ ok: true; value: string } | { ok: false; reason: string }> {
  if (parsed.target) return { ok: true, value: parsed.target };
  if (!(parsed.latest && parsed.branch)) return { ok: false, reason: "missing run id" };
  const pinned = await latestRunId(parsed.branch, call);
  if (!pinned) return { ok: false, reason: `no run found for branch ${parsed.branch}` };
  parsed.target = pinned;
  entry.target = `run:${pinned}`;
  await writeRegistryEntry(registryPath, entry);
  return { ok: true, value: pinned };
}

/** The stable, human-readable identity of what this wait is watching. */
function waitTarget(parsed: ParsedWait): string {
  if (parsed.kind === "cmd") return `cmd:${parsed.commandLine ?? ""}`;
  if (parsed.kind === "run" && parsed.branch && parsed.latest) return `run:${parsed.branch}:latest`;
  if (parsed.kind === "release") return `release:${parsed.tagGlob ?? "*"}`;
  return `${parsed.kind}:${parsed.target ?? ""}`;
}

/**
 * Emit a well-formed result for an invocation that never became a wait. The
 * envelope is honoured even here so tooling has exactly one shape to parse.
 */
async function reportArgumentError(argv: readonly string[], err: unknown): Promise<number> {
  const format = argv.includes("--json") ? "json" : "toon";
  const resultFileIndex = argv.indexOf("--result-file");
  const resultFile = resultFileIndex >= 0 ? argv[resultFileIndex + 1] : undefined;
  const kind: WaitKind = isWaitKind(argv[1]) ? (argv[1] as WaitKind) : "cmd";
  const now = new Date().toISOString();
  const entry = newRegistryEntry({
    id: randomUUID(),
    kind,
    target: `${kind}:`,
    reason: "",
    pid: process.pid,
    started_at: now,
    deadline_at: now,
    timeout_ms: 0,
    poll_tier: POLL_TIERS[kind],
    status: "indeterminate",
    attempts: 0,
  });
  const result = renderResult(
    kind,
    entry,
    indeterminate(err instanceof Error ? err.message : String(err)),
    { status: "success" },
    now,
  );
  await persistResult(resultFile, result, format).catch(() => undefined);
  process.stdout.write(renderStructured(result, format));
  return 2;
}
