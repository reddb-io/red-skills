/**
 * The declared-wait invariant: every wait loop in the engine is declared with
 * its subject, its deadline and its escalation (issue #3024, Spec #3022).
 *
 * Four properties are load-bearing. A poll loop the declaration does not name
 * FAILS — that is the red-first fixture, and the reason the next eternal poll
 * cannot land. The scan actually reaches the tree, because a walker that reads
 * nothing is green by accident. The live inventory matches the live source in
 * BOTH directions, so the list stays an inventory rather than drifting into
 * fiction. And every declared wait either names a heartbeat sink wired in its
 * own module or argues its silence — proven concretely for the landing waits,
 * which are the ones #2985 was written about.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectWaitLoopSites,
  DECLARED_WAITS,
  findWaitDeclarationViolations,
  formatWaitDeclarationFailure,
  isExcludedWaitPath,
  readWaitScanFiles,
  WAIT_SCAN_ROOTS,
  type DeclaredWait,
  type WaitScanFile,
} from "../src/core/declared-wait-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function file(path: string, sourceText: string): WaitScanFile {
  return { path, sourceText };
}

const DECLARED_DEMO: DeclaredWait = {
  path: "apps/demo/src/poll.ts",
  fn: "awaitThing",
  subject: "the thing",
  deadline: "10 polls",
  escalation: "returns null",
  heartbeat: { silent: "a demo" },
};

describe("the live engine declares every wait it holds (#3024)", () => {
  it("is green on the real engine trees", () => {
    const files = readWaitScanFiles(ROOT);
    const violations = findWaitDeclarationViolations(collectWaitLoopSites(files), DECLARED_WAITS, files);

    expect(violations, formatWaitDeclarationFailure(violations)).toEqual([]);
  });

  it("scanned the tree — a walker that reaches nothing is green by accident", () => {
    const files = readWaitScanFiles(ROOT);

    expect(files.length).toBeGreaterThan(200);
    expect(collectWaitLoopSites(files).length).toBeGreaterThanOrEqual(DECLARED_WAITS.length);
  });

  it("skips tests and its own module — a fixture poll is not an engine wait", () => {
    expect(isExcludedWaitPath("apps/dev/tests/merge.test.ts")).toBe(true);
    expect(isExcludedWaitPath("apps/dev/src/core/foo.test.ts")).toBe(true);
    expect(isExcludedWaitPath("apps/dev/src/core/declared-wait-guard.ts")).toBe(true);
    expect(isExcludedWaitPath("apps/dev/src/core/merge.ts")).toBe(false);
  });

  it("declares the landing waits by name", () => {
    const keys = DECLARED_WAITS.map((wait) => `${wait.path} ${wait.fn}`);

    expect(keys).toContain("packages/red-castle/src/engine/land-lock.ts acquire");
    expect(keys).toContain("apps/dev/src/core/merge.ts waitForMergeReadyWithEvidence");
    expect(keys).toContain("apps/dev/src/core/merge.ts waitForQueuedMerge");
    expect(keys).toContain("apps/dev/src/core/merge.ts waitForReviewCheck");
  });

  it("names an escalation for every declared wait — a wait with none is a hang with extra steps", () => {
    for (const wait of DECLARED_WAITS) {
      expect(wait.subject.length, `${wait.path} ${wait.fn}`).toBeGreaterThan(0);
      expect(wait.deadline.length, `${wait.path} ${wait.fn}`).toBeGreaterThan(0);
      expect(wait.escalation.length, `${wait.path} ${wait.fn}`).toBeGreaterThan(0);
    }
  });

  it("scans the engine packages, and says which", () => {
    expect(WAIT_SCAN_ROOTS).toEqual(["apps/dev/src", "packages/red-castle/src"]);
  });
});

describe("an undeclared poll loop is the failure (#3024)", () => {
  it("fails on a new eternal poll, naming the file, the line and the function", () => {
    const files = [
      file(
        "apps/demo/src/wedge.ts",
        [
          "export async function awaitTheThing(deps) {",
          "  for (;;) {",
          "    if (await deps.ready()) return true;",
          "    await deps.sleep(1000);",
          "  }",
          "}",
        ].join("\n"),
      ),
    ];

    const violations = findWaitDeclarationViolations(collectWaitLoopSites(files), [], files);

    expect(violations).toEqual([
      {
        kind: "undeclared",
        path: "apps/demo/src/wedge.ts",
        fn: "awaitTheThing",
        line: 4,
        snippet: "await deps.sleep(1000);",
      },
    ]);

    const message = formatWaitDeclarationFailure(violations);
    expect(message).toContain("apps/demo/src/wedge.ts:4");
    expect(message).toContain("awaitTheThing");
    expect(message).toContain("SUBJECT");
    expect(message).toContain("DEADLINE");
    expect(message).toContain("ESCALATION");
  });

  it("passes once that same loop is declared", () => {
    const files = [
      file(
        "apps/demo/src/poll.ts",
        "export async function awaitThing(d) { while (!d.done) { await d.sleep(5); } }",
      ),
    ];

    expect(findWaitDeclarationViolations(collectWaitLoopSites(files), [DECLARED_DEMO], files)).toEqual([]);
  });

  it("sees the `for (;;)` shape, whose header semicolons hid the engine's commonest poll", () => {
    const sites = collectWaitLoopSites([
      file("apps/demo/src/forever.ts", "async function spin(c) {\n  for (;;) {\n    await c.sleep(1);\n  }\n}"),
    ]);

    expect(sites.map((site) => site.fn)).toEqual(["spin"]);
  });

  it("sees a wait hidden behind a helper name, with no clock call in sight", () => {
    const sites = collectWaitLoopSites([
      file("apps/demo/src/tick.ts", "async function run(d) {\n  for (;;) {\n    await waitForNextWake(d);\n  }\n}"),
    ]);

    expect(sites.map((site) => site.fn)).toEqual(["run"]);
  });

  it("does not read a sleep OUTSIDE a loop as a wait loop", () => {
    const sites = collectWaitLoopSites([
      file("apps/demo/src/once.ts", "async function pause(d) {\n  await d.sleep(1000);\n}"),
    ]);

    expect(sites).toEqual([]);
  });

  it("does not read prose as a poll — a comment describing one is documentation", () => {
    const sites = collectWaitLoopSites([
      file(
        "apps/demo/src/doc.ts",
        "// for (;;) { await sleep(1) } is the shape a hang wears\nexport const NOTE = 1;",
      ),
    ]);

    expect(sites).toEqual([]);
  });

  it("does not read a message NAMING a sleep as one", () => {
    const sites = collectWaitLoopSites([
      file(
        "apps/demo/src/msg.ts",
        'function report(items) {\n  for (const i of items) {\n    log("await sleep(1000) never returned");\n  }\n}',
      ),
    ]);

    expect(sites).toEqual([]);
  });

  it("keeps a function its name when its signature holds a default `= {}`", () => {
    const sites = collectWaitLoopSites([
      file(
        "apps/demo/src/drain.ts",
        "export async function drain(pid: number, options: { pollMs?: number } = {}): Promise<boolean> {\n" +
          "  for (let i = 0; i < 5; i += 1) {\n    await sleep(options.pollMs ?? 10);\n  }\n  return true;\n}",
      ),
    ]);

    expect(sites.map((site) => site.fn)).toEqual(["drain"]);
  });
});

describe("the inventory stays an inventory (#3024)", () => {
  it("fails on a declared wait whose loop is gone", () => {
    const violations = findWaitDeclarationViolations([], [DECLARED_DEMO], []);

    expect(violations).toEqual([
      { kind: "stale", path: "apps/demo/src/poll.ts", fn: "awaitThing", subject: "the thing" },
    ]);
    expect(formatWaitDeclarationFailure(violations)).toContain("delete the entry with the loop");
  });

  it("fails on a declared heartbeat sink the module never references", () => {
    const files = [
      file("apps/demo/src/poll.ts", "async function awaitThing(d) { while (!d.done) { await d.sleep(5); } }"),
    ];
    const declared: DeclaredWait[] = [{ ...DECLARED_DEMO, heartbeat: { sink: "onWait" } }];

    const violations = findWaitDeclarationViolations(collectWaitLoopSites(files), declared, files);

    expect(violations).toEqual([
      {
        kind: "voiceless",
        path: "apps/demo/src/poll.ts",
        fn: "awaitThing",
        subject: "the thing",
        sink: "onWait",
      },
    ]);
    expect(formatWaitDeclarationFailure(violations)).toContain("VOICELESS");
  });

  it("does not accept a sink that only appears in a comment", () => {
    const files = [
      file(
        "apps/demo/src/poll.ts",
        "// callers wire onWait to watch this\nasync function awaitThing(d) { while (!d.done) { await d.sleep(5); } }",
      ),
    ];
    const declared: DeclaredWait[] = [{ ...DECLARED_DEMO, heartbeat: { sink: "onWait" } }];

    expect(findWaitDeclarationViolations(collectWaitLoopSites(files), declared, files)[0]?.kind).toBe(
      "voiceless",
    );
  });

  it("accepts a sink the module actually fires", () => {
    const files = [
      file(
        "apps/demo/src/poll.ts",
        "async function awaitThing(d) { while (!d.done) { d.onWait?.({ subject: d.what }); await d.sleep(5); } }",
      ),
    ];
    const declared: DeclaredWait[] = [{ ...DECLARED_DEMO, heartbeat: { sink: "onWait" } }];

    expect(findWaitDeclarationViolations(collectWaitLoopSites(files), declared, files)).toEqual([]);
  });
});

describe("every declared wait speaks, or argues its silence (#3024, generalizing #2985)", () => {
  it("gives each wait either a wired sink or a stated reason for saying nothing", () => {
    for (const wait of DECLARED_WAITS) {
      const stated = wait.heartbeat.sink ?? wait.heartbeat.silent;

      expect(stated, `${wait.path} ${wait.fn} declares neither a sink nor a silence`).toBeTruthy();
      expect(stated!.length).toBeGreaterThan(0);
    }
  });

  it("gives the landing waits a heartbeat — silence is not an option where #2985 happened", () => {
    const landing = DECLARED_WAITS.filter(
      (wait) =>
        wait.path === "apps/dev/src/core/merge.ts" ||
        wait.path === "packages/red-castle/src/engine/land-lock.ts",
    );

    expect(landing.length).toBeGreaterThanOrEqual(4);
    for (const wait of landing) {
      expect(wait.heartbeat.sink, `${wait.path} ${wait.fn} waits silently`).toBeTruthy();
    }
  });

  it("makes the landing waits' heartbeats name their subject, on the live modules", () => {
    const files = readWaitScanFiles(ROOT);
    const landLock = files.find((entry) => entry.path.endsWith("engine/land-lock.ts"))!;
    const merge = files.find((entry) => entry.path === "apps/dev/src/core/merge.ts")!;

    // The lock wait says WHICH lock, WHO holds it, and how long is left.
    expect(landLock.sourceText).toContain("interface LandLockWaitInfo");
    for (const field of ["path", "heldBy", "heldByPid", "waitedMs", "remainingMs", "attempt"]) {
      expect(landLock.sourceText, `land-lock heartbeat drops ${field}`).toContain(`${field}:`);
    }
    // The merge waits say WHICH pr, and where in the budget the poll is.
    expect(merge.sourceText).toContain("onPoll");
    for (const field of ["prNumber", "attempt", "maxPolls", "intervalMs"]) {
      expect(merge.sourceText, `merge heartbeat drops ${field}`).toContain(field);
    }
  });
});

describe("the invariant runs in every gate run", () => {
  it("is declared in REPO_INVARIANT_SUITES so a cone-scoped gate still runs it", () => {
    const declared = REPO_INVARIANT_SUITES.find((suite) => suite.name === "invariants:declared-waits");

    expect(declared?.scope).toBe("apps/dev");
    expect(declared?.script).toBe("test:invariants");
  });
});
