import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ReleaseExecution, ReleaseTrigger } from "./version-surfaces.js";
import { readReleaseConfig } from "./version-surfaces.js";

export const RELEASE_WORKFLOW_PATH = ".github/workflows/red-release.yml";
export const VENDORED_RELEASE_BUNDLE_PATH = ".github/red-skills/release.bundle.mjs";

const CHECKOUT_ACTION = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5";
const SETUP_NODE_ACTION = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
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
  const source = renderReleaseWorkflow({
    trigger: config.trigger,
    execution: config.execution,
    engineVersion,
  });
  const path = join(repoRoot, RELEASE_WORKFLOW_PATH);
  const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const workflowChanged = previous !== source;
  if (workflowChanged) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, "utf8");
  }

  const vendored = config.execution === "vendored"
    ? emitVendoredBundle(repoRoot, input.engineBundlePath)
    : undefined;
  return {
    path,
    changed: workflowChanged || vendored?.changed === true,
    trigger: config.trigger,
    execution: config.execution,
    engineVersion,
    ...(vendored === undefined ? {} : { bundlePath: vendored.path }),
  };
}

function emitVendoredBundle(
  repoRoot: string,
  engineBundlePath: string | undefined,
): { readonly path: string; readonly changed: boolean } {
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

  const path = join(repoRoot, VENDORED_RELEASE_BUNDLE_PATH);
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  const changed = previous === undefined || !previous.equals(source);
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  return { path, changed };
}

function pinnedInvocation(engineVersion: string): string {
  const version = normalizedEngineVersion(engineVersion);
  return `npx -y -p @reddb-io/red-skills@${version} red-skills-release run`;
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
