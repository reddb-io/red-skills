/**
 * The declared-config-consumer invariant: a configuration reader whose only
 * callers are tests fails here (#4293).
 *
 * `readStandingDrain` shipped with one re-export and three assertions naming it
 * and no production caller at all, so a repository that declared
 * `plugins.dev.afk.standing` registered nothing and ran the governed default
 * runner instead of its declared one — with a green gate the whole time.
 *
 * Four properties are load-bearing: a test-only caller FAILS and names the test
 * that supplied the false confidence, a re-export does NOT count as a caller
 * (that is the line which made the dead reader look wired), the scan actually
 * reaches the tree, and the live tree passes.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectConfigReaderCalls,
  DECLARED_CONFIG_READERS,
  findConfigReaderViolations,
  formatConfigReaderFailureMessage,
  isReExportLine,
  readConfigReaderFiles,
  type ConfigReaderFile,
  type DeclaredConfigReader,
} from "../src/core/config-consumer-guard.js";
import { isTestPath } from "../src/core/shipped-primitive-guard.js";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const READER: DeclaredConfigReader = {
  id: "demo-block",
  keys: ["demo.block.mode"],
  definedIn: "apps/demo/src/demo-config.ts",
  reader: "readDemoBlock",
  consequence: "a repository that declared a demo block behaves exactly like one that declared nothing",
};

function file(relativePath: string, sourceText: string): ConfigReaderFile {
  return { relativePath, sourceText, isTest: isTestPath(relativePath) };
}

const DEFINITION = file(
  "apps/demo/src/demo-config.ts",
  `export function readDemoBlock(values) { return values["demo.block.mode"] ?? null; }`,
);

describe("the live tree reads every declared configuration key (#4293)", () => {
  it("is green on the real apps/ and packages/ trees", () => {
    const calls = collectConfigReaderCalls(readConfigReaderFiles(ROOT));
    const violations = findConfigReaderViolations(calls);

    expect(violations, formatConfigReaderFailureMessage(violations)).toEqual([]);
  });

  it("scanned the tree — a walker that reaches nothing is green by accident", () => {
    const files = readConfigReaderFiles(ROOT);

    expect(files.length).toBeGreaterThan(200);
    expect(files.some((entry) => entry.isTest)).toBe(true);
    expect(files.some((entry) => !entry.isTest)).toBe(true);
  });

  it("pins the standing drain's production call site by name", () => {
    const calls = collectConfigReaderCalls(readConfigReaderFiles(ROOT));
    const shipped = calls.filter((call) => call.readerId === "standing-drain" && !call.isTest);

    // The exact regression: before this landed the only non-test line naming
    // `readStandingDrain` outside its own module was a re-export in config.ts.
    expect(shipped.map((call) => call.relativePath)).toEqual(
      expect.arrayContaining(["apps/plugin-dev/src/core/standing-drain-declaration.ts"]),
    );
    expect(shipped.map((call) => call.relativePath)).not.toContain("apps/plugin-dev/src/core/config.ts");
  });

  it("declares the standing drain keys an operator actually writes", () => {
    const declared = DECLARED_CONFIG_READERS.find((reader) => reader.id === "standing-drain");

    expect(declared?.definedIn).toBe("apps/plugin-dev/src/core/standing-drain-config.ts");
    expect(declared?.keys).toEqual([
      "plugins.dev.afk.standing.runner",
      "plugins.dev.afk.standing.target",
    ]);
  });
});

describe("what counts as a consumer (#4293)", () => {
  it("fails when only a test calls the reader, and names that test", () => {
    const calls = collectConfigReaderCalls(
      [DEFINITION, file("apps/demo/tests/demo.test.ts", `expect(readDemoBlock({})).toBeNull();`)],
      [READER],
    );

    expect(findConfigReaderViolations(calls, [READER])).toEqual([
      { readerId: "demo-block", kind: "test-only", testCallers: ["apps/demo/tests/demo.test.ts"] },
    ]);

    const message = formatConfigReaderFailureMessage(
      findConfigReaderViolations(calls, [READER]),
      [READER],
    );
    expect(message).toContain("apps/demo/tests/demo.test.ts");
    expect(message).toContain("demo.block.mode");
    expect(message).toContain("behaves exactly like one that declared nothing");
  });

  it("does not count a re-export — that is the line which made the dead reader look wired", () => {
    const calls = collectConfigReaderCalls(
      [
        DEFINITION,
        file("apps/demo/src/config.ts", `export { readDemoBlock, type DemoBlock } from "./demo-config.js";`),
      ],
      [READER],
    );

    expect(findConfigReaderViolations(calls, [READER])).toEqual([
      { readerId: "demo-block", kind: "uncalled", testCallers: [] },
    ]);
    expect(isReExportLine(`export { readDemoBlock } from "./demo-config.js";`, "readDemoBlock")).toBe(true);
    expect(isReExportLine(`const mode = readDemoBlock(values);`, "readDemoBlock")).toBe(false);
  });

  it("does not count a bare import either — a binding nothing invokes reads the same as one that does", () => {
    const calls = collectConfigReaderCalls(
      [DEFINITION, file("apps/demo/src/client.ts", `import { readDemoBlock } from "./demo-config.js";`)],
      [READER],
    );

    expect(findConfigReaderViolations(calls, [READER])[0]?.kind).toBe("uncalled");
  });

  it("does not count prose — a comment describing the wiring is not the wiring", () => {
    const calls = collectConfigReaderCalls(
      [DEFINITION, file("apps/demo/src/client.ts", `// boot calls readDemoBlock(values) once\nrun();`)],
      [READER],
    );

    expect(findConfigReaderViolations(calls, [READER])[0]?.kind).toBe("uncalled");
  });

  it("passes as soon as one shipped file calls it", () => {
    const calls = collectConfigReaderCalls(
      [
        DEFINITION,
        file("apps/demo/tests/demo.test.ts", `readDemoBlock({})`),
        file("apps/demo/src/boot.ts", `const block = readDemoBlock(loadConfig(path));`),
      ],
      [READER],
    );

    expect(findConfigReaderViolations(calls, [READER])).toEqual([]);
  });

  it("does not count the defining module's own text as a caller", () => {
    const calls = collectConfigReaderCalls(
      [file("apps/demo/src/demo-config.ts", `export function readDemoBlock() {}\nreadDemoBlock();`)],
      [READER],
    );

    expect(calls).toEqual([]);
  });
});

describe("the invariant runs in every gate run", () => {
  it("is declared in REPO_INVARIANT_SUITES so a cone-scoped gate still runs it", () => {
    const declared = REPO_INVARIANT_SUITES.find(
      (suite) => suite.name === "invariants:declared-config-consumers",
    );

    expect(declared?.scope).toBe("apps/plugin-dev");
    expect(declared?.script).toBe("test:invariants");
  });
});
