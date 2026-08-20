import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function repoFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function packageScripts(path: string): Record<string, string> {
  const manifest: unknown = JSON.parse(repoFile(path));
  const scripts = (manifest as { scripts?: Record<string, string> }).scripts;
  expect(scripts, `${path} declares no scripts`).toBeDefined();
  return scripts ?? {};
}

/** One workflow job's own block, from its key to the next job key. */
function jobBody(source: string, name: string): string {
  const start = source.indexOf(`\n  ${name}:`);
  expect(start, `missing workflow job: ${name}`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The CI posture issue #3878 chose, pinned so it stays chosen (issue #3897).
 *
 * Three broad package gates were deliberately removed from the pull-request
 * workflow: the RSP build/unit/integration job, the whole `apps/redskilled`
 * suite, and the whole engine-package suite that `packages/red-castle` carried
 * before #4013 renamed it. **A removal nothing pins is a removal that grows
 * back** — the next worker who wants coverage adds the broad job again, and the
 * PR gate silently returns to the cost the repo decided against.
 *
 * The other half of the same decision is what REPLACED them: focused,
 * black-box, seconds-cheap suites. So this file asserts both directions at
 * once. A focused suite that disappears is as much a regression as a broad gate
 * that reappears, and neither is visible to a type checker.
 */
const WORKSPACE_CI = "red-workspace-ci.yml";

/** Every focused ACP suite, with the workflow line that must invoke it. */
const FOCUSED_ACP_SUITES = [
  {
    script: "test:acp-local-transport",
    suite: "tests/acp-local-transport.test.ts",
    why: "the public daemon socket and daemon-assigned Worker sockets, on both native endpoint families",
  },
  {
    script: "test:acp-agent-conformance",
    suite: "tests/acp-agent-conformance.test.ts",
    why: "the five supported Agents, each probed at the ACP baseline before a Worker may reach it",
  },
] as const;

/** The broad gates #3878 removed, each with the focused surface that answers it. */
const REMOVED_BROAD_GATES = [
  {
    label: "RSP build, unit and integration",
    job: "rsp",
    commands: ["run: pnpm -C apps/rsp test", "run: pnpm -C apps/rsp test:integration"],
  },
  {
    label: "the whole apps/redskilled suite",
    job: undefined,
    commands: ["run: pnpm -C apps/redskilled test\n"],
  },
  {
    label: "the whole engine-package suite",
    job: undefined,
    commands: ["run: pnpm -C packages/red-castle test", "run: pnpm -C packages/worker test"],
  },
] as const;

describe("focused ACP CI posture", () => {
  it("runs every focused ACP suite from the workflow, on both native endpoint families", () => {
    const source = repoFile(`.github/workflows/${WORKSPACE_CI}`);
    const job = jobBody(source, "acp-local-transport");
    const scripts = packageScripts("apps/redskilled/package.json");

    expect(job).toContain("os: [ubuntu-latest, windows-latest]");
    for (const { script, suite, why } of FOCUSED_ACP_SUITES) {
      expect(scripts[script], `apps/redskilled declares no ${script} (${why})`).toContain(suite);
      expect(job, `the workflow never runs ${script}`).toContain(`run: pnpm -C apps/redskilled ${script}`);
    }
  });

  it("keeps every focused ACP suite a real file rather than a script name", () => {
    for (const { suite } of FOCUSED_ACP_SUITES) {
      expect(repoFile(`apps/redskilled/${suite}`).length).toBeGreaterThan(0);
    }
  });

  it("keeps the focused ACP job inside the required `test` aggregate", () => {
    const source = repoFile(`.github/workflows/${WORKSPACE_CI}`);
    const aggregate = jobBody(source, "test");

    expect(aggregate).toContain("acp-local-transport");
    expect(aggregate).toContain("if: always()");
    expect(aggregate).toContain("contains(needs.*.result, 'failure')");
  });

  it.each(REMOVED_BROAD_GATES)("keeps $label out of the pull-request gate", ({ job, commands }) => {
    const source = repoFile(`.github/workflows/${WORKSPACE_CI}`);

    if (job != null) {
      expect(source).not.toMatch(new RegExp(`^  ${job}:`, "m"));
      expect(jobBody(source, "test")).not.toContain(`needs.${job}.result`);
    }
    for (const command of commands) expect(source).not.toContain(command);
  });

  it("keeps the removed broad gates out of the cone selector that would revive them", () => {
    const source = repoFile(`.github/workflows/${WORKSPACE_CI}`);
    const gate = jobBody(source, "test-packages");

    for (const absent of ["apps/rsp", "apps/redskilled", "packages/red-castle", "packages/worker"]) {
      expect(gate, `${absent} is back in the broad package gate`).not.toContain(`'${absent}'`);
    }
  });

  it("keeps rsp out of the root test aggregate, matching the removed CI gate", () => {
    // #3878 removed the broad rsp gates from CI; the root `test` script is the
    // same aggregate seen by the Worker's local gate whenever a branch touches
    // a root-level file (every changeset does). rsp riding it re-created the
    // removed gate for Workers only: telemetry-resident is red without
    // REDDB_BIN (#4196), so whole Tickets gate-blocked on a suite CI decided
    // not to run.
    const rootManifest = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(rootManifest.scripts?.test).toContain("--filter=!@reddb-io/rsp");
  });

  it("leaves the retired engine package name absent from the workflow entirely", () => {
    // `packages/red-castle` became `packages/worker` in #4013. A workflow that
    // still names the old path is not a gate — it is a step that never runs.
    expect(repoFile(`.github/workflows/${WORKSPACE_CI}`)).not.toContain("packages/red-castle");
  });
});
