/**
 * The shipped-primitive invariant: a declared safety primitive whose only
 * enabler is a test file fails here (issue #2800).
 *
 * The gh quota backoff was implemented, tested and never enabled — the suite
 * injected the option, so a green gate reported protection the binary did not
 * have. Three properties are load-bearing: a test-only enabler FAILS and names
 * the test that supplied the false confidence, a shipped enabler passes, and the
 * scan actually reaches the tree (a walker that reads nothing is green by
 * accident, which is what makes a ratchet decorative).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectShippedPrimitiveCallers,
  findShippedPrimitiveViolations,
  formatShippedPrimitiveFailureMessage,
  isTestPath,
  readShippedPrimitiveFiles,
  SHIPPED_PRIMITIVES,
  type ShippedPrimitive,
  type ShippedPrimitiveFile,
} from "../src/core/shipped-primitive-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const PRIMITIVE: ShippedPrimitive = {
  id: "demo-backoff",
  what: "the demo bounded retry",
  definedIn: "apps/demo/src/backoff.ts",
  enabler: /\bresolveDemoBackoff\b/,
  consequence: "a demo call dies on a transient failure instead of retrying",
};

function file(relativePath: string, sourceText: string): ShippedPrimitiveFile {
  return { relativePath, sourceText, isTest: isTestPath(relativePath) };
}

const DEFINITION = file(
  "apps/demo/src/backoff.ts",
  `export function resolveDemoBackoff(injected) { return injected ?? {}; }`,
);

describe("the live tree enables every declared safety primitive (#2800)", () => {
  it("is green on the real apps/ and packages/ trees", () => {
    const callers = collectShippedPrimitiveCallers(readShippedPrimitiveFiles(ROOT));
    const violations = findShippedPrimitiveViolations(callers);

    expect(violations, formatShippedPrimitiveFailureMessage(violations)).toEqual([]);
  });

  it("scanned the tree — a walker that reaches nothing is green by accident", () => {
    const files = readShippedPrimitiveFiles(ROOT);

    expect(files.length).toBeGreaterThan(200);
    // Both sides of the classification are populated: the whole invariant is
    // telling a shipped enabler from a test one.
    expect(files.some((entry) => entry.isTest)).toBe(true);
    expect(files.some((entry) => !entry.isTest)).toBe(true);
  });

  it("finds a non-test caller for the Worker's log-line publisher specifically (#3079)", () => {
    const callers = collectShippedPrimitiveCallers(readShippedPrimitiveFiles(ROOT));
    const shipped = callers.filter(
      (caller) => caller.primitiveId === "redskilled-worker-log-line" && !caller.isTest,
    );

    // The exact regression this entry exists for: the publisher shipped with one
    // hit in the whole tree — its own definition — while HOST-NOTES.md described
    // it as a working feature.
    expect(shipped.map((caller) => caller.relativePath)).toEqual(
      expect.arrayContaining(["apps/dev/src/runtime/redskilled-worker-log.ts"]),
    );
  });

  it("finds a non-test enabler for the gh quota backoff specifically", () => {
    const callers = collectShippedPrimitiveCallers(readShippedPrimitiveFiles(ROOT));
    const shipped = callers.filter((caller) => caller.primitiveId === "gh-quota-backoff" && !caller.isTest);

    expect(shipped.map((caller) => caller.relativePath)).toEqual(
      expect.arrayContaining(["apps/dev/src/runtime/git.ts", "apps/dev/src/runtime/gh/common.ts"]),
    );
  });
});

describe("the test-only shape is the failure (#2800)", () => {
  it("fails when only a test enables the primitive, and names that test", () => {
    const callers = collectShippedPrimitiveCallers(
      [
        DEFINITION,
        file("apps/demo/tests/backoff.test.ts", `import { resolveDemoBackoff } from "../src/backoff.js";`),
      ],
      [PRIMITIVE],
    );
    const violations = findShippedPrimitiveViolations(callers, [PRIMITIVE]);

    expect(violations).toEqual([
      { primitiveId: "demo-backoff", kind: "test-only", testCallers: ["apps/demo/tests/backoff.test.ts"] },
    ]);

    const message = formatShippedPrimitiveFailureMessage(violations, [PRIMITIVE]);
    expect(message).toContain("apps/demo/tests/backoff.test.ts");
    expect(message).toContain("a demo call dies on a transient failure instead of retrying");
  });

  it("passes as soon as one shipped file enables it", () => {
    const callers = collectShippedPrimitiveCallers(
      [
        DEFINITION,
        file("apps/demo/tests/backoff.test.ts", `resolveDemoBackoff(fake)`),
        file("apps/demo/src/client.ts", `const opts = resolveDemoBackoff(ctx.backoff);`),
      ],
      [PRIMITIVE],
    );

    expect(findShippedPrimitiveViolations(callers, [PRIMITIVE])).toEqual([]);
  });

  it("reports `unreferenced` when nothing outside the module names the enabler", () => {
    const callers = collectShippedPrimitiveCallers([DEFINITION], [PRIMITIVE]);

    expect(findShippedPrimitiveViolations(callers, [PRIMITIVE])).toEqual([
      { primitiveId: "demo-backoff", kind: "unreferenced", testCallers: [] },
    ]);
  });

  it("does not count the defining module's own text as an enabler", () => {
    const callers = collectShippedPrimitiveCallers(
      [file("apps/demo/src/backoff.ts", `export function resolveDemoBackoff() {}\nresolveDemoBackoff();`)],
      [PRIMITIVE],
    );

    expect(callers).toEqual([]);
  });

  it("does not count prose — a comment describing the wiring is not the wiring", () => {
    const callers = collectShippedPrimitiveCallers(
      [
        DEFINITION,
        file("apps/demo/src/client.ts", `// every call goes through resolveDemoBackoff by default\nrun();`),
      ],
      [PRIMITIVE],
    );

    expect(findShippedPrimitiveViolations(callers, [PRIMITIVE])[0]?.kind).toBe("unreferenced");
  });
});

describe("the invariant runs in every gate run", () => {
  it("is declared in REPO_INVARIANT_SUITES so a cone-scoped gate still runs it", () => {
    const declared = REPO_INVARIANT_SUITES.find((suite) => suite.name === "invariants:shipped-primitives");

    expect(declared?.scope).toBe("apps/dev");
    expect(declared?.script).toBe("test:invariants");
  });

  it("declares at least the gh quota backoff", () => {
    expect(SHIPPED_PRIMITIVES.map((primitive) => primitive.id)).toContain("gh-quota-backoff");
  });
});
