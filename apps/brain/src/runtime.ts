import { basename } from "node:path";
import { pingResident, resolveResidentPaths } from "@reddb-io/shared/resident-client.js";
import { createConfiguredAfkHeadlessAutoLinkProvider } from "@reddb-io/brain-store/auto-linker.js";
import { resolveBrainConfig, type ResolvedBrainConfig } from "@reddb-io/brain-store/config.js";
import { openResidentBrainStore, shouldUseResidentBrain } from "./resident-brain.js";
import { BrainStore, type BrainStoreLike } from "@reddb-io/brain-store/store.js";

export interface BrainRuntime {
  config: ResolvedBrainConfig;
  store: BrainStoreLike;
  project: string;
}

export async function openBrainRuntime(startDir = process.cwd()): Promise<BrainRuntime> {
  const config = await resolveBrainConfig(startDir);
  if (shouldUseResidentBrain(config)) {
    try {
      return {
        config,
        store: await openResidentBrainStore(config),
        project: basename(config.rootDir),
      };
    } catch (err) {
      const paths = resolveResidentPaths(config.rootDir);
      if (await pingResident(paths.socketPath, 50)) throw err;
    }
  }
  const store = await BrainStore.open({
    uri: config.connectionString,
    autoLinker: createConfiguredAfkHeadlessAutoLinkProvider(),
  });
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
