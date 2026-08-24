// successor-proof — the supervised takeover's pre-repoint viability check.
//
// The self-spawn path stages its successor at a boot handshake; the supervised
// path has none — the incumbent exits and systemd is the only backstop, so an
// entry that cannot run costs five failed restarts and a dead unit (#3554's
// shape) unless it is refused BEFORE the unit is repointed.
import { spawn } from "node:child_process";

/** How long a cold successor gets to answer `--version` before the proof fails. */
export const DEFAULT_REDSKILLED_SUCCESSOR_PROOF_MS = 60_000;

/**
 * Prove a resolved entry actually runs the target version.
 *
 * `--version` is the one question every shipped binary answers without a
 * working machine, so it is the cheapest possible viability proof — and after
 * the running bundle is stabilized into the daemon home, the entry is a local
 * file and the proof costs about a second. A cold npx materialization is the
 * slow case, which is why the deadline is generous: warming that cache is
 * itself half the proof's value.
 */
export async function proveRedskilledSuccessorEntry(
  entry: { readonly command: string; readonly args: readonly string[] },
  expectedVersion: string,
  io: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = io.timeoutMs ?? DEFAULT_REDSKILLED_SUCCESSOR_PROOF_MS;
  const child = spawn(entry.command, [...entry.args, "--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const exitCode = await new Promise<number | null>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(
        `the ${expectedVersion} successor did not answer --version within ${timeoutMs}ms`,
      ));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`the ${expectedVersion} successor exited ${exitCode ?? "by signal"} answering --version`);
  }
  if (!stdout.includes(expectedVersion)) {
    throw new Error(
      `the successor answered --version with ${JSON.stringify(stdout.trim().slice(0, 120))}, ` +
        `not the expected ${expectedVersion}`,
    );
  }
}
