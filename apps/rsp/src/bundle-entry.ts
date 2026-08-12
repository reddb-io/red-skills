#!/usr/bin/env node
import { runFastBoundary, resolveFastBoundary } from "./fast-boundary.js";
import { answerFrontDoor } from "./front-door.js";

interface RspCore {
  main(argv: string[]): Promise<number>;
  renderCliFailure(err: unknown): { output: Buffer; status: number };
}

async function loadCore(): Promise<RspCore> {
  return await import(resolveCoreAsset(import.meta.url)) as RspCore;
}

export function resolveCoreAsset(entryUrl: string): string {
  const url = new URL(entryUrl);
  const versioned = /\/rsp-([^/]+)\.bundle\.min\.mjs$/.exec(url.pathname);
  url.pathname = versioned
    ? url.pathname.replace(/\/rsp-[^/]+\.bundle\.min\.mjs$/, `/rsp-core-${versioned[1]}.bundle.min.mjs`)
    : url.pathname.replace(/\/rsp\.bundle\.min\.mjs$/, "/rsp-core.bundle.min.mjs");
  return url.href;
}

async function run(argv: readonly string[]): Promise<number> {
  const answered = answerFrontDoor(argv);
  if (answered !== null) return answered;
  const fast = resolveFastBoundary(argv);
  if (fast) return await runFastBoundary(fast);
  return await (await loadCore()).main([...argv]);
}

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, async (err) => {
  const failure = (await loadCore()).renderCliFailure(err);
  process.stdout.write(failure.output);
  process.exitCode = failure.status;
});
