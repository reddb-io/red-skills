import { parseRecords } from "@reddb-io/toon";

export function setupFailureExcerpt(log: string | null | undefined): string | undefined {
  const raw = log ?? "";
  let readable = raw;
  try {
    const messages = parseRecords(raw)
      .map((record) => record.msg)
      .filter((message): message is string => typeof message === "string");
    if (messages.length > 0) readable = messages.join("\n");
  } catch {
    // Legacy plaintext logs remain readable during the disposable-lane cutover.
  }
  const lines = readable
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[heartbeat]"));
  let setupFailure = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (
      /command failed in sandbox/i.test(line) ||
      /(?:sandbox|bootstrap|setup).*(?:error|fail)/i.test(line)
    ) {
      setupFailure = index;
      break;
    }
  }
  if (setupFailure < 0) return undefined;
  return lines.slice(setupFailure, setupFailure + 4).join("\n");
}
