/**
 * github.ts — the abortable GitHub surface a wait polls.
 *
 * Every call here is bounded twice: by the wait's own cancellation signal, and
 * by a per-probe timeout. Without the second bound a `gh` call that never
 * returns (a hung proxy, a TCP black hole) would outlive the wait's `--timeout`
 * entirely, because the deadline is only ever checked BETWEEN probes. A probe
 * that hits its bound is reported as indeterminate and the poll loop simply
 * tries again until the real deadline.
 *
 * JSON appears in this module because it is GitHub's wire format — an external
 * interface. It is decoded at this boundary and never becomes internal state.
 */
import { spawn } from "node:child_process";
import { resolveRspConfig } from "../config.js";
import {
  readGhConditionalJson,
  type GhConditionalRequest,
  type GhConditionalResult,
} from "../gh-conditional.js";
import {
  createCachedGithubBalanceReader,
  createRspResidentGithubClient,
  type RspResidentGithubClient,
} from "../resident-github.js";
import { resolveResidentPaths } from "../resident-client.js";
import { arrayOfRecords, numberField, optionAfter, recordOf, stringField } from "./json.js";
import { descendantPids, signalPids } from "./process-tree.js";

export interface GhResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface GhCallOptions {
  cwd: string;
  /** The wait's cancellation signal — aborts propagate to the `gh` process. */
  signal: AbortSignal;
  /** Upper bound on this single call. */
  timeoutMs: number;
}

const waitGithubClients = new Map<string, RspResidentGithubClient>();
const unavailableResidents = new Set<string>();

/**
 * A wait is already long-lived, so it can own one packages/github client when
 * rsp is disabled or its resident is unhealthy. ETags and the adaptive balance
 * snapshot survive for the whole wait without falling back to raw gh.
 */
async function readWaitGithubJson(request: GhConditionalRequest): Promise<GhConditionalResult> {
  const cwd = request.cwd ?? process.cwd();
  const env = request.env ?? process.env;
  const root = resolveResidentPaths(cwd).rootDir;
  if (resolveRspConfig(root, env).enabled && !unavailableResidents.has(root)) {
    const resident = await readGhConditionalJson(request);
    if (!isResidentUnavailable(resident)) return resident;
    unavailableResidents.add(root);
  }
  return await readGhConditionalJson({
    ...request,
    residentRead: async (input) => await (await waitGithubClient(root, env, request.signal)).read(input),
  });
}

async function waitGithubClient(
  root: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
): Promise<RspResidentGithubClient> {
  const held = waitGithubClients.get(root);
  if (held) return held;
  let token = String(env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "").trim();
  if (!token) {
    const credential = await runGhCommand(["auth", "token"], root, signal ?? AbortSignal.timeout(60_000));
    if (credential.status !== 0) throw new Error(credential.stderr || "rsp wait could not obtain a GitHub credential");
    token = credential.stdout.trim();
  }
  if (!token) throw new Error("rsp wait could not obtain a GitHub credential");
  const baseUrl = String(env.GITHUB_API_URL ?? "").trim() || undefined;
  const client = createRspResidentGithubClient({
    rootDir: root,
    token,
    balance: createCachedGithubBalanceReader(token, baseUrl),
    ...(baseUrl ? { baseUrl } : {}),
  });
  waitGithubClients.set(root, client);
  return client;
}

function isResidentUnavailable(result: GhConditionalResult): boolean {
  if (result.status !== 75) return false;
  try {
    return (JSON.parse(result.stderr) as { reason?: string }).reason === "rsp-github-resident-unavailable";
  } catch {
    return false;
  }
}

/**
 * Run one `gh --json`-shaped query, preferring the ETag-conditional API path so
 * repeated polls stay quota-free.
 */
export async function ghJson(args: readonly string[], options: GhCallOptions): Promise<GhResult> {
  // Integration fixtures can exercise the published CLI against a fake `gh`
  // executable without weakening the production conditional-client path.
  if (process.env.RSP_WAIT_GITHUB_TEST_TRANSPORT === "gh") {
    return await withProbeBound(options, async (signal) => await runGhCommand(args, options.cwd, signal));
  }
  return await withProbeBound(options, async (signal) => {
    const conditional = await conditionalGhJson(args, options.cwd, signal);
    if (conditional) return conditional;
    return await runGhCommand(args, options.cwd, signal);
  });
}

/**
 * Bound one probe with its own timer, chained to the wait's signal.
 *
 * `AbortSignal.any` is what makes the two bounds compose: whichever fires first
 * cancels the underlying process, and the caller always gets an answer.
 */
async function withProbeBound(
  options: GhCallOptions,
  run: (signal: AbortSignal) => Promise<GhResult>,
): Promise<GhResult> {
  if (options.signal.aborted) return { status: 1, stdout: "", stderr: "wait cancelled" };
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(), options.timeoutMs);
  const signal = AbortSignal.any([options.signal, bound.signal]);
  try {
    const result = await run(signal);
    if (bound.signal.aborted) {
      return { status: 1, stdout: "", stderr: `GitHub probe exceeded ${options.timeoutMs}ms` };
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** Spawn `gh` directly, killing its whole tree if the call is cancelled. */
async function runGhCommand(args: readonly string[], cwd: string, signal: AbortSignal): Promise<GhResult> {
  if (signal.aborted) return { status: 1, stdout: "", stderr: "gh call cancelled" };
  return await new Promise((resolveResult) => {
    let settled = false;
    const finish = (value: GhResult) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolveResult(value);
    };
    const child = spawn("gh", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    function onAbort(): void {
      const pid = child.pid;
      if (pid) {
        // `gh` can fan out to helper processes (a credential helper, a pager);
        // reclaim those too so cancellation leaves nothing behind.
        void descendantPids(pid).then((descendants) => signalPids(descendants, "SIGKILL"));
      }
      try {
        child.kill("SIGKILL");
      } catch {}
      finish({ status: 1, stdout: "", stderr: "gh call cancelled" });
    }
    signal.addEventListener("abort", onAbort, { once: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (err) => finish({ status: 1, stdout: "", stderr: err.message }));
    child.once("close", (status) => {
      finish({
        status: status ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8").trim(),
      });
    });
  });
}

/**
 * Map the `gh <noun> <verb> --json` shapes a wait uses onto conditional REST
 * calls, translating the REST payload back into the `--json` field names the
 * probes read. Returns null for a shape with no conditional equivalent, which
 * falls back to the plain `gh` invocation.
 */
async function conditionalGhJson(args: readonly string[], cwd: string, signal: AbortSignal): Promise<GhResult | null> {
  if (args[0] === "pr" && args[1] === "view" && args[2]) {
    return await conditionalPrView(args[2], cwd, signal);
  }
  if (args[0] === "run" && args[1] === "view" && args[2]) {
    const response = await readWaitGithubJson({
      path: `repos/{owner}/{repo}/actions/runs/${args[2]}`,
      cwd,
      signal,
      command: `gh ${args.join(" ")}`,
    });
    if (response.status !== 0) return response;
    const row = recordOf(JSON.parse(response.stdout));
    return {
      status: 0,
      stderr: response.stderr,
      stdout: JSON.stringify({
        databaseId: numberField(row, "database_id") || numberField(row, "id"),
        status: stringField(row, "status").toUpperCase(),
        conclusion: stringField(row, "conclusion").toUpperCase(),
        workflowName: stringField(row, "workflow_name") || stringField(row, "name"),
        headBranch: stringField(row, "head_branch"),
        url: stringField(row, "html_url"),
      }),
    };
  }
  if (args[0] === "job" && args[1] === "view" && args[2]) {
    const response = await readWaitGithubJson({
      path: `repos/{owner}/{repo}/actions/jobs/${args[2]}`,
      args: ["run", "view", args[2]],
      cwd,
      signal,
      command: `gh api repos/{owner}/{repo}/actions/jobs/${args[2]}`,
    });
    if (response.status !== 0) return response;
    const row = recordOf(JSON.parse(response.stdout));
    return {
      status: 0,
      stderr: response.stderr,
      stdout: JSON.stringify({
        databaseId: numberField(row, "id"),
        name: stringField(row, "name"),
        status: stringField(row, "status").toUpperCase(),
        conclusion: stringField(row, "conclusion").toUpperCase(),
        url: stringField(row, "html_url"),
      }),
    };
  }
  if (args[0] === "run" && args[1] === "list") {
    const branch = optionAfter(args, "--branch");
    const limit = optionAfter(args, "--limit") ?? "20";
    const response = await readWaitGithubJson({
      path: "repos/{owner}/{repo}/actions/runs",
      params: { branch, per_page: limit },
      cwd,
      signal,
      command: `gh ${args.join(" ")}`,
    });
    if (response.status !== 0) return response;
    const rows = arrayOfRecords(recordOf(JSON.parse(response.stdout)).workflow_runs).map((row) => ({
      databaseId: numberField(row, "database_id") || numberField(row, "id"),
    }));
    return { status: 0, stdout: JSON.stringify(rows), stderr: response.stderr };
  }
  if (args[0] === "release" && args[1] === "list") {
    const limit = optionAfter(args, "--limit") ?? "20";
    const response = await readWaitGithubJson({
      path: "repos/{owner}/{repo}/releases",
      params: { per_page: limit },
      cwd,
      signal,
      command: `gh ${args.join(" ")}`,
    });
    if (response.status !== 0) return response;
    const rows = arrayOfRecords(JSON.parse(response.stdout)).map((row) => ({
      tagName: stringField(row, "tag_name"),
      publishedAt: stringField(row, "published_at"),
      isDraft: row.draft === true,
    }));
    return { status: 0, stdout: JSON.stringify(rows), stderr: response.stderr };
  }
  if (args[0] === "release" && args[1] === "view" && args[2]) {
    const tag = args[2];
    const response = await readWaitGithubJson({
      path: `repos/{owner}/{repo}/releases/tags/${encodeURIComponent(tag)}`,
      args: ["release", "view", tag],
      cwd,
      signal,
      command: `gh release view ${tag}`,
    });
    if (response.status !== 0) return response;
    const row = recordOf(JSON.parse(response.stdout));
    return {
      status: 0,
      stderr: response.stderr,
      stdout: JSON.stringify({
        tagName: stringField(row, "tag_name"),
        publishedAt: stringField(row, "published_at"),
        isDraft: row.draft === true,
      }),
    };
  }
  return null;
}

/**
 * `gh pr view --json statusCheckRollup` has no single REST equivalent, so the
 * rollup is rebuilt from the commit status and check-run endpoints for the PR's
 * head SHA.
 */
async function conditionalPrView(number: string, cwd: string, signal: AbortSignal): Promise<GhResult> {
  const pr = await readWaitGithubJson({
    path: `repos/{owner}/{repo}/pulls/${number}`,
    cwd,
    signal,
    command: `gh pr view ${number}`,
  });
  if (pr.status !== 0) return pr;
  const row = recordOf(JSON.parse(pr.stdout));
  if (Array.isArray(row.statusCheckRollup)) return { status: 0, stdout: pr.stdout, stderr: pr.stderr };
  const sha = stringField(recordOf(row.head), "sha");
  const [combinedStatus, checkRuns] = sha
    ? await Promise.all([
      readWaitGithubJson({
        path: `repos/{owner}/{repo}/commits/${sha}/status`,
        cwd,
        signal,
        command: `gh pr view ${number} status`,
      }),
      readWaitGithubJson({
        path: `repos/{owner}/{repo}/commits/${sha}/check-runs`,
        cwd,
        signal,
        command: `gh pr view ${number} check-runs`,
      }),
    ])
    : [{ status: 0, stdout: "{}", stderr: "", quotaFree: false }, { status: 0, stdout: "{}", stderr: "", quotaFree: false }];
  const statuses = combinedStatus.status === 0 ? arrayOfRecords(recordOf(JSON.parse(combinedStatus.stdout)).statuses) : [];
  const runs = checkRuns.status === 0 ? arrayOfRecords(recordOf(JSON.parse(checkRuns.stdout)).check_runs) : [];
  return {
    status: 0,
    stderr: [pr.stderr, combinedStatus.stderr, checkRuns.stderr].filter(Boolean).join("\n"),
    stdout: JSON.stringify({
      number: numberField(row, "number"),
      state: stringField(row, "state").toUpperCase(),
      mergeable: mergeableState(row),
      statusCheckRollup: [
        ...statuses.map((status) => ({ conclusion: stringField(status, "state").toUpperCase() })),
        ...runs.map((run) => ({
          status: stringField(run, "status").toUpperCase(),
          conclusion: stringField(run, "conclusion").toUpperCase(),
        })),
      ],
      url: stringField(row, "html_url"),
    }),
  };
}

/**
 * Normalize REST's two mergeability fields into the one vocabulary the probes
 * read. REST calls a conflict `dirty`; GraphQL calls it `CONFLICTING`.
 */
export function mergeableState(row: Record<string, unknown>): string {
  const state = stringField(row, "mergeable_state").toUpperCase();
  if (state === "CLEAN") return "MERGEABLE";
  if (state === "DIRTY") return "CONFLICTING";
  if (state && state !== "UNKNOWN") return state;
  if (row.mergeable === true) return "MERGEABLE";
  if (row.mergeable === false) return "CONFLICTING";
  return "UNKNOWN";
}
