import { isUtf8 } from "node:buffer";
import type { ChildProcess } from "node:child_process";

export type CompletedStdoutTransform = (stdout: Buffer) => Buffer | Promise<Buffer>;

/** Capture one command to completion, transform only final stdout, then emit. */
export async function runCompletedChild(
  child: ChildProcess,
  transform: CompletedStdoutTransform = (stdout) => stdout,
): Promise<number> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));

  return await new Promise((resolve) => {
    let finished = false;
    const finish = async (status: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return;
      finished = true;
      const originalStdout = Buffer.concat(stdout);
      let renderedStdout: Buffer = originalStdout;
      if (originalStdout.length > 0 && isUtf8(originalStdout)) {
        try {
          renderedStdout = await transform(originalStdout);
        } catch {
          // The boundary is fail-open even if an unexpected dependency fails.
        }
      }
      process.stdout.write(renderedStdout);
      process.stderr.write(Buffer.concat(stderr));
      if (signal) {
        process.kill(process.pid, signal);
        resolve(128);
        return;
      }
      resolve(status ?? 0);
    };
    child.once("error", (error) => {
      stderr.push(Buffer.from(`${error instanceof Error ? error.message : String(error)}\n`));
      void finish(127, null);
    });
    child.once("close", (status, signal) => void finish(status, signal));
  });
}
