import { basename } from "node:path";
import { resolveBrainConfig, type ResolvedBrainConfig } from "./config.js";
import { BrainStore } from "./store.js";

export interface BrainRuntime {
  config: ResolvedBrainConfig;
  store: BrainStore;
  project: string;
}

export async function openBrainRuntime(startDir = process.cwd()): Promise<BrainRuntime> {
  const config = await resolveBrainConfig(startDir);
  const store = await BrainStore.open({ uri: config.connectionString });
  return {
    config,
    store,
    project: basename(config.rootDir),
  };
}

export async function withBrainRuntime<T>(
  fn: (runtime: BrainRuntime) => Promise<T>,
  startDir = process.cwd(),
): Promise<T> {
  const runtime = await openBrainRuntime(startDir);
  try {
    return await fn(runtime);
  } finally {
    await runtime.store.close();
  }
}
