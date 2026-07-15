import { resolve } from "node:path";
import {
  convertRegisteredToonSurfaces,
  type RegisteredToonSurfacePlugin,
} from "@reddb-io/shared/toon-migration.js";

interface ToonMigrateIO {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

interface ParsedToonMigrateArgs {
  rootDir: string;
  plugin?: RegisteredToonSurfacePlugin;
  json: boolean;
}

const PLUGINS = new Set<RegisteredToonSurfacePlugin>(["memory", "brain", "dev"]);

export async function toonMigrateCommand(
  args: readonly string[],
  io: ToonMigrateIO = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  try {
    const parsed = parseToonMigrateArgs(args);
    const report = await convertRegisteredToonSurfaces({ rootDir: parsed.rootDir, plugin: parsed.plugin });
    if (parsed.json) {
      io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else if (report.status === "refused") {
      io.stderr.write(`toon-migrate: refused: ${report.reasons.join("; ")}\n`);
    } else {
      io.stdout.write(
        `toon-migrate: ${report.status} converted=${report.converted.length} skipped=${report.skipped.length} missing=${report.missing.length}\n`,
      );
    }
    return report.status === "refused" ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`toon-migrate: ${message}\n`);
    return 2;
  }
}

function parseToonMigrateArgs(args: readonly string[]): ParsedToonMigrateArgs {
  let rootDir = process.cwd();
  let plugin: RegisteredToonSurfacePlugin | undefined;
  let json = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--root") {
      rootDir = requiredValue(args[++i], "--root");
      continue;
    }
    if (arg.startsWith("--root=")) {
      rootDir = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--plugin") {
      plugin = parsePlugin(requiredValue(args[++i], "--plugin"));
      continue;
    }
    if (arg.startsWith("--plugin=")) {
      plugin = parsePlugin(arg.slice("--plugin=".length));
      continue;
    }
    if (arg === "--triggered-by") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--triggered-by=")) {
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return { rootDir: resolve(rootDir), plugin, json };
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePlugin(value: string): RegisteredToonSurfacePlugin {
  if (PLUGINS.has(value as RegisteredToonSurfacePlugin)) return value as RegisteredToonSurfacePlugin;
  throw new Error(`unknown plugin: ${value}`);
}
