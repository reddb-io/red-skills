import type { RspRuntimeConfig } from "../config.js";
import type { RspElisionStore, RspMintMeta } from "../elision-store.js";
import { isStructuredUsageRenderable } from "./args.js";
import { emitWrappedResult } from "./invocation-telemetry.js";
import { degradeToPassthrough } from "./passthrough.js";
import type { ElisionStoreLike, ParsedArgs } from "./types.js";

export class LazyRspElisionStore implements ElisionStoreLike {
  private store?: Promise<ElisionStoreLike>;
  private metrics?: import("../resident-client.js").ResidentResponseMetrics;

  constructor(private readonly openStore: () => Promise<ElisionStoreLike>) {}

  async mint(...args: Parameters<RspElisionStore["mint"]>): Promise<string> {
    try {
      const store = await this.open();
      const handle = await store.mint(...args);
      this.metrics = store.lastResponseMetrics?.();
      return handle;
    } catch {
      return `recovery unavailable (resident cold) — re-run: ${args[1].command}`;
    }
  }

  async close(): Promise<void> {
    if (!this.store) return;
    let store: ElisionStoreLike;
    try {
      store = await this.store;
    } catch {
      return;
    }
    await store.close();
  }

  private open(): Promise<ElisionStoreLike> {
    this.store ??= this.openStore();
    return this.store;
  }

  lastResponseMetrics(): import("../resident-client.js").ResidentResponseMetrics | undefined {
    return this.metrics;
  }
}

class ColdRspElisionStore implements ElisionStoreLike {
  async mint(_original: Uint8Array | Buffer, meta: RspMintMeta): Promise<string> {
    return `recovery unavailable (cold store) — re-run: ${meta.command}`;
  }

  lastResponseMetrics(): import("../resident-client.js").ResidentResponseMetrics | undefined {
    return undefined;
  }

  async close(): Promise<void> {}
}

export async function runColdWrappedCommand(
  args: ParsedArgs,
  config: RspRuntimeConfig,
  telemetryRoot: string,
  err?: unknown,
): Promise<number> {
  if (process.env.RSP_DEBUG === "1") {
    throw err instanceof Error ? err : new Error("cold store");
  }

  const store = new ColdRspElisionStore();
  const started = process.hrtime.bigint();
  try {
    if (args.command === "git") {
      const { isFastGitStatus, runFastGitStatus } = await import("./fast-git.js");
      if (isFastGitStatus(args.positional)) {
        return await emitWrappedResult(args, await runFastGitStatus(), started, store, telemetryRoot, config);
      }
      const { runGitWrapper } = await import("../git-wrapper.js");
      const result = await runGitWrapper(args.positional, {
        level: args.level,
        store,
        heavyGitByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "gh") {
      const { runGhWrapper } = await import("../gh-wrapper.js");
      const result = await runGhWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "vitest" || args.command === "cargo") {
      const { runTestWrapper } = await import("../test-wrapper.js");
      const result = await runTestWrapper(args.positional, { level: args.level, store });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "cat") {
      const { runCatWrapper } = await import("../cat-wrapper.js");
      const result = await runCatWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store, telemetryRoot, config);
    }

    if (args.command === "exec") {
      const { runExecWrapper } = await import("../exec-wrapper.js");
      const result = await runExecWrapper(args.positional, {
        level: args.level,
        store,
        heavyByteThreshold: config.heavyGitByteThreshold,
      });
      return await emitWrappedResult(args, result, started, store);
    }
  } catch (coldErr) {
    if (isStructuredUsageRenderable(coldErr)) {
      process.stdout.write(coldErr.render());
      return 2;
    }
    return await degradeToPassthrough("wrapper failed", args.positional, coldErr, telemetryRoot);
  } finally {
    await store.close();
  }

  return await degradeToPassthrough("wrapper failed", args.positional, err, telemetryRoot);
}
