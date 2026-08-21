// config-consumer-guard — the ratchet that keeps a declared configuration key
// READ by shipped code, not merely parsed by a tested function (#4293).
//
// `readStandingDrain` was written correctly, refused an incomplete block
// correctly, and had no production caller at all: one re-export in `config.ts`
// and three assertions in `config.test.ts`. Every gate stayed green — the suite
// passed, the types checked — while a second repository declared
// `afk.standing: {runner, target}` with a maintainer comment asserting that the
// declaration is what registers the project, and the declaration registered
// nothing. Its Workers ran the governed default runner, not the declared one.
//
// **A CONFIG READER WHOSE ONLY CALLERS ARE TESTS IS A PROMISE THE PRODUCT
// CANNOT KEEP.** It is the sibling of the #2800 shape that
// `shipped-primitive-guard` refuses, and worse in one way: the operator has
// written the key down, so the product has told them it matters.
//
// The invariant is about the CALL, not the mention. Three things deliberately
// do not count:
//
//  - **A re-export is not a consumer.** `export { readStandingDrain } from …`
//    is the exact line that made the dead reader look wired.
//  - **An import is not a consumer.** A binding nothing invokes reads the same
//    as one that does, to grep and to a reviewer.
//  - **Prose is not a consumer.** Comments are stripped before matching, so a
//    header explaining where the value is used never stands in for the use.
//
// The tree walk is `shipped-primitive-guard`'s: one scan of `apps/` and
// `packages/`, two ratchets, and one definition of what a test file is.
import { stripComments } from "./extinct-source-guard.js";
import {
  readShippedPrimitiveFiles,
  type ShippedPrimitiveFile,
} from "./shipped-primitive-guard.js";

/** A source file the guard reads, flagged for whether a test runner owns it. */
export type ConfigReaderFile = ShippedPrimitiveFile;

export { readShippedPrimitiveFiles as readConfigReaderFiles };

/** A configuration reader whose keys an operator writes and expects to matter. */
export interface DeclaredConfigReader {
  /** Stable slug — the name the failure carries. */
  id: string;
  /** The configuration keys it turns into behaviour, as an operator spells them. */
  keys: readonly string[];
  /** Repo-relative module that DEFINES it. Its own text never counts as a caller. */
  definedIn: string;
  /** The exported reader function. A CALL of it, anywhere non-test, is the proof. */
  reader: string;
  /** What the operator loses while nothing calls it — read by a triaging human. */
  consequence: string;
}

/**
 * The declared readers. An entry belongs here when the key is OPT-IN and its
 * failure is silent: the operator writes the block, the product accepts it, and
 * a reader that is never called produces exactly the behaviour of a repository
 * that declared nothing.
 */
export const DECLARED_CONFIG_READERS: readonly DeclaredConfigReader[] = [
  {
    id: "standing-drain",
    keys: ["plugins.dev.afk.standing.runner", "plugins.dev.afk.standing.target"],
    definedIn: "apps/plugin-dev/src/core/standing-drain-config.ts",
    reader: "readStandingDrain",
    consequence:
      "a project that declared a standing drain registers nothing at MCP startup, and a `drain` that names no runner composes an argv with no `--child-agent` — so the declared executor is silently not the one that runs",
  },
];

/** Where a human edits the inventory, named in the failure message. */
export const DECLARED_CONFIG_READER_DECLARATION =
  "apps/plugin-dev/src/core/config-consumer-guard.ts (DECLARED_CONFIG_READERS)";

/** One file that CALLS a declared reader, and whether a test runner owns it. */
export interface ConfigReaderCall {
  readerId: string;
  relativePath: string;
  line: number;
  isTest: boolean;
}

export type ConfigReaderViolationKind = "test-only" | "uncalled";

/** A reader no shipped code calls, and which shape of gap it is. */
export interface ConfigReaderViolation {
  readerId: string;
  kind: ConfigReaderViolationKind;
  /** Test files that call it — the false confidence, when any. */
  testCallers: readonly string[];
}

/** True for a line that only forwards the name onward. PURE. */
export function isReExportLine(line: string, reader: string): boolean {
  return new RegExp(String.raw`^\s*export\s*(?:type\s+)?\{[^}]*\b${reader}\b[^}]*\}\s*from\b`).test(line);
}

/**
 * Every non-defining CALL of every declared reader. Sorted so a failure names
 * the same file first on every run. PURE.
 */
export function collectConfigReaderCalls(
  files: readonly ConfigReaderFile[],
  readers: readonly DeclaredConfigReader[] = DECLARED_CONFIG_READERS,
): ConfigReaderCall[] {
  const calls: ConfigReaderCall[] = [];
  for (const file of files) {
    const lines = stripComments(file.sourceText).split("\n");
    for (const reader of readers) {
      if (file.relativePath === reader.definedIn) continue;
      const call = new RegExp(String.raw`\b${reader.reader}\s*\(`);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!call.test(line) || isReExportLine(line, reader.reader)) continue;
        calls.push({
          readerId: reader.id,
          relativePath: file.relativePath,
          line: index + 1,
          isTest: file.isTest,
        });
      }
    }
  }
  return calls.sort(
    (a, b) =>
      a.readerId.localeCompare(b.readerId) ||
      a.relativePath.localeCompare(b.relativePath) ||
      a.line - b.line,
  );
}

/** Every reader with no non-test call, tagged with which gap it is. PURE. */
export function findConfigReaderViolations(
  calls: readonly ConfigReaderCall[],
  readers: readonly DeclaredConfigReader[] = DECLARED_CONFIG_READERS,
): ConfigReaderViolation[] {
  const violations: ConfigReaderViolation[] = [];
  for (const reader of readers) {
    const own = calls.filter((call) => call.readerId === reader.id);
    if (own.some((call) => !call.isTest)) continue;
    const testCallers = [...new Set(own.map((call) => call.relativePath))];
    violations.push({
      readerId: reader.id,
      kind: testCallers.length > 0 ? "test-only" : "uncalled",
      testCallers,
    });
  }
  return violations;
}

/**
 * The failure message the invariant assertion carries — the keys the operator
 * wrote, and what their repository does instead. PURE.
 */
export function formatConfigReaderFailureMessage(
  violations: readonly ConfigReaderViolation[],
  readers: readonly DeclaredConfigReader[] = DECLARED_CONFIG_READERS,
): string {
  if (violations.length === 0) return "";
  const byId = new Map(readers.map((reader) => [reader.id, reader]));
  const lines = violations.map((violation) => {
    const reader = byId.get(violation.readerId);
    const where =
      violation.kind === "test-only"
        ? `called ONLY from tests (${violation.testCallers.join(", ")})`
        : "called from nowhere — a re-export and an import are not calls";
    return (
      `  - ${violation.readerId} — ${reader?.reader ?? "the reader"}() is ${where}.` +
      `\n      Declared keys: ${reader?.keys.join(", ") ?? "unstated"}.` +
      `\n      For the operator: ${reader?.consequence ?? "the declaration does nothing"}.` +
      `\n      Wire it from shipped code, or delete the key and its reader (${reader?.definedIn ?? "its module"}).`
    );
  });
  const plural = violations.length === 1 ? "reader" : "readers";
  return [
    `declared-config-consumer invariant (#4293): ${violations.length} config ${plural} with no shipped caller.`,
    ...lines,
    "A configuration key nothing reads is a promise the product cannot keep." +
      ` Wire it, or drop the entry from ${DECLARED_CONFIG_READER_DECLARATION} once the key is gone.`,
  ].join("\n");
}
