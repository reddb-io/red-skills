import { execFile } from "node:child_process";
import type {
  RedskilledGithubCredential,
  RedskilledGithubProjectAuthority,
} from "./github-gateway.js";
import {
  githubHeaders,
  githubUpstreamRefusal,
  responseValue,
} from "./github-transport.js";

export type RedskilledGithubWrite =
  | { readonly kind: "repository-push"; readonly ref: string; readonly sha: string }
  | {
      readonly kind: "pull-request";
      readonly head: string;
      readonly base: string;
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly kind: "issue-publication";
      /** Absent to open a Ticket; present to publish a comment on that Ticket. */
      readonly issue?: number;
      readonly title?: string;
      readonly body: string;
      /**
       * Labels stamped on a NEWLY opened Ticket.
       *
       * A lane label decides who may claim the Ticket, so stamping it in the
       * SAME call that opens the Ticket is what keeps the window shut: a Ticket
       * opened unlabelled and labelled a round-trip later is claimable by
       * whoever lists the queue in between.
       */
      readonly labels?: readonly string[];
    };

export interface RedskilledGithubWriteRequest {
  /** Stable caller-minted identity. Reusing it returns the durable receipt. */
  readonly idempotency_key: string;
  readonly write: RedskilledGithubWrite;
}

export interface RedskilledGithubWriteUpstreamInput {
  readonly project: RedskilledGithubProjectAuthority;
  readonly credential: RedskilledGithubCredential;
  readonly idempotencyKey: string;
  readonly write: RedskilledGithubWrite;
}

export type RedskilledGithubWriteUpstream = (
  input: RedskilledGithubWriteUpstreamInput,
) => Promise<unknown>;

export interface RedskilledGithubWriteAnswer {
  readonly version: 1;
  readonly project_id: string;
  readonly credential_profile: string;
  readonly idempotency_key: string;
  readonly state: "published";
  readonly queued_at: string;
  readonly published_at: string;
  readonly value: unknown;
}

export interface CreateRedskilledGithubWriteUpstreamOptions {
  readonly origin?: string;
  readonly fetchImpl?: typeof fetch;
  readonly pushRepository?: (input: RedskilledGithubWriteUpstreamInput) => Promise<unknown>;
  readonly clock?: () => string;
}

/** Reconcile the stable outbox marker before each authenticated publication. */
export function createRedskilledGithubWriteUpstream(
  options: CreateRedskilledGithubWriteUpstreamOptions = {},
): RedskilledGithubWriteUpstream {
  const origin = (options.origin ?? "https://api.github.com").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const pushRepository = options.pushRepository ?? pushCanonicalRepository;
  const clock = options.clock ?? (() => new Date().toISOString());

  return async (input) => {
    if (input.write.kind === "repository-push") return pushRepository(input);
    const repository = input.project.projectLabel.split("/").map(encodeURIComponent).join("/");
    const marker = githubOutboxMarker(input.idempotencyKey);
    const request = apiWriteRequest(input.write, repository, marker);
    const headers = { ...githubHeaders(input.credential.secret), "content-type": "application/json" };
    const lookup = await fetchImpl(`${origin}/${request.lookup}`, { method: "GET", headers });
    if (!lookup.ok) {
      throw githubUpstreamRefusal("write reconciliation", "rest", lookup, clock(), input.project.credentialProfile);
    }
    const existing = findMarkedPublication(await responseValue(lookup), marker);
    if (existing != null) return existing;

    const response = await fetchImpl(`${origin}/${request.path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      throw githubUpstreamRefusal("write", "rest", response, clock(), input.project.credentialProfile);
    }
    return responseValue(response);
  };
}

function apiWriteRequest(
  write: Exclude<RedskilledGithubWrite, { readonly kind: "repository-push" }>,
  repository: string,
  marker: string,
): { readonly lookup: string; readonly path: string; readonly body: Record<string, unknown> } {
  const marked = (body: string): string => `${body}${body.endsWith("\n") || body === "" ? "" : "\n\n"}${marker}`;
  if (write.kind === "pull-request") {
    const owner = repository.split("/", 1)[0]!;
    return {
      lookup: `repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${write.head}`)}` +
        `&base=${encodeURIComponent(write.base)}&per_page=100`,
      path: `repos/${repository}/pulls`,
      body: { head: write.head, base: write.base, title: write.title, body: marked(write.body) },
    };
  }
  if (write.issue != null) {
    return {
      lookup: `repos/${repository}/issues/${write.issue}/comments?per_page=100`,
      path: `repos/${repository}/issues/${write.issue}/comments`,
      body: { body: marked(write.body) },
    };
  }
  return {
    lookup: `repos/${repository}/issues?state=all&per_page=100`,
    path: `repos/${repository}/issues`,
    body: {
      title: write.title,
      body: marked(write.body),
      ...(write.labels == null || write.labels.length === 0 ? {} : { labels: [...write.labels] }),
    },
  };
}

function githubOutboxMarker(idempotencyKey: string): string {
  return `<!-- redskilled:github-outbox:${idempotencyKey} -->`;
}

function findMarkedPublication(value: unknown, marker: string): unknown | null {
  if (!Array.isArray(value)) return null;
  return value.find((candidate) =>
    candidate != null && typeof candidate === "object" &&
    typeof (candidate as Record<string, unknown>).body === "string" &&
    ((candidate as Record<string, unknown>).body as string).includes(marker)
  ) ?? null;
}

async function pushCanonicalRepository(input: RedskilledGithubWriteUpstreamInput): Promise<unknown> {
  if (input.write.kind !== "repository-push") throw new Error("repository push received a non-push write");
  const write = input.write;
  const authorization = Buffer.from(`x-access-token:${input.credential.secret}`, "utf8").toString("base64");
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["push", "origin", `${write.sha}:${write.ref}`], {
      cwd: input.project.workspacePath,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.extraHeader",
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
        GIT_TERMINAL_PROMPT: "0",
      },
      windowsHide: true,
      timeout: 60_000,
    }, (error) => error == null ? resolve() : reject(new Error("redskilled repository push failed", { cause: error })));
  });
  return { pushed: true, ref: write.ref, sha: write.sha };
}
