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
import type {
  RedskilledGithubWrite,
  RedskilledGithubWriteRequest,
} from "@reddb-io/protocol-acp";

// The request a caller sends is wire (ADR 0148): a Worker composes one without
// holding a credential. Everything below — custody, the durable receipt, the
// upstream call — is the gateway that answers it, and stays here.
export type { RedskilledGithubWrite, RedskilledGithubWriteRequest };

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
    const headers = { ...githubHeaders(input.credential.secret), "content-type": "application/json" };
    if (input.write.kind === "issue-transition") {
      return applyIssueTransition(input.write, {
        repository, marker, origin, fetchImpl, headers, clock,
        credentialProfile: input.project.credentialProfile,
      });
    }
    const request = apiWriteRequest(input.write, repository, marker);
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

/**
 * Apply one Ticket state transition: label adds and removes are naturally
 * idempotent upstream (adding a held label repeats it, deleting an absent one
 * answers 404), so only the explanatory comment rides the outbox marker.
 */
async function applyIssueTransition(
  write: Extract<RedskilledGithubWrite, { readonly kind: "issue-transition" }>,
  ctx: {
    readonly repository: string;
    readonly marker: string;
    readonly origin: string;
    readonly fetchImpl: typeof fetch;
    readonly headers: Record<string, string>;
    readonly clock: () => string;
    readonly credentialProfile: string;
  },
): Promise<unknown> {
  const issuePath = `${ctx.origin}/repos/${ctx.repository}/issues/${write.issue}`;
  if (write.add.length > 0) {
    const added = await ctx.fetchImpl(`${issuePath}/labels`, {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({ labels: [...write.add] }),
    });
    if (!added.ok) throw githubUpstreamRefusal("issue transition add", "rest", added, ctx.clock(), ctx.credentialProfile);
  }
  for (const label of write.remove) {
    const removed = await ctx.fetchImpl(`${issuePath}/labels/${encodeURIComponent(label)}`, {
      method: "DELETE",
      headers: ctx.headers,
    });
    // 404 is the label already absent — the state this removal wanted.
    if (!removed.ok && removed.status !== 404) {
      throw githubUpstreamRefusal("issue transition remove", "rest", removed, ctx.clock(), ctx.credentialProfile);
    }
  }
  let commented = false;
  if (write.comment != null) {
    const lookup = await ctx.fetchImpl(`${issuePath}/comments?per_page=100`, { method: "GET", headers: ctx.headers });
    if (!lookup.ok) throw githubUpstreamRefusal("issue transition reconciliation", "rest", lookup, ctx.clock(), ctx.credentialProfile);
    if (findMarkedPublication(await responseValue(lookup), ctx.marker) == null) {
      const body = `${write.comment}${write.comment.endsWith("\n") ? "" : "\n\n"}${ctx.marker}`;
      const posted = await ctx.fetchImpl(`${issuePath}/comments`, {
        method: "POST",
        headers: ctx.headers,
        body: JSON.stringify({ body }),
      });
      if (!posted.ok) throw githubUpstreamRefusal("issue transition comment", "rest", posted, ctx.clock(), ctx.credentialProfile);
    }
    commented = true;
  }
  return { issue: write.issue, added: [...write.add], removed: [...write.remove], commented };
}

function apiWriteRequest(
  write: Exclude<RedskilledGithubWrite, { readonly kind: "repository-push" | "issue-transition" }>,
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
  // The CANONICAL repository by URL, never the mirror's `origin`: the Project
  // mirror is cloned from the human checkout, so its `origin` is a local path —
  // the auth header is meaningless there, the refusal wrapped into a bare
  // "Internal error", and even a push that succeeded would have delivered the
  // branch to the wrong place. Every publish on this machine died here.
  const remote = `https://github.com/${input.project.projectLabel}.git`;
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["push", remote, `${write.sha}:${write.ref}`], {
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
    }, (error, _stdout, stderr) => error == null
      ? resolve()
      : reject(new Error(
        `redskilled repository push to ${remote} failed: ${String(stderr ?? "").trim() || error.message}`,
      )));
  });
  return { pushed: true, ref: write.ref, sha: write.sha };
}
