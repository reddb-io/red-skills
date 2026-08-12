import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseEntryIntent } from "./cli/args.js";
import { renderCliHelp } from "./cli/help.js";

/** Answer help/version before dispatch, configuration, state, or resident work. */
export function answerFrontDoor(argv: readonly string[]): number | null {
  const intent = parseEntryIntent(argv);
  if (intent.kind === "version") {
    const info = readBuildInfo("rsp");
    process.stdout.write(intent.json ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
    return 0;
  }
  if (intent.kind === "help") {
    process.stdout.write(renderCliHelp(argv));
    return 0;
  }
  return null;
}
