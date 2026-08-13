import { injectClaudePathBriefs } from "../core/path-brief-hook.js";

function pluginRootFromArgs(args: readonly string[]): string | undefined {
  const index = args.indexOf("--plugin-root");
  return index >= 0 ? args[index + 1] : undefined;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Claude PostToolUse adapter for first-touch path brief delivery. */
export async function pathBriefCommand(args: readonly string[]): Promise<number> {
  const pluginRoot = pluginRootFromArgs(args);
  if (!pluginRoot) {
    process.stdout.write("{}\n");
    return 0;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    process.stdout.write("{}\n");
    return 0;
  }

  const output = await injectClaudePathBriefs(payload as Parameters<typeof injectClaudePathBriefs>[0], { pluginRoot });
  process.stdout.write(`${JSON.stringify(output)}\n`);
  return 0;
}
