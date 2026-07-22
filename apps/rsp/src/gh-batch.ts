import { spawn, spawnSync } from "node:child_process";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import {
  buildAliasedLabelMutation,
  buildAliasedRepositoryQuery,
  buildAliasedSubIssueMutation,
  errorsByAlias,
  GITHUB_GRAPHQL_BATCH_SIZE,
  parseAliasedRepositoryResponse,
  type AliasedRepositoryOperation,
  type GitHubRepositoryBatchField,
} from "@reddb-io/shared/github-batch.js";

export interface GhBatchExecOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export type GhBatchExec = (args: readonly string[]) => Promise<GhBatchExecOutput>;

export interface GhBatchRunOptions {
  exec?: GhBatchExec;
  restConcurrency?: number;
  repo?: string;
}

export interface GhBatchResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number;
  signal: null;
  payload: JsonObject;
}

type BatchVerb = "issues" | "prs" | "edit-labels" | "link-sub-issues";

interface ParsedBatchCommand {
  verb: BatchVerb;
  numbers: number[];
  repo?: string;
  fields: string[];
  add: string[];
  remove: string[];
}

interface ReadFields {
  output: string[];
  query: GitHubRepositoryBatchField[];
}

const DEFAULT_REST_CONCURRENCY = 4;
const ISSUE_FIELDS = new Set(["number", "title", "state", "labels", "body"]);
const PR_FIELDS = new Set(["number", "title", "state", "mergeable", "checks", "checkRollup", "statusCheckRollup", "body"]);

export function isGhBatchCommand(argv: readonly string[]): boolean {
  return argv[0] === "gh" && ["issues", "prs", "edit-labels", "link-sub-issues"].includes(argv[1] ?? "");
}

export async function runGhBatchCommand(
  argv: readonly string[],
  options: GhBatchRunOptions = {},
): Promise<GhBatchResult> {
  const command = parseBatchCommand(argv);
  const repo = command.repo ?? options.repo ?? process.env.GH_REPO ?? resolveRepoFromGit();
  if (!repo || !repo.includes("/")) return usageResult(argv, "repository is required; pass --repo owner/repo");
  const exec = options.exec ?? execGh;
  const concurrency = Math.max(1, Math.floor(options.restConcurrency ?? DEFAULT_REST_CONCURRENCY));
  if (command.verb === "issues" || command.verb === "prs") {
    return await runRead(command, repo, exec, concurrency, argv);
  }
  if (command.verb === "edit-labels") return await runEditLabels(command, repo, exec, concurrency, argv);
  return await runLinkSubIssues(command, repo, exec, concurrency, argv);
}

async function runRead(
  command: ParsedBatchCommand,
  repo: string,
  exec: GhBatchExec,
  concurrency: number,
  argv: readonly string[],
): Promise<GhBatchResult> {
  const kind = command.verb === "issues" ? "issue" : "pullRequest";
  const fields = readFields(command);
  const rows: Array<{ number: number; value: JsonObject; failed: boolean }> = [];
  const errors: string[] = [];
  for (const numbers of chunks(command.numbers, GITHUB_GRAPHQL_BATCH_SIZE)) {
    const operation = buildAliasedRepositoryQuery(kind, numbers, fields.query);
    const response = await runGraphql(exec, repo, operation.query);
    if (isQuotaFailure(response)) {
      return await readRestFallback(command, repo, exec, concurrency, argv);
    }
    if (response.code !== 0) {
      errors.push(response.stderr);
      rows.push(...numbers.map((number) => ({
        number,
        value: { error: compactError(response) || `failed to read ${number}` },
        failed: true,
      })));
      continue;
    }
    rows.push(...parseAliasedRepositoryResponse(operation, parseJson(response.stdout)).map((row) => ({
      number: row.number,
      value: row.error ? { error: row.error } : projectRead(command.verb as "issues" | "prs", row.value ?? {}, fields.output),
      failed: Boolean(row.error),
    })));
  }
  const failures = rows.filter((row) => row.failed).length;
  return result({
    command: commandText(argv),
    transport: "graphql",
    order: command.numbers,
    [command.verb]: keyedRows(rows),
    summary: `${rows.length - failures}/${rows.length} read`,
  }, errors.length > 0 ? 1 : 0, errors.filter(Boolean).join("\n"));
}

async function readRestFallback(
  command: ParsedBatchCommand,
  repo: string,
  exec: GhBatchExec,
  concurrency: number,
  argv: readonly string[],
): Promise<GhBatchResult> {
  const fields = readFields(command);
  const surface = command.verb === "issues" ? "issues" : "pulls";
  const rows = await boundedMap(command.numbers, concurrency, async (number) => {
    const response = await exec(["api", `repos/${repo}/${surface}/${number}`]);
    if (response.code !== 0) return { number, value: { error: compactError(response) || "REST fallback failed" } };
    return { number, value: projectRestRead(command.verb as "issues" | "prs", asRecord(parseJson(response.stdout)), fields.output) };
  });
  const failures = rows.filter((row) => "error" in row.value).length;
  return result({
    command: commandText(argv),
    transport: "rest-fallback",
    degraded: "graphql-quota",
    concurrency,
    order: command.numbers,
    [command.verb]: keyedRows(rows),
    summary: `${rows.length - failures}/${rows.length} read via REST fallback`,
  });
}

async function runEditLabels(
  command: ParsedBatchCommand,
  repo: string,
  exec: GhBatchExec,
  concurrency: number,
  argv: readonly string[],
): Promise<GhBatchResult> {
  if (command.add.length === 0 && command.remove.length === 0) return usageResult(argv, "pass --add and/or --remove");
  const names = [...new Set([...command.add, ...command.remove])];
  const [identities, labelRows] = await Promise.all([
    lookupIssueIdentities(command.numbers, repo, exec, concurrency),
    boundedMap(names, concurrency, async (name) => {
      const response = await exec(["api", `repos/${repo}/labels/${encodeURIComponent(name)}`]);
      return { name, nodeId: stringValue(asRecord(parseJson(response.stdout)).node_id), error: response.code === 0 ? "" : compactError(response) };
    }),
  ]);
  const labels = new Map(labelRows.map((row) => [row.name, row.nodeId]));
  const missing = names.filter((name) => !labels.get(name));
  if (missing.length > 0) {
    return mutationResult(argv, command.numbers, keyed(command.numbers, () => ({ error: `label not found: ${missing.join(", ")}` })), "graphql");
  }
  const initial = new Map<number, JsonObject>(
    identities.filter((row) => row.error).map((row) => [row.number, { error: row.error! }]),
  );
  const targets = identities.flatMap((row) => row.nodeId ? [{ number: row.number, nodeId: row.nodeId }] : []);
  const operationsPerTarget = Number(command.add.length > 0) + Number(command.remove.length > 0);
  const chunkSize = Math.max(1, Math.floor(GITHUB_GRAPHQL_BATCH_SIZE / operationsPerTarget));
  for (const targetChunk of chunks(targets, chunkSize)) {
    const mutation = buildAliasedLabelMutation(
      targetChunk,
      command.add.map((name) => labels.get(name)!),
      command.remove.map((name) => labels.get(name)!),
    );
    const mutationResponse = await runGraphql(exec, repo, mutation.query);
    if (isQuotaFailure(mutationResponse)) return await editLabelsRestFallback(command, repo, exec, concurrency, argv);
    if (mutationResponse.code !== 0) {
      for (const target of targetChunk) initial.set(target.number, { error: compactError(mutationResponse) || "label mutation failed" });
      continue;
    }
    const errors = errorsByAlias(mutation.aliases, parseJson(mutationResponse.stdout));
    for (const target of targetChunk) {
      const aliases = mutation.aliases.filter((entry) => entry.number === target.number);
      const error = aliases.map((entry) => errors.get(entry.alias)).find(Boolean);
      initial.set(target.number, error ? { error } : { ok: true });
    }
  }
  return mutationResult(argv, command.numbers, mapToKeyed(command.numbers, initial), "graphql");
}

async function editLabelsRestFallback(
  command: ParsedBatchCommand,
  repo: string,
  exec: GhBatchExec,
  concurrency: number,
  argv: readonly string[],
): Promise<GhBatchResult> {
  const rows = await boundedMap(command.numbers, concurrency, async (number): Promise<{ number: number; value: JsonObject }> => {
    for (const label of command.remove) {
      const response = await exec(["api", "-X", "DELETE", `repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`]);
      if (response.code !== 0) return { number, value: { error: compactError(response) || `failed to remove label ${label}` } };
    }
    if (command.add.length > 0) {
      const args = ["api", "-X", "POST", `repos/${repo}/issues/${number}/labels`];
      for (const label of command.add) args.push("-f", `labels[]=${label}`);
      const response = await exec(args);
      if (response.code !== 0) return { number, value: { error: compactError(response) || "failed to add labels" } };
    }
    return { number, value: { ok: true } };
  });
  return mutationResult(argv, command.numbers, keyedRows(rows), "rest-fallback", concurrency);
}

async function runLinkSubIssues(
  command: ParsedBatchCommand,
  repo: string,
  exec: GhBatchExec,
  concurrency: number,
  argv: readonly string[],
): Promise<GhBatchResult> {
  if (command.numbers.length < 2) return usageResult(argv, "pass a parent and at least one child issue");
  const [parentNumber, ...children] = command.numbers;
  const identities = await lookupIssueIdentities(command.numbers, repo, exec, concurrency);
  const parent = identities[0];
  const parentId = parent?.nodeId;
  if (!parentId) {
    return mutationResult(argv, children, keyed(children, () => ({ error: parent?.error ?? "parent not found" })), "graphql");
  }
  const initial = new Map<number, JsonObject>();
  const childTargets = identities.slice(1).flatMap((row) => {
    if (!row.nodeId) {
      initial.set(row.number, { error: row.error ?? "child not found" });
      return [];
    }
    return [{ number: row.number, nodeId: row.nodeId }];
  });
  for (const targetChunk of chunks(childTargets, GITHUB_GRAPHQL_BATCH_SIZE)) {
    const mutation = buildAliasedSubIssueMutation({ number: parentNumber!, nodeId: parentId }, targetChunk);
    const mutationResponse = await runGraphql(exec, repo, mutation.query);
    if (isQuotaFailure(mutationResponse)) return await linkSubIssuesRestFallback(parentNumber!, children, repo, exec, concurrency, argv);
    if (mutationResponse.code !== 0) {
      for (const target of targetChunk) initial.set(target.number, { error: compactError(mutationResponse) || "sub-issue mutation failed" });
      continue;
    }
    const errors = errorsByAlias(mutation.aliases, parseJson(mutationResponse.stdout));
    for (const entry of mutation.aliases) {
      const error = errors.get(entry.alias);
      initial.set(entry.number, error ? { error } : { ok: true });
    }
  }
  return mutationResult(argv, children, mapToKeyed(children, initial), "graphql");
}

async function linkSubIssuesRestFallback(
  parent: number,
  children: readonly number[],
  repo: string,
  exec: GhBatchExec,
  concurrency: number,
  argv: readonly string[],
): Promise<GhBatchResult> {
  const rows = await boundedMap(children, concurrency, async (number): Promise<{ number: number; value: JsonObject }> => {
    const idResponse = await exec(["api", `repos/${repo}/issues/${number}`, "--jq", ".id"]);
    const id = Number(idResponse.stdout.trim());
    if (idResponse.code !== 0 || !Number.isSafeInteger(id) || id <= 0) {
      return { number, value: { error: compactError(idResponse) || "REST id lookup failed" } };
    }
    const link = await exec(["api", "-X", "POST", `repos/${repo}/issues/${parent}/sub_issues`, "-F", `sub_issue_id=${id}`]);
    return { number, value: link.code === 0 ? { ok: true } : { error: compactError(link) || "REST link failed" } };
  });
  return mutationResult(argv, children, keyedRows(rows), "rest-fallback", concurrency);
}

function mutationResult(
  argv: readonly string[],
  numbers: readonly number[],
  issues: JsonObject,
  transport: "graphql" | "rest-fallback",
  concurrency?: number,
): GhBatchResult {
  const failures = Object.values(issues).filter((value) => isRecord(value) && "error" in value).length;
  return result({
    command: commandText(argv),
    transport,
    ...(transport === "rest-fallback" ? { degraded: "graphql-quota", concurrency: concurrency ?? DEFAULT_REST_CONCURRENCY } : {}),
    order: [...numbers],
    issues,
    summary: `${numbers.length - failures}/${numbers.length} mutated`,
  });
}

function globalMutationFailure(
  command: ParsedBatchCommand,
  argv: readonly string[],
  response: GhBatchExecOutput,
  fallback: string,
): GhBatchResult {
  return result({
    command: commandText(argv),
    transport: "graphql",
    order: command.numbers,
    issues: keyed(command.numbers, () => ({ error: compactError(response) || fallback })),
    summary: `0/${command.numbers.length} mutated`,
  }, 1, response.stderr);
}

function readFields(command: ParsedBatchCommand): ReadFields {
  if (command.verb === "issues") {
    const requested = command.fields.length > 0 ? command.fields : ["title", "state", "labels", "body"];
    validateFields(requested, ISSUE_FIELDS);
    return { output: requested, query: requested as GitHubRepositoryBatchField[] };
  }
  const requested = command.fields.length > 0 ? command.fields : ["title", "state", "mergeable", "checks"];
  validateFields(requested, PR_FIELDS);
  return {
    output: requested,
    query: requested.map((field) => ["checkRollup", "statusCheckRollup"].includes(field) ? "checks" : field) as GitHubRepositoryBatchField[],
  };
}

function validateFields(fields: readonly string[], allowed: ReadonlySet<string>): void {
  const unknown = fields.find((field) => !allowed.has(field));
  if (unknown) throw new Error(`unknown GitHub batch field: ${unknown}`);
}

function projectRead(
  verb: "issues" | "prs",
  value: Record<string, unknown>,
  fields: readonly string[],
): JsonObject {
  const out: JsonObject = {};
  for (const field of fields) {
    if (field === "labels") out.labels = nodeRecords(value.labels).map((node) => stringValue(node.name)).filter(Boolean);
    else if (["checks", "checkRollup", "statusCheckRollup"].includes(field)) out[field] = projectChecks(value.commits);
    else if (field === "state" || field === "mergeable") out[field] = stringValue(value[field]).toLowerCase();
    else if (field !== "id" && field !== "subIssues") out[field] = scalar(value[field]);
  }
  if (!("number" in out)) out.number = numberValue(value.number);
  return out;
}

function projectRestRead(verb: "issues" | "prs", value: Record<string, unknown>, fields: readonly string[]): JsonObject {
  const out: JsonObject = {};
  for (const field of fields) {
    if (field === "labels") {
      const labels = Array.isArray(value.labels) ? value.labels.filter(isRecord) : [];
      out.labels = labels.map((label) => stringValue(label.name)).filter(Boolean);
    } else if (["checks", "checkRollup", "statusCheckRollup"].includes(field)) {
      out[field] = { state: "", contexts: [] };
    } else if (field === "state") {
      out.state = stringValue(value.state).toLowerCase();
    } else if (field === "mergeable") {
      const mergeable = value.mergeable;
      out.mergeable = typeof mergeable === "boolean" ? (mergeable ? "mergeable" : "conflicting") : "unknown";
    } else {
      out[field] = scalar(value[field]);
    }
  }
  if (!("number" in out)) out.number = numberValue(value.number);
  return out;
}

function projectChecks(commits: unknown): JsonObject {
  const commit = nodeRecords(commits).at(-1);
  const rollup = asRecord(asRecord(commit?.commit).statusCheckRollup);
  return {
    state: stringValue(rollup.state).toLowerCase(),
    contexts: nodeRecords(rollup.contexts).map((node) => ({
      name: stringValue(node.name) || stringValue(node.context),
      state: (stringValue(node.conclusion) || stringValue(node.status) || stringValue(node.state)).toLowerCase(),
    })) as JsonValue,
  };
}

async function runGraphql(exec: GhBatchExec, repo: string, query: string): Promise<GhBatchExecOutput> {
  const [owner, name] = splitRepo(repo);
  return await exec(["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `repo=${name}`]);
}

async function lookupIssueIdentities(
  numbers: readonly number[],
  repo: string,
  exec: GhBatchExec,
  concurrency: number,
): Promise<Array<{ number: number; nodeId?: string; databaseId?: number; error?: string }>> {
  return await boundedMap(numbers, concurrency, async (number) => {
    const response = await exec(["api", `repos/${repo}/issues/${number}`]);
    const value = asRecord(parseJson(response.stdout));
    const nodeId = stringValue(value.node_id);
    const databaseId = numberValue(value.id);
    if (response.code !== 0 || !nodeId) {
      return { number, error: compactError(response) || "REST issue lookup failed" };
    }
    return { number, nodeId, databaseId: databaseId > 0 ? databaseId : undefined };
  });
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < values.length; start += size) out.push(values.slice(start, start + size));
  return out;
}

async function boundedMap<T, R>(values: readonly T[], concurrency: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseBatchCommand(argv: readonly string[]): ParsedBatchCommand {
  if (!isGhBatchCommand(argv)) throw new Error("unsupported rsp gh batch command");
  const verb = argv[1] as BatchVerb;
  const numbers: number[] = [];
  const fields: string[] = [];
  const add: string[] = [];
  const remove: string[] = [];
  let repo: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--repo") repo = argv[++i];
    else if (arg === "--json") fields.push(...csv(argv[++i] ?? ""));
    else if (arg.startsWith("--json=")) fields.push(...csv(arg.slice(7)));
    else if (arg === "--add") add.push(...csv(argv[++i] ?? ""));
    else if (arg.startsWith("--add=")) add.push(...csv(arg.slice(6)));
    else if (arg === "--remove") remove.push(...csv(argv[++i] ?? ""));
    else if (arg.startsWith("--remove=")) remove.push(...csv(arg.slice(9)));
    else {
      const number = Number(arg);
      if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid GitHub number: ${arg}`);
      numbers.push(number);
    }
  }
  if (numbers.length === 0) throw new Error("at least one GitHub number is required");
  return { verb, numbers, repo, fields, add, remove };
}

function result(payload: JsonObject, status = 0, stderr = ""): GhBatchResult {
  return { stdout: Buffer.from(`${encode(payload)}\n`), stderr: Buffer.from(stderr), status, signal: null, payload };
}

function usageResult(argv: readonly string[], error: string): GhBatchResult {
  return result({ command: commandText(argv), category: "usage", error, help: "rsp gh --help", exit_code: 2 }, 2);
}

function keyed(numbers: readonly number[], value: (number: number) => JsonObject): JsonObject {
  return keyedRows(numbers.map((number) => ({ number, value: value(number) })));
}

function keyedRows(rows: readonly { number: number; value: JsonObject }[]): JsonObject {
  return Object.fromEntries(rows.map((row) => [String(row.number), row.value])) as JsonObject;
}

function mapToKeyed(numbers: readonly number[], values: ReadonlyMap<number, JsonObject>): JsonObject {
  return keyed(numbers, (number) => values.get(number) ?? { error: "mutation skipped" });
}

function isQuotaFailure(response: GhBatchExecOutput): boolean {
  return response.code !== 0 && /rate.?limit|rate_limit|RATE_LIMITED|quota/i.test(`${response.stderr}\n${response.stdout}`);
}

function compactError(response: GhBatchExecOutput): string {
  return (response.stderr || response.stdout).trim().split("\n")[0]?.slice(0, 240) ?? "";
}

function parseJson(value: string): unknown {
  try {
    return value.trim() ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function nodeRecords(value: unknown): Record<string, unknown>[] {
  const nodes = asRecord(value).nodes;
  return Array.isArray(nodes) ? nodes.filter(isRecord) : [];
}

function scalar(value: unknown): JsonValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : "";
}

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function csv(value: string): string[] {
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function splitRepo(repo: string): [string, string] {
  const slash = repo.indexOf("/");
  return [repo.slice(0, slash), repo.slice(slash + 1)];
}

function commandText(argv: readonly string[]): string {
  return `rsp ${argv.join(" ")}`;
}

function resolveRepoFromGit(): string | undefined {
  const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], { encoding: "utf8" });
  if (remote.status !== 0) return undefined;
  const match = remote.stdout.trim().match(/(?:github\.com[/:])([^/]+)\/([^/]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

async function execGh(args: readonly string[]): Promise<GhBatchExecOutput> {
  const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  return await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
