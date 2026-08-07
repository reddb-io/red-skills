import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ReleaseExecution, ReleaseTrigger } from "./version-surfaces.js";
import { readReleaseConfig } from "./version-surfaces.js";

export const RELEASE_WORKFLOW_PATH = ".github/workflows/red-release.yml";
export const VENDORED_RELEASE_BUNDLE_PATH = ".github/red-skills/release.bundle.mjs";

const CHECKOUT_ACTION = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";
const SETUP_NODE_ACTION = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";

/**
 * The repository's own package manager, made available to the release job.
 *
 * `sync_command` is declared by the OPERATOR and may reach anything the repo
 * normally uses — this workspace's runs `pnpm generate-manifests`. A job that
 * installs only Node dies with `pnpm: not found` at the first sync, which is a
 * release refusing on the toolchain rather than on the release. Corepack takes
 * the version from `packageManager`, so the job matches the repo without a
 * second place to keep that number.
 */
const TOOLCHAIN_STEPS: readonly string[] = [
  "      - name: Enable the repository package manager",
  "        run: corepack enable",
  "      - name: Install workspace dependencies",
  "        run: pnpm install --frozen-lockfile",
];
const RELEASE_BOT = "red-skills-release[bot]";

export interface RenderReleaseWorkflowInput {
  readonly trigger: ReleaseTrigger;
  readonly execution: ReleaseExecution;
  readonly engineVersion: string;
}

export interface GenerateReleaseWorkflowsInput {
  readonly repoRoot: string;
  readonly engineVersion: string;
  /** Required by vendored mode: the shipped single-file release engine to copy. */
  readonly engineBundlePath?: string;
}

export interface GenerateReleaseWorkflowsResult {
  readonly path: string;
  readonly changed: boolean;
  readonly trigger: ReleaseTrigger;
  readonly execution: ReleaseExecution;
  readonly engineVersion: string;
  readonly bundlePath?: string;
}

/** Render the complete workflow for one configured trigger and execution mode. */
export function renderReleaseWorkflow(input: RenderReleaseWorkflowInput): string {
  const version = normalizedEngineVersion(input.engineVersion);
  const invocation = input.execution === "vendored"
    ? `node ${VENDORED_RELEASE_BUNDLE_PATH} run`
    : pinnedInvocation(version);
  return input.trigger === "version-pr"
    ? renderVersionPullRequestWorkflow(invocation)
    : renderAutoWorkflow(invocation);
}

/**
 * Converge the generated workflow from `.red/config.yaml`.
 *
 * Exact byte comparison makes a repeated setup run a true no-op. Pinned mode
 * refreshes the npm version in the workflow; vendored mode refreshes the exact
 * shipped single-file bundle and keeps the workflow pointed at its stable path.
 */
export function generateReleaseWorkflows(
  input: GenerateReleaseWorkflowsInput,
): GenerateReleaseWorkflowsResult {
  const repoRoot = resolve(input.repoRoot);
  const config = readReleaseConfig(repoRoot);
  const engineVersion = normalizedEngineVersion(input.engineVersion);
  const vendored = config.execution === "vendored"
    ? prepareVendoredBundle(repoRoot, input.engineBundlePath, engineVersion)
    : undefined;
  const source = renderReleaseWorkflow({
    trigger: config.trigger,
    execution: config.execution,
    engineVersion,
  });
  const path = join(repoRoot, RELEASE_WORKFLOW_PATH);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const workflowChanged = previous !== source;
  if (vendored?.changed === true) {
    mkdirSync(dirname(vendored.path), { recursive: true });
    writeFileSync(vendored.path, vendored.source);
  }
  if (workflowChanged) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
  }

  return {
    path,
    changed: workflowChanged || vendored?.changed === true,
    trigger: config.trigger,
    execution: config.execution,
    engineVersion,
    ...(vendored === undefined ? {} : { bundlePath: vendored.path }),
  };
}

function prepareVendoredBundle(
  repoRoot: string,
  engineBundlePath: string | undefined,
  engineVersion: string,
): { readonly path: string; readonly source: Buffer; readonly changed: boolean } {
  if (engineBundlePath === undefined) {
    throw new Error("vendored release workflow generation requires engineBundlePath");
  }
  const sourcePath = resolve(engineBundlePath);
  let source: Buffer;
  try {
    source = readFileSync(sourcePath);
  } catch (error) {
    throw new Error(`cannot read vendored release bundle ${sourcePath}: ${errorMessage(error)}`);
  }
  const versionAnswer = spawnSync(process.execPath, [sourcePath, "--version"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (versionAnswer.error !== undefined || versionAnswer.status !== 0) {
    throw new Error(
      `vendored release bundle cannot answer --version statically: ${
        errorMessage(versionAnswer.error ?? versionAnswer.stderr.trim())
      }`,
    );
  }
  const [app, reportedVersion] = versionAnswer.stdout.trim().split(/\s+/);
  if (app !== "red-skills-release" || reportedVersion === undefined) {
    throw new Error("vendored release bundle returned an invalid static --version answer");
  }
  if (reportedVersion !== engineVersion) {
    throw new Error(
      `vendored release bundle reports ${reportedVersion}, expected ${engineVersion}`,
    );
  }

  const path = join(repoRoot, VENDORED_RELEASE_BUNDLE_PATH);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  const changed = previous === undefined || !previous.equals(source);
  return { path, source, changed };
}

/**
 * The first published version that ships the `red-skills-release` binary.
 *
 * The generator stamps the version the repo is AT, which is one version behind
 * the feature the first time it runs: a repo on 3.8.0 generated a workflow
 * invoking a binary 3.8.0 does not contain, and the release died with
 * `red-skills-release: not found`. Same shape as the `/red-setup` dead end the
 * house invariants record — an instruction pointing at its own precondition.
 */
const RELEASE_BINARY_SINCE = "3.9.0";

function pinnedInvocation(engineVersion: string): string {
  const version = atLeast(normalizedEngineVersion(engineVersion), RELEASE_BINARY_SINCE);
  return `npx -y -p @reddb-io/red-skills@${version} red-skills-release run`;
}

/** The later of two `x.y.z` versions, so a pin can never name a build without the binary. */
function atLeast(version: string, floor: string): string {
  const parts = (value: string): number[] => value.split(".").map(Number);
  const [a, b] = [parts(version), parts(floor)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? version : floor;
  }
  return version;
}

function normalizedEngineVersion(value: string): string {
  const version = value.trim().replace(/^v/, "");
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`release workflow engine version must be an exact stable semver: ${value}`);
  }
  return version;
}

function renderVersionPullRequestWorkflow(invocation: string): string {
  return [
    generatedHeader(),
    "name: RedSkills Release",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "    branches: [main]",
    "    types: [closed]",
    "",
    "permissions: {}",
    "",
    "jobs:",
    "  maintain-version-pr:",
    `    if: github.event_name == 'push' && github.event.head_commit.author.name != '${RELEASE_BOT}'`,
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "    steps:",
    `      - uses: ${CHECKOUT_ACTION}`,
    "        with:",
    "          fetch-depth: 0",
    `      - uses: ${SETUP_NODE_ACTION}`,
    "        with:",
    "          node-version: 22",
    ...TOOLCHAIN_STEPS,
    "      - name: Maintain Version PR",
    "        env:",
    "          GITHUB_TOKEN: ${{ github.token }}",
    `        run: ${invocation}`,
    "",
    "  publish-release:",
    "    if: github.event_name == 'pull_request' && github.event.pull_request.merged == true && github.event.pull_request.head.ref == 'red-release/version-pr'",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "    steps:",
    `      - uses: ${CHECKOUT_ACTION}`,
    "        with:",
    "          fetch-depth: 0",
    "          ref: ${{ github.event.pull_request.merge_commit_sha }}",
    `      - uses: ${SETUP_NODE_ACTION}`,
    "        with:",
    "          node-version: 22",
    ...TOOLCHAIN_STEPS,
    "      - name: Publish Release",
    "        env:",
    "          GITHUB_TOKEN: ${{ github.token }}",
    `        run: ${invocation}`,
    "",
  ].join("\n");
}

function renderAutoWorkflow(invocation: string): string {
  return [
    generatedHeader(),
    "name: RedSkills Release",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "",
    "permissions: {}",
    "",
    "jobs:",
    "  publish-release:",
    `    if: github.event.head_commit.author.name != '${RELEASE_BOT}'`,
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      contents: write",
    "    steps:",
    `      - uses: ${CHECKOUT_ACTION}`,
    "        with:",
    "          fetch-depth: 0",
    `      - uses: ${SETUP_NODE_ACTION}`,
    "        with:",
    "          node-version: 22",
    ...TOOLCHAIN_STEPS,
    "      - name: Publish Release",
    "        env:",
    "          GITHUB_TOKEN: ${{ github.token }}",
    `        run: ${invocation}`,
    "",
  ].join("\n");
}

function generatedHeader(): string {
  return "# Generated by red-skills-release. Re-run /red-setup to refresh this file.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
