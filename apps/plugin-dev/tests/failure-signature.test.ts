// failure-signature — the pure Re-seed dedupe key (issue #2724, Spec #2723).
//
// Acceptance criteria under test:
// 1. Two sidecars listing the same failing checks in a different order produce
//    equal keys.
// 2. A partially-overlapping failure set produces a DIFFERENT key — a subset is
//    not a repeat.
// 3. Review findings contribute, so a gate-clean/review-blocking round is
//    distinguishable from a gate-failing one.
// 4. An empty sidecar with no findings produces a stable sentinel rather than
//    throwing.
import { describe, expect, it } from "vitest";
import {
  EMPTY_FAILURE_SIGNATURE,
  failureSignature,
  failureSignatureTerms,
  parseValidationFailureSignature,
  validationFailureMarker,
  type FailureSignatureFinding,
} from "../src/core/failure-signature.js";
import { VALIDATION_SCHEMA, type ValidationRecord } from "../src/core/feedback.js";

function line(over: Partial<ValidationRecord> & Pick<ValidationRecord, "name">): string {
  const record: ValidationRecord = {
    schema: VALIDATION_SCHEMA,
    status: "failed",
    ...over,
  };
  return JSON.stringify(record);
}

const TEST_ROOT_FAILED = line({
  name: "test:root",
  command: "pnpm -C . test",
  exitCode: 1,
  summary: "failing: FAIL tests/a.test.ts > widget renders — Tests 1 failed | 40 passed",
});
const LINT_DEV_FAILED = line({ name: "lint:apps/plugin-dev", exitCode: 1, summary: "command exited non-zero" });
const BUILD_DEV_FAILED = line({ name: "build:apps/plugin-dev", exitCode: 1, summary: "command exited non-zero" });
const TYPECHECK_PASSED = line({ name: "typecheck:workspace", status: "passed", summary: "command exited 0" });

function finding(over: Partial<FailureSignatureFinding> = {}): FailureSignatureFinding {
  return {
    path: "apps/plugin-dev/src/core/lifecycle.ts",
    line: 42,
    body: "This swallows the error instead of surfacing it.",
    blocking: true,
    ...over,
  };
}

describe("failureSignature — order independence", () => {
  it("gives the same key for the same failing checks listed in a different order", () => {
    const forward = failureSignature({ sidecar: [TEST_ROOT_FAILED, LINT_DEV_FAILED, BUILD_DEV_FAILED] });
    const reversed = failureSignature({ sidecar: [BUILD_DEV_FAILED, LINT_DEV_FAILED, TEST_ROOT_FAILED] });

    expect(forward).toBe(reversed);
    expect(forward).not.toBe(EMPTY_FAILURE_SIGNATURE);
  });

  it("gives the same key for the same review findings reported in a different order", () => {
    const a = finding({ path: "a.ts", line: 1, body: "one" });
    const b = finding({ path: "b.ts", line: 2, body: "two" });

    expect(failureSignature({ findings: [a, b] })).toBe(failureSignature({ findings: [b, a] }));
  });

  it("ignores duplicate records, so a repeated failure is not a different failure", () => {
    expect(failureSignature({ sidecar: [TEST_ROOT_FAILED, TEST_ROOT_FAILED] })).toBe(
      failureSignature({ sidecar: [TEST_ROOT_FAILED] }),
    );
  });
});

describe("failureSignature — set identity", () => {
  it("gives a different key for a partially-overlapping failure set", () => {
    const both = failureSignature({ sidecar: [TEST_ROOT_FAILED, LINT_DEV_FAILED] });
    const subset = failureSignature({ sidecar: [TEST_ROOT_FAILED] });
    const superset = failureSignature({ sidecar: [TEST_ROOT_FAILED, LINT_DEV_FAILED, BUILD_DEV_FAILED] });

    expect(both).not.toBe(subset);
    expect(both).not.toBe(superset);
    expect(subset).not.toBe(superset);
  });

  it("keys on the named test identities, not on the volatile output tail", () => {
    const named = "failing: FAIL tests/a.test.ts > widget renders";
    const runOne = line({ name: "test:root", summary: `${named} — Tests 1 failed | 40 passed in 12.01s` });
    const runTwo = line({ name: "test:root", summary: `${named} — Tests 1 failed | 40 passed in 9.44s` });

    expect(failureSignature({ sidecar: [runOne] })).toBe(failureSignature({ sidecar: [runTwo] }));
  });

  it("distinguishes the same check failing on different tests", () => {
    const widget = line({ name: "test:root", summary: "failing: FAIL tests/a.test.ts > widget renders — tail" });
    const gadget = line({ name: "test:root", summary: "failing: FAIL tests/a.test.ts > gadget renders — tail" });

    expect(failureSignature({ sidecar: [widget] })).not.toBe(failureSignature({ sidecar: [gadget] }));
  });

  it("ignores passed and skipped records — only failures define the signature", () => {
    const skipped = line({ name: "lint:apps/plugin-dev", status: "skipped", summary: "no lint script" });

    expect(failureSignature({ sidecar: [TEST_ROOT_FAILED, TYPECHECK_PASSED, skipped] })).toBe(
      failureSignature({ sidecar: [TEST_ROOT_FAILED] }),
    );
  });
});

describe("failureSignature — review findings", () => {
  it("distinguishes a gate-clean/review-blocking round from a gate-failing one", () => {
    const reviewOnly = failureSignature({ sidecar: [TYPECHECK_PASSED], findings: [finding()] });
    const gateOnly = failureSignature({ sidecar: [TEST_ROOT_FAILED] });

    expect(reviewOnly).not.toBe(gateOnly);
    expect(reviewOnly).not.toBe(EMPTY_FAILURE_SIGNATURE);
  });

  it("changes the key when a finding is added to an otherwise identical gate failure", () => {
    const withoutReview = failureSignature({ sidecar: [TEST_ROOT_FAILED] });
    const withReview = failureSignature({ sidecar: [TEST_ROOT_FAILED], findings: [finding()] });

    expect(withReview).not.toBe(withoutReview);
  });

  it("separates a blocking finding from an advisory one at the same location", () => {
    const blocking = failureSignature({ findings: [finding({ blocking: true })] });
    const advisory = failureSignature({ findings: [finding({ blocking: false })] });

    expect(blocking).not.toBe(advisory);
  });

  it("keys a finding on its location and normalised body", () => {
    const spaced = finding({ body: "  This  swallows\n the error.  " });
    const tight = finding({ body: "This swallows the error." });
    const moved = finding({ body: "This swallows the error.", line: 43 });

    expect(failureSignature({ findings: [spaced] })).toBe(failureSignature({ findings: [tight] }));
    expect(failureSignature({ findings: [moved] })).not.toBe(failureSignature({ findings: [tight] }));
  });
});

describe("failureSignature — degenerate input", () => {
  it("returns the stable sentinel for an empty sidecar and no findings", () => {
    expect(failureSignature({})).toBe(EMPTY_FAILURE_SIGNATURE);
    expect(failureSignature({ sidecar: [], findings: [] })).toBe(EMPTY_FAILURE_SIGNATURE);
    expect(failureSignature({ sidecar: ["", "   "] })).toBe(EMPTY_FAILURE_SIGNATURE);
    expect(failureSignature({ sidecar: [TYPECHECK_PASSED] })).toBe(EMPTY_FAILURE_SIGNATURE);
  });

  it("never throws on malformed, non-object, or foreign sidecar lines", () => {
    expect(failureSignature({ sidecar: ["{not json", "[]", "null", "42", '{"status":"failed"}'] })).toBe(
      EMPTY_FAILURE_SIGNATURE,
    );
    expect(failureSignature({ sidecar: ["{not json", TEST_ROOT_FAILED] })).toBe(
      failureSignature({ sidecar: [TEST_ROOT_FAILED] }),
    );
  });

  it("tolerates findings missing every optional field", () => {
    expect(() => failureSignature({ findings: [{} as FailureSignatureFinding] })).not.toThrow();
    expect(failureSignature({ findings: [{} as FailureSignatureFinding] })).not.toBe(EMPTY_FAILURE_SIGNATURE);
  });

  it("is deterministic across calls", () => {
    const input = { sidecar: [TEST_ROOT_FAILED, LINT_DEV_FAILED], findings: [finding()] };
    expect(failureSignature(input)).toBe(failureSignature(input));
  });
});

describe("failureSignatureTerms", () => {
  it("exposes the canonical sorted terms behind the key", () => {
    const terms = failureSignatureTerms({
      sidecar: [LINT_DEV_FAILED, TEST_ROOT_FAILED],
      findings: [finding({ path: "z.ts", line: 9, body: "nope" })],
    });

    expect(terms).toEqual([...terms].sort());
    expect(terms).toContain("check:lint:apps/plugin-dev");
    expect(terms).toContain("check:test:root");
    expect(terms).toContain("test:FAIL tests/a.test.ts > widget renders");
    expect(terms).toContain("review:blocking:z.ts:9:nope");
  });

  it("is empty for degenerate input", () => {
    expect(failureSignatureTerms({})).toEqual([]);
  });
});

describe("validation failure signature carry-forward (#3268)", () => {
  it("round-trips the signature through the terminal failure reason", () => {
    const signature = failureSignature({ sidecar: [TEST_ROOT_FAILED] });
    const marker = validationFailureMarker("feedback-failed-infra", signature);

    expect(marker).toBe(`feedback-failed-infra validation-signature:${signature}`);
    expect(parseValidationFailureSignature(`worker=x status=blocked ${marker}`)).toBe(signature);
  });

  it("does not invent a signature from unrelated prior failure text", () => {
    expect(parseValidationFailureSignature("feedback-failed-infra without evidence")).toBeUndefined();
  });
});
