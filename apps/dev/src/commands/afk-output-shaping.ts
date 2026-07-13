import { join } from "node:path";
import {
  buildOutputShapingReport,
  collectOutputShapingSamples,
  renderOutputShapingReport,
  renderOutputShapingReportToon,
} from "../core/output-shaping-report.js";
import { resolveRepoContext } from "../runtime/wire.js";

type Format = "toon" | "json" | "human";

export async function afkOutputShapingCommand(args: readonly string[]): Promise<number> {
  let format: Format = "toon";
  let root = (await resolveRepoContext(process.cwd())).root;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--toon") {
      format = "toon";
      continue;
    }
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--human") {
      format = "human";
      continue;
    }
    if (arg === "--root") {
      const value = args[++i];
      if (!value) throw new Error("--root requires a value");
      root = value;
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      continue;
    }
    throw new Error(`unknown afk-output-shaping argument: ${arg}`);
  }

  const report = buildOutputShapingReport(collectOutputShapingSamples(join(root, ".red", "tmp")));
  const output =
    format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : format === "human"
        ? renderOutputShapingReport(report)
        : `${renderOutputShapingReportToon(report)}\n`;
  process.stdout.write(output);
  return 0;
}
