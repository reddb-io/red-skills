import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Port-builder shape (#2667). This file used to assert a 1200-line budget over
 * every run module — a proxy metric that said nothing about whether the
 * assembly was actually decomposed, and that a single fat builder satisfies.
 * The real invariant is CONTEXT ISOLATION: each `commands/run/ports/*` builder
 * binds ONE effectful context, so `buildProcessDeps` is pure composition and a
 * builder can be unit-tested over one fake. `lookups` and `envelope` are the
 * two declared multi-context exceptions.
 */

const PORTS_DIR = join(process.cwd(), "src", "commands", "run", "ports");

/** Which contexts each builder module is allowed to bind. */
const ALLOWED_CONTEXTS: Record<string, readonly ("gh" | "git")[]> = {
  "gh.ts": ["gh"],
  "git.ts": ["git"],
  "fs.ts": [],
  "hooks.ts": [],
  // The declared multi-context ports: the envelope posts (gh) the head it
  // stamps (git), and lookups spans base/guidance/branch probes.
  "envelope.ts": ["gh", "git"],
  "lookups.ts": ["gh", "git"],
};

function boundContexts(source: string): ("gh" | "git")[] {
  const bound: ("gh" | "git")[] = [];
  if (/\bGhContext\b/.test(source)) bound.push("gh");
  if (/\bGitContext\b/.test(source)) bound.push("git");
  return bound;
}

describe("run command port builders", () => {
  it("binds one effectful context per builder, with lookups/envelope the declared exceptions", () => {
    const bound = Object.fromEntries(
      Object.keys(ALLOWED_CONTEXTS).map((file) => [
        file,
        boundContexts(readFileSync(join(PORTS_DIR, file), "utf8")),
      ]),
    );

    expect(bound).toEqual(ALLOWED_CONTEXTS);
  });
});
