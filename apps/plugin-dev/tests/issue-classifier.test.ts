import { describe, expect, it, vi } from "vitest";
import {
  buildIssueClassificationMetadata,
  classifierPrompt,
  classifyIssue,
  DEFAULT_REVIEW_GATE_THRESHOLD,
  isMechanicalChange,
  resolveReviewGate,
  shouldRequestReview,
  type ReviewGateConfig,
} from "../src/core/issue-classifier.js";

describe("issue classifier", () => {
  it.each([
    {
      name: "mechanical docs",
      labels: ["type:docs"],
      body: "Update README.md copy only.",
      expected: "validate",
    },
    {
      name: "standard bug",
      labels: ["type:bug"],
      body: "Fix src/parser.ts and keep its focused test green.",
      expected: "simple",
    },
    {
      name: "complex cross-scope feature",
      labels: ["type:feature"],
      body: "Change apps/api/src/route.ts, apps/web/src/client.ts, and packages/shared/src/types.ts.",
      expected: "complex",
    },
  ])("routes the $name label/body fixture to $expected", async ({ labels, body, expected }) => {
    const metadata = buildIssueClassificationMetadata({ issue: 1, title: "Fixture", body, labels });
    await expect(classifyIssue(metadata)).resolves.toBe(expected);
  });

  it("extracts cheap metadata from deterministic issue text", () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 42,
      title: "Wire validation tests",
      body: "Touch apps/plugin-dev/src/core/config.ts and apps/plugin-dev/tests/config.test.ts.",
      labels: ["ready-for-agent"],
    });

    expect(metadata.referencedPaths).toEqual([
      "apps/plugin-dev/src/core/config.ts",
      "apps/plugin-dev/tests/config.test.ts",
    ]);
    expect(metadata.extensions).toEqual(["ts"]);
    expect(metadata.scopePaths).toEqual(["apps/plugin-dev"]);
    expect(metadata.diffSize).toBe("small");
    expect(metadata.hasTests).toBe(true);
    expect(metadata.summary).toContain("Wire validation tests");
  });

  it("uses the injected model response when signals do not force escalation", async () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 7,
      title: "Small parser cleanup",
      body: "Touch src/parser.ts and keep tests green.",
    });

    await expect(classifyIssue(metadata, async () => ({ tier: "simple" }))).resolves.toBe("simple");
  });

  it("lets an explicit tier label override every inferred signal without calling the classifier model", async () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 12,
      title: "Choose architecture for an auth migration",
      body: "Change the database schema across apps/api/src/auth.ts and apps/web/src/session.ts.",
      labels: ["tier:simple", "spec:99"],
    });
    const modelCall = vi.fn(async () => ({ tier: "think" }));

    await expect(classifyIssue(metadata, modelCall)).resolves.toBe("simple");
    expect(modelCall).not.toHaveBeenCalled();
  });

  it("risk keywords push the final tier to complex even when the model under-calls it", async () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 8,
      title: "Add auth migration",
      body: "Change database schema migration and token permissions in src/auth/session.ts.",
    });

    await expect(classifyIssue(metadata, async () => '{"tier":"simple"}')).resolves.toBe("complex");
  });

  it("architecture and routing signals push to think", async () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 9,
      title: "Choose routing strategy for AFK model tiers",
      body: "Decide the architecture before implementation.",
    });

    await expect(classifyIssue(metadata, async () => '{"tier":"complex"}')).resolves.toBe("think");
  });

  it("treats a Spec-family implementation slice as complex by default", async () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 13,
      title: "Wire the next implementation slice",
      body: "Touch apps/plugin-dev/src/core/router.ts and keep its focused tests green.",
      labels: ["type:feature", "spec:88"],
    });

    await expect(classifyIssue(metadata)).resolves.toBe("complex");
  });

  it("trivial docs and validation work stays in validate/simple despite a noisy model response", async () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 10,
      title: "Docs formatting fix",
      body: "Update README.md copy and markdown formatting only.",
    });

    await expect(classifyIssue(metadata, async () => '{"tier":"think"}')).resolves.toBe("simple");
  });

  it("builds a prompt containing the one-paragraph summary and cheap signals", () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 11,
      title: "Schema safety",
      body: "## What to build\n\nHandle schema migration risk in src/db/migrate.ts.",
    });

    const prompt = classifierPrompt(metadata);

    expect(prompt).toContain("Return only JSON");
    expect(prompt).toContain("Summary: Schema safety:");
    expect(prompt).toContain("Risk keywords: schema, migration");
    expect(prompt).toContain("Extensions: ts");
    expect(prompt).toContain("Diff size estimate: small");
  });
});

describe("PR review gate (ADR 0064 §10, #749)", () => {
  const enabled: ReviewGateConfig = { enabled: true, threshold: DEFAULT_REVIEW_GATE_THRESHOLD };

  it("defaults the threshold to complex", () => {
    expect(DEFAULT_REVIEW_GATE_THRESHOLD).toBe("complex");
  });

  it("treats tiers below the threshold as mechanical", () => {
    expect(isMechanicalChange("validate", "complex")).toBe(true);
    expect(isMechanicalChange("simple", "complex")).toBe(true);
    expect(isMechanicalChange("complex", "complex")).toBe(false);
    expect(isMechanicalChange("think", "complex")).toBe(false);
  });

  it("mechanical changes get no review label (fast-merge path untouched)", () => {
    expect(shouldRequestReview("validate", enabled)).toBe(false);
    expect(shouldRequestReview("simple", enabled)).toBe(false);
  });

  it("non-mechanical changes request ready-for-review", () => {
    expect(shouldRequestReview("complex", enabled)).toBe(true);
    expect(shouldRequestReview("think", enabled)).toBe(true);
  });

  it("a disabled gate never requests review, regardless of tier", () => {
    const off: ReviewGateConfig = { enabled: false, threshold: "complex" };
    expect(shouldRequestReview("complex", off)).toBe(false);
    expect(shouldRequestReview("think", off)).toBe(false);
  });

  it("resolveReviewGate returns undefined when the gate is off (default)", () => {
    expect(resolveReviewGate({})).toBeUndefined();
    expect(resolveReviewGate({ "afk.review_gate.enabled": "false" })).toBeUndefined();
  });

  it("resolveReviewGate reads enabled + threshold from config", () => {
    expect(
      resolveReviewGate({ "afk.review_gate.enabled": "true", "afk.review_gate.threshold": "simple" }),
    ).toEqual({ enabled: true, threshold: "simple" });
  });

  it("resolveReviewGate falls back to the default threshold for an out-of-vocab value", () => {
    expect(
      resolveReviewGate({ "afk.review_gate.enabled": "true", "afk.review_gate.threshold": "bogus" }),
    ).toEqual({ enabled: true, threshold: DEFAULT_REVIEW_GATE_THRESHOLD });
  });

  it("honours a tuned threshold", () => {
    const simpleAndUp: ReviewGateConfig = { enabled: true, threshold: "simple" };
    expect(shouldRequestReview("validate", simpleAndUp)).toBe(false);
    expect(shouldRequestReview("simple", simpleAndUp)).toBe(true);

    const thinkOnly: ReviewGateConfig = { enabled: true, threshold: "think" };
    expect(shouldRequestReview("complex", thinkOnly)).toBe(false);
    expect(shouldRequestReview("think", thinkOnly)).toBe(true);
  });
});
