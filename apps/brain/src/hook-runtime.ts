import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withBrainRuntime } from "./runtime.js";

export type Runner = "codex" | "claude" | "hermes" | "unknown";

export async function handleHook(lifecycle: string, runner: Runner): Promise<Record<string, unknown>> {
  if (lifecycle !== "SessionStart") return {};
  const config = await withBrainRuntime(async ({ config, store }) => {
    await store.status();
    return config;
  });
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
