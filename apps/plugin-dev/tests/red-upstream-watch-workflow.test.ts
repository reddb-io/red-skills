import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readWorkflow(): Promise<string> {
  return readFile(join(ROOT, ".github/workflows/red-upstream-watch.yml"), "utf8");
}

function stepBody(workflow: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  expect(start, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0);

  const next = workflow.indexOf("\n      - name: ", start + marker.length);
  return workflow.slice(start, next === -1 ? workflow.length : next);
}

describe("red-upstream-watch workflow injection safety", () => {
  it("does not let upstream diff text forge GITHUB_OUTPUT records", async () => {
    const compare = stepBody(await readWorkflow(), "Compare");

    expect(compare).not.toContain("body<<EOF");
    expect(compare).toMatch(/delimiter="\$\(uuidgen\)"/);
    expect(compare).toContain("printf 'body<<%s\\n' \"$delimiter\"");
    expect(compare).toContain("printf '%s\\n' \"$delimiter\"");
  });

  it("passes upstream-controlled body text through env and quoted shell references", async () => {
    const openIssue = stepBody(await readWorkflow(), "Open or update issue");
    const runBlock = openIssue.slice(openIssue.indexOf("run: |"));

    expect(openIssue).toContain("OLD: ${{ steps.pin.outputs.sha }}");
    expect(openIssue).toContain("DIFF_BODY: ${{ steps.diff.outputs.body }}");
    expect(runBlock).not.toContain("${{ steps.pin.outputs.sha }}");
    expect(runBlock).not.toContain("${{ steps.diff.outputs.body }}");
    expect(runBlock).toContain("printf '%s\\n\\n' \"$DIFF_BODY\"");
    expect(runBlock).toMatch(/<<'BODY_[A-Z_]+'/);
  });
});
