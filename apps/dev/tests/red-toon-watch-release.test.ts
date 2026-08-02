import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");

interface WorkflowFile {
  jobs: Record<string, { steps: { name?: string; id?: string; run?: string }[] }>;
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** The literal `run:` body of the watcher's release-resolution step, as it ships. */
async function resolveReleaseScript(): Promise<string> {
  const workflow = yaml.load(
    await readFile(join(ROOT, ".github/workflows/red-toon-watch.yml"), "utf8"),
  ) as WorkflowFile;
  const step = workflow.jobs.watch?.steps.find((candidate) => candidate.name === "Resolve stable toon release");
  if (!step?.run) throw new Error("red-toon-watch is missing the 'Resolve stable toon release' step");
  return step.run;
}

interface PosedRelease {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  body?: string;
}

interface StepOutcome {
  outputs: Record<string, string>;
  stdout: string;
  code: number;
}

/**
 * Runs the shipped step against a posed `reddb-io/toon` release, with `gh` stubbed so no network
 * is touched. This exercises the real shell — the version comparison is the thing that decides
 * whether a release is ever noticed, so asserting on its text would prove nothing.
 */
async function runStepAgainst(release: PosedRelease, catalogVersion: string): Promise<StepOutcome> {
  const root = await mkdtemp(join(tmpdir(), "red-toon-watch-"));
  roots.push(root);

  await writeFile(join(root, "pnpm-workspace.yaml"), `catalog:\n  "@reddb-io/toon": ${catalogVersion}\n`, "utf8");

  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(release)}\nJSON\n`, "utf8");
  await chmod(join(bin, "gh"), 0o755);

  const outputPath = join(root, "github-output");
  await writeFile(outputPath, "", "utf8");
  const script = join(root, "step.sh");
  await writeFile(script, await resolveReleaseScript(), "utf8");

  let stdout = "";
  let code = 0;
  try {
    const result = await execFileAsync("bash", [script], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GITHUB_OUTPUT: outputPath,
        GH_TOKEN: "posed",
        TARGET_TAG_INPUT: "",
      },
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    code = failure.code ?? 1;
    stdout = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }

  const outputs: Record<string, string> = {};
  for (const line of (await readFile(outputPath, "utf8")).split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return { outputs, stdout, code };
}

describe("red-toon-watch notices a posed toon release", () => {
  it("flags a newer stable release against the current catalog pin", async () => {
    const outcome = await runStepAgainst({ tag_name: "v0.14.0", body: "notes" }, "0.13.0");

    expect(outcome.code).toBe(0);
    expect(outcome.outputs).toMatchObject({
      changed: "true",
      tag: "v0.14.0",
      target_version: "0.14.0",
      current_version: "0.13.0",
    });
  });

  // The rot this whole slice exists to prevent: 0.13.0 sorts BELOW 0.3.0 lexically, so a watcher
  // that compared strings instead of versions would have called ten minors of drift "up to date".
  it("compares versions numerically, not lexically", async () => {
    const outcome = await runStepAgainst({ tag_name: "v0.13.0", body: "notes" }, "0.3.0");

    expect(outcome.outputs).toMatchObject({ changed: "true", target_version: "0.13.0", current_version: "0.3.0" });
  });

  it("stays quiet when the catalog already pins the newest release", async () => {
    const outcome = await runStepAgainst({ tag_name: "v0.13.0", body: "notes" }, "0.13.0");

    expect(outcome.code).toBe(0);
    expect(outcome.outputs.changed).toBe("false");
  });

  it("stays quiet when the posed release is older than the pin", async () => {
    const outcome = await runStepAgainst({ tag_name: "v0.12.0", body: "notes" }, "0.13.0");

    expect(outcome.outputs.changed).toBe("false");
  });

  it("refuses a prerelease and a non-stable tag rather than bumping onto it", async () => {
    const prerelease = await runStepAgainst({ tag_name: "v0.14.0", prerelease: true }, "0.13.0");
    expect(prerelease.code).not.toBe(0);

    const unstable = await runStepAgainst({ tag_name: "v0.14.0-rc.1" }, "0.13.0");
    expect(unstable.code).not.toBe(0);
  });
});
