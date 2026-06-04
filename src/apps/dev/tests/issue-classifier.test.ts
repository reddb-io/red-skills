import { describe, expect, it } from "vitest";
import {
  buildIssueClassificationMetadata,
  classifierPrompt,
  classifyIssue,
} from "../src/core/issue-classifier.js";

describe("issue classifier", () => {
  it("extracts cheap metadata from deterministic issue text", () => {
    const metadata = buildIssueClassificationMetadata({
      issue: 42,
      title: "Wire validation tests",
      body: "Touch src/apps/dev/src/core/config.ts and src/apps/dev/tests/config.test.ts.",
      labels: ["ready-for-agent"],
    });

    expect(metadata.referencedPaths).toEqual([
      "src/apps/dev/src/core/config.ts",
      "src/apps/dev/tests/config.test.ts",
    ]);
    expect(metadata.extensions).toEqual(["ts"]);
    expect(metadata.scopePaths).toEqual(["src/apps"]);
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
