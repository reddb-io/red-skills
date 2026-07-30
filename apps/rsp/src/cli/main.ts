import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type JsonObject } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { renderStructuredError } from "../structured-error.js";
import {
  isHelpRequest,
  isStructuredUsageRenderable,
  numericValueAfter,
  parseArgs,
  parseGhApiJsonArgs,
  sinceDays,
  statsFull,
  valueAfter,
} from "./args.js";
import { readDashboardSnapshot, renderDashboard } from "./dashboard.js";
import { runDoctor, renderDoctor } from "./doctor.js";
import { fastTelemetryRoot, isFastGitStatus, runFastGitStatus } from "./fast-git.js";
import { renderCliHelp } from "./help.js";
import { appendShowAccountingEvent, emitWrappedResult, fireAndForget } from "./invocation-telemetry.js";
import {
  degradeToPassthrough,
  isWrapperCommand,
  passthroughDisabledDirectory,
  passthroughSelfDisabled,
  rspDisabledReason,
  runControlHoldout,
  shouldUseControlHoldout,
  telemetryCommand,
} from "./passthrough.js";
import { readStatsSnapshot, renderGainsReportToon, renderRspStatus, renderSetupResult, renderStats } from "./stats.js";
import { LazyRspElisionStore, runColdWrappedCommand } from "./store-lifecycle.js";

async function main(argv = process.argv.slice(2)): Promise<number> {
  const buildInfo = readBuildInfo("rsp");
  // Answered before enablement, config, or the resident: "which build is this?"
  // must stay answerable in exactly the situation you need to ask it — a
  // directory that never opted in, a host with no socket, a degraded shell.
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(
      argv.includes("--json") ? `${JSON.stringify(buildInfo)}\n` : `${renderVersion(buildInfo)}\n`,
    );
    return 0;
  }
  if (isHelpRequest(argv)) {
    process.stdout.write(renderCliHelp(argv));
    return 0;
  }
  const args = parseArgs(argv);
  if (args.command === "hook" && args.positional[1] === "claude-pre-exec") {
    const { runClaudePreExecHook } = await import("../intercept.js");
    return await runClaudePreExecHook();
  }
  if (args.command === "hook" && args.positional[1] === "codex-pre-exec") {
    const { runCodexPreExecHook } = await import("../intercept.js");
    return await runCodexPreExecHook();
  }
  if (args.command === "hook" && args.positional[1] === "claude-post-exec") {
    const { runClaudePostExecHook } = await import("../normalize.js");
    return await runClaudePostExecHook();
  }
  if (args.command === "hook" && args.positional[1] === "codex-post-exec") {
    const { runCodexPostExecHook } = await import("../normalize.js");
    return await runCodexPostExecHook();
  }
  if (args.command === "setup") {
    const { provisionRspRepoStore } = await import("../setup.js");
    const result = await provisionRspRepoStore(process.cwd());
    process.stdout.write(renderSetupResult(result));
    return 0;
  }
  if (args.command === "mcp") {
    const { runRspMcpServer } = await import("../mcp-server.js");
    await runRspMcpServer();
    return 0;
  }
  if (args.command === "wait") {
    const { runWait } = await import("../wait/index.js");
    return await runWait(args.positional);
  }
  if (args.command === "shell-init") {
    const shell = args.positional[1];
    if (shell !== "fish" && shell !== "bash" && shell !== "zsh") {
      process.stdout.write(renderStructuredError({
        command: args.positional.join(" ") || "shell-init",
        category: "usage",
        error: "usage rsp shell-init fish|bash|zsh",
        help: "rsp shell-init bash",
      }));
      return 2;
    }
    const { renderShellInit } = await import("../shell-init.js");
    process.stdout.write(renderShellInit(shell));
    return 0;
  }
  const { resolveRspConfig } = await import("../config.js");
  const config = resolveRspConfig(process.cwd(), process.env, args.storeUri);
  if (args.command === "doctor") {
    const { resolveResidentPaths } = await import("../resident-client.js");
    const residentPaths = resolveResidentPaths(process.cwd());
    const status = await runDoctor(config, residentPaths, sinceDays(args.positional, 1));
    process.stdout.write(renderDoctor(status));
    return status.exitCode;
  }
  const wrapperCommand = isWrapperCommand(args.command);
  if (!config.enabled) {
    if (wrapperCommand) return await passthroughDisabledDirectory(args.positional);
    process.stdout.write(`${rspDisabledReason()}\n`);
    return 0;
  }
  if (args.command === "git" && isFastGitStatus(args.positional)) {
    const started = process.hrtime.bigint();
    return await emitWrappedResult(args, await runFastGitStatus(), started, undefined, await fastTelemetryRoot(process.cwd()), config);
  }
  const { resolveResidentPaths, ensureResidentServer } = await import("../resident-client.js");
  const residentPaths = resolveResidentPaths(process.cwd());
  // A wrapper family that broke its overhead ceiling stops taxing commands and
  // runs them raw until its cooldown lapses (#2746).
  if (wrapperCommand && args.command) {
    const { overheadFamilyDisabled } = await import("../overhead-budget.js");
    const selfDisabled = overheadFamilyDisabled(residentPaths.rootDir, args.command);
    if (selfDisabled) return await passthroughSelfDisabled(args.positional, residentPaths.rootDir, selfDisabled);
  }
  if (wrapperCommand && shouldUseControlHoldout(config.measurementHoldoutShare)) {
    return await runControlHoldout(args, residentPaths.rootDir, config.measurementHoldoutShare);
  }
  if (args.command === "server") {
    const { runResidentServer } = await import("../resident-server.js");
    const serverPaths = resolveResidentPaths(process.cwd());
    const socket = valueAfter(args.positional, "--socket") ?? serverPaths.socketPath;
    const serverConfig = resolveRspConfig(process.cwd(), process.env, args.storeUri ?? valueAfter(args.positional, "--store-uri"));
    if (!serverConfig.enabled) {
      process.stdout.write(`${rspDisabledReason()}\n`);
      return 0;
    }
    await runResidentServer({
      socketPath: socket,
      pidPath: valueAfter(args.positional, "--pid-file") ?? resolveResidentPaths(process.cwd()).pidPath,
      rootDir: serverPaths.rootDir,
      storeUri: serverConfig.storeUri,
      ttlDays: numericValueAfter(args.positional, "--ttl-days") ?? serverConfig.ttlDays,
      ephemeralTtlHours: numericValueAfter(args.positional, "--ephemeral-ttl-hours") ?? serverConfig.ephemeralTtlHours,
      byteBudget: numericValueAfter(args.positional, "--byte-budget") ?? serverConfig.byteBudget,
      telemetryTtlDays: numericValueAfter(args.positional, "--telemetry-ttl-days") ?? serverConfig.telemetryTtlDays,
      telemetryByteBudget: numericValueAfter(args.positional, "--telemetry-byte-budget") ?? serverConfig.telemetryByteBudget,
      telemetryDrainIntervalMs: numericValueAfter(args.positional, "--telemetry-drain-interval-ms") ??
        serverConfig.telemetryDrainIntervalMs,
      telemetryDrainTimeoutMs: numericValueAfter(args.positional, "--telemetry-drain-timeout-ms") ??
        serverConfig.telemetryDrainTimeoutMs,
      idleMs: numericValueAfter(args.positional, "--idle-ms") ?? serverConfig.idleMs,
      residentVersion: valueAfter(args.positional, "--resident-version") ?? buildInfo.version,
      registryPath: valueAfter(args.positional, "--registry") ?? serverPaths.registryPath,
    });
    return 0;
  }
  if (args.command === "warm-resident") {
    const warmPaths = resolveResidentPaths(process.cwd());
    const socket = valueAfter(args.positional, "--socket") ?? warmPaths.socketPath;
    const wakeLock = valueAfter(args.positional, "--wake-lock") ?? warmPaths.wakeLockPath;
    const warmConfig = resolveRspConfig(process.cwd(), process.env, args.storeUri ?? valueAfter(args.positional, "--store-uri"));
    if (!warmConfig.enabled) return 0;
    const { warmResidentServer } = await import("../resident-client.js");
    await warmResidentServer({
      ...warmPaths,
      socketPath: socket,
      wakeLockPath: wakeLock,
    }, {
      storeUri: warmConfig.storeUri,
      ttlDays: numericValueAfter(args.positional, "--ttl-days") ?? warmConfig.ttlDays,
      ephemeralTtlHours: numericValueAfter(args.positional, "--ephemeral-ttl-hours") ?? warmConfig.ephemeralTtlHours,
      byteBudget: numericValueAfter(args.positional, "--byte-budget") ?? warmConfig.byteBudget,
      telemetryTtlDays: numericValueAfter(args.positional, "--telemetry-ttl-days") ?? warmConfig.telemetryTtlDays,
      telemetryByteBudget: numericValueAfter(args.positional, "--telemetry-byte-budget") ?? warmConfig.telemetryByteBudget,
      telemetryDrainIntervalMs: numericValueAfter(args.positional, "--telemetry-drain-interval-ms") ??
        warmConfig.telemetryDrainIntervalMs,
      telemetryDrainTimeoutMs: numericValueAfter(args.positional, "--telemetry-drain-timeout-ms") ??
        warmConfig.telemetryDrainTimeoutMs,
      idleMs: numericValueAfter(args.positional, "--idle-ms") ?? warmConfig.idleMs,
      clientVersion: buildInfo.version,
    });
    return 0;
  }
  if (args.command === "proxy") {
    const { runProxy } = await import("../proxy.js");
    return await runProxy(args.positional, { telemetryRoot: residentPaths.rootDir, level: args.level });
  }
  if (args.command === "status" || args.command === "sweep") {
    const { residentRegistryStatus, sweepResidentRegistry } = await import("../resident-client.js");
    const resident = args.command === "sweep"
      ? await sweepResidentRegistry(residentPaths)
      : await residentRegistryStatus(residentPaths);
    if (args.command === "sweep") {
      // The janitor already owns this lane, so the ETag cache is reclaimed and
      // re-bounded here rather than by a second surface nobody runs (#2745).
      const { sweepGhEtagCache } = await import("../gh-etag-cache.js");
      await sweepGhEtagCache(residentPaths.rootDir, { maxBytes: config.ghEtagCacheMaxBytes });
    }
    // The cost verdict is the surface, not a log line an operator has to
    // interpret (#2746): a breached ceiling renders red right here.
    const { overheadHealth } = await import("../overhead-budget.js");
    const overhead = overheadHealth(residentPaths.rootDir, config.overhead);
    process.stdout.write(renderRspStatus(resident as unknown as JsonObject, overhead));
    // Reading status never fails a command; `rsp doctor` owns the exit code.
    return 0;
  }
  if (args.command === "gh-api-json") {
    const { readGhConditionalJson } = await import("../gh-conditional.js");
    const request = parseGhApiJsonArgs(args.positional);
    if (!request) {
      process.stdout.write(renderStructuredError({
        command: args.positional.join(" "),
        category: "usage",
        error: "usage rsp gh-api-json <path> [-f name=value ...]",
        help: "rsp gh-api-json repos/{owner}/{repo}",
        validFlags: ["-f", "-F"],
      }));
      return 2;
    }
    const response = await readGhConditionalJson({
      path: request.path,
      params: request.params,
      cwd: process.cwd(),
      telemetryRoot: residentPaths.rootDir,
      command: `rsp ${args.positional.join(" ")}`,
      overheadCeiling: config.overhead,
    });
    process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(`${response.stderr}\n`);
    return response.status;
  }
  if (!args.command) {
    const dashboard = await readDashboardSnapshot(config);
    process.stdout.write(renderDashboard(dashboard));
    return 0;
  }
  if (!args.storeUri && config.storeUri.startsWith("file://") && !existsSync(fileURLToPath(config.storeUri))) {
    if (wrapperCommand) return await runColdWrappedCommand(args, config, residentPaths.rootDir);
    process.stdout.write(renderStructuredError({
      command: telemetryCommand(args) || "rsp",
      category: "real-error",
      error: "rsp repo store is not provisioned",
      help: "/red-setup",
    }));
    return 1;
  }
  const { residentConfigFor, residentElisionStore, reportResidentEntryDiagnostic } = await import("../resident-store.js");
  const openResidentStore = (ensureResident = true) =>
    Promise.resolve(residentElisionStore(process.cwd(), config, { ensureResident, paths: residentPaths }));
  // A warm that cannot find an rsp entry is the silent-elision-loss failure
  // (#2736): it names itself once, then the command runs on regardless.
  const warmResidentStore = () =>
    ensureResidentServer(residentPaths, residentConfigFor(config, buildInfo.version))
      .catch((err: unknown) => void reportResidentEntryDiagnostic(err));
  // Reads go through the resident too: one core owns the store, so `show` and
  // `gains` ask it rather than opening a second handle on the same file.
  const openReadStore = () => openResidentStore();
  let closeStore: (() => Promise<void>) | undefined;
  try {
    if (args.command === "stats") {
      const { stats, telemetry } = await readStatsSnapshot(config, sinceDays(args.positional, 30));
      const { overheadHealth } = await import("../overhead-budget.js");
      process.stdout.write(renderStats(
        stats,
        telemetry,
        statsFull(args.positional),
        overheadHealth(residentPaths.rootDir, config.overhead),
      ));
      return 0;
    }

    if (args.command === "gains") {
      const store = await openReadStore();
      closeStore = () => store.close();
      // A store without the telemetry lanes has no gains to report — the
      // resident says so, and that stays a clean exit 1, not a stack trace.
      let report;
      try {
        report = await store.telemetryGains(sinceDays(args.positional, 28));
      } catch (err) {
        process.stdout.write(renderStructuredError({
          command: `rsp ${args.positional.join(" ")}`.trim(),
          category: "real-error",
          error: err instanceof Error ? err.message : "rsp gains unavailable",
          help: "rsp gains requires the shared RedDB store",
        }));
        return 1;
      }
      process.stdout.write(renderGainsReportToon(report));
      return 0;
    }

    if (args.command === "git") {
      fireAndForget(warmResidentStore());
      if (isFastGitStatus(args.positional)) {
        const started = process.hrtime.bigint();
        return await emitWrappedResult(args, await runFastGitStatus(), started, undefined, residentPaths.rootDir, config);
      }
      const { runGitWrapper } = await import("../git-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runGitWrapper(args.positional, {
        level: args.level,
        store,
        heavyGitByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir, config);
    }

    if (args.command === "gh") {
      fireAndForget(warmResidentStore());
      const { runGhWrapper } = await import("../gh-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runGhWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir, config);
    }

    if (args.command === "vitest" || args.command === "cargo") {
      fireAndForget(warmResidentStore());
      const { runTestWrapper } = await import("../test-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runTestWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir, config);
    }

    if (args.command === "cat") {
      fireAndForget(warmResidentStore());
      const { runCatWrapper } = await import("../cat-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runCatWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir, config);
    }

    if (args.command === "exec") {
      fireAndForget(warmResidentStore());
      const { runExecWrapper } = await import("../exec-wrapper.js");
      const store = new LazyRspElisionStore(() => openResidentStore(false));
      closeStore = () => store.close();
      const started = process.hrtime.bigint();
      const result = await runExecWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, residentPaths.rootDir, config);
    }

    if (args.command === "show" && args.handle) {
      const store = await openReadStore();
      closeStore = () => store.close();
      const record = await store.get(args.handle);
      if (record && "original" in record && record.original) {
        process.stdout.write(record.original);
        await appendShowAccountingEvent(residentPaths.rootDir, args.handle, true, record.original.length);
        return 0;
      }
      if (record?.status === "expired") {
        const text = renderStructuredError({
          command: `rsp show ${args.handle}`,
          category: "real-error",
          error: `expired ${record.expired_at}`,
          help: record.command,
        });
        process.stdout.write(text);
        await appendShowAccountingEvent(residentPaths.rootDir, args.handle, false, text.length);
        return 1;
      }
      const text = renderStructuredError({
        command: `rsp show ${args.handle}`,
        category: "real-error",
        error: "expired unknown",
        help: args.handle,
      });
      process.stdout.write(text);
      await appendShowAccountingEvent(residentPaths.rootDir, args.handle, false, text.length);
      return 1;
    }

    process.stdout.write(renderStructuredError({
      command: args.positional.join(" ") || "rsp",
      category: "usage",
      error: "usage rsp show el:<id>",
      help: "rsp show el:<id>",
    }));
    return 2;
  } catch (err) {
    if (isStructuredUsageRenderable(err)) {
      process.stdout.write(err.render());
      return 2;
    }
    if (wrapperCommand) return await degradeToPassthrough("wrapper failed", args.positional, err, residentPaths.rootDir);
    throw err;
  } finally {
    await closeStore?.();
  }
}

export { main };
