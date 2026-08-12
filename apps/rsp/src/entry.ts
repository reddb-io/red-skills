#!/usr/bin/env node
import { runFastBoundary, resolveFastBoundary } from "./fast-boundary.js";
import { answerFrontDoor } from "./front-door.js";
import type { main as CoreMain } from "./cli/main.js";
import type { renderCliFailure as RenderCliFailure } from "./core-entry.js";

interface RspCore {
  main: typeof CoreMain;
  renderStructuredBoundary(stdout: Buffer): Buffer;
  renderCliFailure: typeof RenderCliFailure;
}

async function loadCore(): Promise<RspCore> {
  return await import("./core-entry.js");
}

async function run(argv: readonly string[]): Promise<number> {
  const answered = answerFrontDoor(argv);
  if (answered !== null) return answered;
  const fast = resolveFastBoundary(argv);
  if (fast) return await runFastBoundary(fast, async (stdout) => (await loadCore()).renderStructuredBoundary(stdout));
  return await (await loadCore()).main([...argv]);
}

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, async (err) => {
  const failure = (await loadCore()).renderCliFailure(err);
  process.stdout.write(failure.output);
  process.exitCode = failure.status;
});
