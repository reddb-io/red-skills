import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveBrainConfig } from "./config.js";
import { BrainStore } from "./store.js";

export type Runner = "codex" | "claude" | "hermes" | "unknown";

export async function handleHook(lifecycle: string, runner: Runner): Promise<Record<string, unknown>> {
  if (lifecycle !== "SessionStart") return {};
  const config = await resolveBrainConfig(process.cwd());
  const store = await BrainStore.open({ uri: config.connectionString });
  try {
    await store.status();
  } finally {
    await store.close();
  }
  const stateDir = join(config.rootDir, ".red", "brain", "sessions");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, "last-session.json"),
    JSON.stringify(
      {
        runner,
        lifecycle,
        rootDir: config.rootDir,
        connectionString: config.connectionString,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  return {};
}
