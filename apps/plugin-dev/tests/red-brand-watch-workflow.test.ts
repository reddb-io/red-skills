import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");

interface WorkflowStep {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
}

interface WorkflowFile {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs: Record<string, { steps: WorkflowStep[] }>;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function readWorkflow(): Promise<{ source: string; workflow: WorkflowFile }> {
  const source = await readFile(join(ROOT, ".github/workflows/red-brand-watch.yml"), "utf8");
  return { source, workflow: yaml.load(source) as WorkflowFile };
}

function namedStep(workflow: WorkflowFile, name: string): WorkflowStep {
  const step = workflow.jobs.watch?.steps.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`red-brand-watch is missing the '${name}' step`);
  return step;
}

async function runIssueStepTwice(scriptBody: string): Promise<{ calls: string[]; body: string }> {
  const root = await mkdtemp(join(tmpdir(), "red-brand-watch-"));
  roots.push(root);

  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail

case "$1 $2" in
  "issue list")
    if [ -f "$FAKE_ISSUE_STATE" ]; then printf '41\\n'; fi
    ;;
  "issue create"|"issue edit")
    action="$2"
    shift 2
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--body-file" ]; then cp "$2" "$FAKE_ISSUE_BODY"; break; fi
      shift
    done
    printf '%s\\n' "$action" >> "$FAKE_GH_LOG"
    touch "$FAKE_ISSUE_STATE"
    ;;
  *)
    printf 'unexpected gh invocation: %s\\n' "$*" >&2
    exit 1
    ;;
esac
`,
    "utf8",
  );
  await chmod(join(bin, "gh"), 0o755);

  const script = join(root, "step.sh");
  const log = join(root, "gh.log");
  const state = join(root, "issue-state");
  const body = join(root, "issue-body.md");
  await writeFile(script, scriptBody, "utf8");
  await writeFile(log, "", "utf8");

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GH_TOKEN: "posed",
    REPO: "reddb-io/brand",
    OLD: "1111111111111111111111111111111111111111",
    NEW: "2222222222222222222222222222222222222222",
    FAKE_GH_LOG: log,
    FAKE_ISSUE_STATE: state,
    FAKE_ISSUE_BODY: body,
  };

  await execFileAsync("bash", [script], { cwd: root, env });
  await execFileAsync("bash", [script], { cwd: root, env });

  return {
    calls: (await readFile(log, "utf8")).trim().split("\n"),
    body: await readFile(body, "utf8"),
  };
}

describe("red-brand-watch workflow", () => {
  it("reads the repository and recorded SHA from the brand tokens provenance", async () => {
    const { source, workflow } = await readWorkflow();
    const pin = namedStep(workflow, "Load recorded brand provenance");
    const head = namedStep(workflow, "Fetch brand HEAD");

    expect(workflow.name).toBe("red-brand-watch");
    expect(workflow.on).toHaveProperty("schedule");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ contents: "read", issues: "write" });
    expect(pin.run).toContain(". ./packages/brand-tokens/.upstream");
    expect(pin.run).toContain('echo "repo=$repo" >> "$GITHUB_OUTPUT"');
    expect(pin.run).toContain('echo "sha=$sha" >> "$GITHUB_OUTPUT"');
    expect(source).toContain("REPO: ${{ steps.pin.outputs.repo }}");
    expect(head.run).toContain('repos/$REPO/commits/HEAD');
    expect(source).not.toMatch(/c76366f10aaf52722eeedadbca67e20a8a34f008/);
  });

  it("creates one drift issue and updates it on the next posed drift run", async () => {
    const { workflow } = await readWorkflow();
    const issue = namedStep(workflow, "Open or update drift issue");

    expect(issue.if).toBe("steps.head.outputs.sha != steps.pin.outputs.sha");
    expect(issue.run).toContain("gh issue list");
    expect(issue.run).toContain("--state open");
    expect(issue.run).toContain("gh issue edit");
    expect(issue.run).toContain("gh issue create");

    const outcome = await runIssueStepTwice(issue.run ?? "");
    expect(outcome.calls).toEqual(["create", "edit"]);
    expect(outcome.body).toContain("1111111111111111111111111111111111111111");
    expect(outcome.body).toContain("2222222222222222222222222222222222222222");
    expect(outcome.body).toContain("## Agent brief");
  });
});
