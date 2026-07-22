export const GITHUB_GRAPHQL_BATCH_SIZE = 100;
export const GITHUB_REST_CONCURRENCY = 4;

export type GitHubRepositoryObjectKind = "issue" | "pullRequest";
export type GitHubRepositoryBatchField =
  | "id"
  | "number"
  | "title"
  | "state"
  | "labels"
  | "body"
  | "mergeable"
  | "checks"
  | "subIssues";

export interface GitHubAlias {
  alias: string;
  number: number;
}

export interface AliasedRepositoryOperation {
  kind: GitHubRepositoryObjectKind;
  query: string;
  aliases: GitHubAlias[];
  labelAliases: Array<{ alias: string; name: string }>;
}

export interface AliasedMutationOperation {
  query: string;
  aliases: GitHubAlias[];
}

export interface AliasedRepositoryRow {
  number: number;
  value?: Record<string, unknown>;
  error?: string;
}

export async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), values.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

const FIELD_SELECTIONS: Record<GitHubRepositoryBatchField, string> = {
  id: "id",
  number: "number",
  title: "title",
  state: "state",
  labels: "labels(first: 100) { nodes { id name } }",
  body: "body",
  mergeable: "mergeable",
  checks: [
    "commits(last: 1) {",
    "  nodes { commit { statusCheckRollup {",
    "    state",
    "    contexts(first: 100) { nodes {",
    "      __typename",
    "      ... on CheckRun { name status conclusion detailsUrl }",
    "      ... on StatusContext { context state targetUrl }",
    "    } }",
    "  } } }",
    "}",
  ].join("\n"),
  subIssues: "subIssues(first: 100) { nodes { number } }",
};

export function buildAliasedRepositoryQuery(
  kind: GitHubRepositoryObjectKind,
  numbers: readonly number[],
  fields: readonly GitHubRepositoryBatchField[],
  options: { labelNames?: readonly string[] } = {},
): AliasedRepositoryOperation {
  assertBatchNumbers(numbers);
  const prefix = kind === "issue" ? "i" : "p";
  const aliases = numbers.map((number, index) => ({ alias: `${prefix}${index}`, number }));
  const labelAliases = (options.labelNames ?? []).map((name, index) => ({ alias: `l${index}`, name }));
  const selected = uniqueFields(["id", "number", ...fields]);
  const selection = selected.map((field) => indent(FIELD_SELECTIONS[field], 6)).join("\n");
  const objectLines = aliases.map(({ alias, number }) => [
    `    ${alias}: ${kind}(number: ${number}) {`,
    selection,
    "    }",
  ].join("\n"));
  const labelLines = labelAliases.map(({ alias, name }) =>
    `    ${alias}: label(name: ${JSON.stringify(name)}) { id name }`
  );
  const query = [
    "query RspGitHubBatch($owner: String!, $repo: String!) {",
    "  repository(owner: $owner, name: $repo) {",
    ...objectLines,
    ...labelLines,
    "  }",
    "}",
  ].join("\n");
  return { kind, query, aliases, labelAliases };
}

export function parseAliasedRepositoryResponse(
  operation: AliasedRepositoryOperation,
  payload: unknown,
): AliasedRepositoryRow[] {
  const root = asRecord(payload);
  const data = asRecord(root.data);
  const repository = asRecord(data.repository);
  const errors = Array.isArray(root.errors) ? root.errors.map(asRecord) : [];
  return operation.aliases.map(({ alias, number }) => {
    const value = repository[alias];
    if (isRecord(value)) return { number, value };
    const error = errors.find((candidate) => {
      const path = candidate.path;
      return Array.isArray(path) && path.includes(alias);
    });
    return { number, error: stringValue(error?.message) || "not found" };
  });
}

export function buildAliasedLabelMutation(
  targets: readonly { number: number; nodeId: string }[],
  addLabelIds: readonly string[],
  removeLabelIds: readonly string[],
): AliasedMutationOperation {
  const aliases: GitHubAlias[] = [];
  const fields: string[] = [];
  targets.forEach((target, index) => {
    if (addLabelIds.length > 0) {
      const alias = `add${index}`;
      aliases.push({ alias, number: target.number });
      fields.push(
        `  ${alias}: addLabelsToLabelable(input: { labelableId: ${quote(target.nodeId)}, labelIds: ${stringList(addLabelIds)}, clientMutationId: ${quote(String(target.number))} }) { clientMutationId }`,
      );
    }
    if (removeLabelIds.length > 0) {
      const alias = `remove${index}`;
      aliases.push({ alias, number: target.number });
      fields.push(
        `  ${alias}: removeLabelsFromLabelable(input: { labelableId: ${quote(target.nodeId)}, labelIds: ${stringList(removeLabelIds)}, clientMutationId: ${quote(String(target.number))} }) { clientMutationId }`,
      );
    }
  });
  return {
    aliases,
    query: ["mutation RspEditLabels {", ...fields, "}"].join("\n"),
  };
}

export function buildAliasedSubIssueMutation(
  parent: { number: number; nodeId: string },
  children: readonly { number: number; nodeId: string }[],
): AliasedMutationOperation {
  const aliases = children.map((child, index) => ({ alias: `link${index}`, number: child.number }));
  const fields = children.map((child, index) =>
    `  link${index}: addSubIssue(input: { issueId: ${quote(parent.nodeId)}, subIssueId: ${quote(child.nodeId)}, clientMutationId: ${quote(String(child.number))} }) { clientMutationId }`
  );
  return {
    aliases,
    query: ["mutation RspLinkSubIssues {", ...fields, "}"].join("\n"),
  };
}

export function errorsByAlias(
  aliases: readonly GitHubAlias[],
  payload: unknown,
): Map<string, string> {
  const root = asRecord(payload);
  const errors = Array.isArray(root.errors) ? root.errors.map(asRecord) : [];
  const out = new Map<string, string>();
  for (const { alias } of aliases) {
    const match = errors.find((candidate) => Array.isArray(candidate.path) && candidate.path.includes(alias));
    if (match) out.set(alias, stringValue(match.message) || "mutation failed");
  }
  return out;
}

function assertBatchNumbers(numbers: readonly number[]): void {
  if (numbers.length === 0) throw new Error("at least one GitHub number is required");
  if (numbers.length > GITHUB_GRAPHQL_BATCH_SIZE) {
    throw new Error(`GitHub batch exceeds ${GITHUB_GRAPHQL_BATCH_SIZE} nodes`);
  }
  for (const number of numbers) {
    if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid GitHub number: ${number}`);
  }
}

function uniqueFields(fields: readonly GitHubRepositoryBatchField[]): GitHubRepositoryBatchField[] {
  return [...new Set(fields)];
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function stringList(values: readonly string[]): string {
  return `[${values.map(quote).join(", ")}]`;
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
