import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The reactive mechanical-action workflow is a public-repo security boundary
// (issue #942 / PRD #928 S11b). These tests pin the properties that make it
// provably-safe by construction: it can execute ONLY an enumerated mechanical
// action set, it refuses semantic merge/close/approve (those stay in the
// authenticated /hitl CLI), and it never interpolates untrusted comment text
// into a shell command.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const WORKFLOW_PATH = join(ROOT, ".github/workflows/red-reactive-mechanical.yml");
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(input: string): unknown };

async function readWorkflow(): Promise<string> {
  return readFile(WORKFLOW_PATH, "utf8");
}

type WorkflowDoc = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, { permissions?: Record<string, string> }>;
};

describe("red-reactive-mechanical workflow", () => {
  it("exists and parses as YAML", async () => {
    const raw = await readWorkflow();
    const doc = yaml.load(raw) as WorkflowDoc;
    expect(doc, "workflow must parse as a YAML mapping").toBeTypeOf("object");
    expect(doc.jobs, "workflow must define jobs").toBeTypeOf("object");
  });

  it("uses the red- filename prefix and name", async () => {
    // Filename prefix (feedback: all RedSkills workflow filenames start with red-).
    expect(WORKFLOW_PATH.endsWith("/red-reactive-mechanical.yml")).toBe(true);
    const doc = yaml.load(await readWorkflow()) as WorkflowDoc;
    expect(doc.name ?? "").toMatch(/^red-/);
  });

  it("is structurally incapable of merging or approving PRs (no contents:write / pull-requests:write)", async () => {
    const raw = await readWorkflow();
    const doc = yaml.load(raw) as WorkflowDoc;
    // Collect every permission block (top-level + per-job).
    const blocks: Record<string, string>[] = [];
    if (doc.permissions) blocks.push(doc.permissions);
    for (const job of Object.values(doc.jobs ?? {})) {
      if (job.permissions) blocks.push(job.permissions);
    }
    expect(blocks.length, "at least one permissions block must be declared").toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block["contents"] ?? "read", "contents must never be write").not.toBe("write");
      // Merging or approving a PR review both require pull-requests: write.
      expect(block["pull-requests"] ?? "read", "pull-requests must never be write").not.toBe(
        "write",
      );
    }
  });

  it("enumerates the provably-safe mechanical action allowlist", async () => {
    const raw = await readWorkflow();
    for (const action of ["rerun-ci", "audit", "approve-ci", "label"]) {
      expect(raw, `mechanical action '${action}' must be enumerated`).toContain(action);
    }
  });

  it("refuses semantic decisions and points them to the /hitl CLI", async () => {
    const raw = await readWorkflow();
    for (const verb of ["merge", "close", "approve"]) {
      expect(raw, `semantic verb '${verb}' must be named in the refusal path`).toContain(verb);
    }
    expect(raw, "semantic decisions must be redirected to the authenticated /hitl CLI").toMatch(
      /hitl/i,
    );
  });

  it("passes untrusted comment text through an env var, never interpolated into the shell", async () => {
    const raw = await readWorkflow();
    // The comment body is delimited data: bound to an env var and read as $COMMENT_BODY.
    expect(raw).toContain("COMMENT_BODY: ${{ github.event.comment.body }}");
    expect(raw, "parser must read the body from the env var").toMatch(/\$COMMENT_BODY|\$\{COMMENT_BODY\}/);
    // The raw expression must NOT appear inside a run: shell body as a bare token.
    const runInterpolation = /run:\s*\|[\s\S]*?\$\{\{\s*github\.event\.comment\.body\s*\}\}/;
    expect(
      raw,
      "comment body must never be interpolated directly into a run: block",
    ).not.toMatch(runInterpolation);
  });

  it("preserves a self-healing reconcile path", async () => {
    const raw = await readWorkflow();
    const doc = yaml.load(raw) as WorkflowDoc;
    const jobNames = Object.keys(doc.jobs ?? {});
    expect(jobNames.some((n) => n.includes("reconcile"))).toBe(true);
  });
});
