/**
 * `rs_github` — the cross-plugin forge MCP (#4025, ADR 0147 §2, ADR 0132).
 *
 * The tool is one envelope, so the interesting behaviour is never in the tool:
 * it is what the daemon does with the envelope. These tests drive the whole
 * path an operator's call takes — the published schema, the params the adapter
 * shapes, the ACP binding, the Project gateway — against a STUB upstream, and
 * assert the three properties the passthrough exists to provide: two concurrent
 * identical reads cost one upstream call, a served cached read says how old it
 * is, and a mutation is scheduled through the durable outbox.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { bindAcpProjectGithubRequest } from "@reddb-io/redskilled/acp-github";
import {
  createRedskilledGithubGateway,
  type RedskilledGithubUpstream,
  type RedskilledGithubWriteUpstream,
} from "@reddb-io/redskilled/github-gateway";
import type { RedskilledGithubRequestAnswer } from "@reddb-io/redskilled/github-request";
import type { AcpProjectWorkspace } from "@reddb-io/redskilled/project-workspace";

import { createRsGithubTools, rsGithubRequestParams } from "../src/mcp-github/index.js";

const PROJECT: AcpProjectWorkspace = {
  projectId: "github:101",
  projectLabel: "acme/widgets",
  checkoutRoot: "/checkouts/widgets",
  workspacePath: "/project-workspaces/widgets",
};

interface Harness {
  /** Call the published tool exactly as a host would. */
  call(input: Record<string, unknown>): Promise<RedskilledGithubRequestAnswer>;
  readonly reads: () => number;
  readonly writes: () => readonly string[];
  close(): Promise<void>;
}

async function harness(options: {
  readonly upstream: RedskilledGithubUpstream;
  readonly clock?: () => string;
  readonly freshMs?: number;
} ): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "rs-github-"));
  const published = createRsGithubTools();
  const tool = published[0]!;
  const writes: string[] = [];
  const writeUpstream: RedskilledGithubWriteUpstream = async ({ idempotencyKey, write }) => {
    writes.push(`${idempotencyKey}:${write.kind}`);
    return { publication_id: idempotencyKey };
  };
  let reads = 0;
  const gateway = createRedskilledGithubGateway({
    upstream: (input) => {
      reads += 1;
      return options.upstream(input);
    },
    writeUpstream,
    outboxPath: join(root, "github-outbox.toon"),
    ...(options.clock == null ? {} : { clock: options.clock }),
    ...(options.freshMs == null ? {} : { freshMs: options.freshMs }),
  });
  const handle = bindAcpProjectGithubRequest(
    {
      gateway,
      credentialForProject: () => ({ profile: "engineering", credential: { secret: "daemon-only" } }),
    },
    () => PROJECT,
  );

  return {
    call(input) {
      // The adapter shapes the params; the binding validates them. Nothing here
      // shortcuts either, so a schema that drifted from the wire fails HERE.
      const params = rsGithubRequestParams(input) as { request: never };
      return handle({ params });
    },
    reads: () => reads,
    writes: () => writes,
    async close() {
      gateway.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("the `rs_github` surface", () => {
  it("publishes exactly one forge-shaped passthrough", () => {
    const tools = createRsGithubTools();

    expect(tools.map((tool) => tool.name)).toEqual(["github_request"]);
    expect(Object.keys(tools[0]!.inputSchema).sort()).toEqual(["body", "headers", "method", "path"]);
    expect(tools[0]!.method).toBe("_redskills/github_request");
  });

  it("nests the flat tool input under the one declared params key", () => {
    expect(rsGithubRequestParams({ method: "GET", path: "issues/17" })).toEqual({
      request: { method: "GET", path: "issues/17" },
    });
    expect(rsGithubRequestParams({ method: "POST", path: "issues", body: { title: "t" }, headers: {} })).toEqual({
      request: { method: "POST", path: "issues", body: { title: "t" }, headers: {} },
    });
  });
});

describe("a read through `rs_github`", () => {
  it("serves two concurrent identical reads from one upstream call", async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const stub = await harness({
      upstream: async () => {
        markStarted();
        await held;
        return { value: { number: 17, state: "open" }, budget: null };
      },
    });

    try {
      // One spells the path as the forge does, the other as the repository sees
      // it. Both are the same question, so both must join the same demand.
      const first = stub.call({ method: "GET", path: "issues/17" });
      const second = stub.call({ method: "GET", path: "/repos/acme/widgets/issues/17" });
      await started;
      release();
      const [left, right] = await Promise.all([first, second]);

      expect(stub.reads()).toBe(1);
      for (const answer of [left, right]) {
        expect(answer.mode).toBe("read");
        expect(answer.path).toBe("issues/17");
        expect(answer.answer).toMatchObject({
          project_id: "github:101",
          credential_profile: "engineering",
          value: { number: 17, state: "open" },
        });
      }
    } finally {
      await stub.close();
    }
  });

  it("stamps a cache-served answer with the age of what it served", async () => {
    let now = "2026-08-19T12:00:00.000Z";
    const stub = await harness({
      upstream: async () => ({ value: { number: 17 }, budget: null }),
      clock: () => now,
      freshMs: 60_000,
    });

    try {
      const fetched = await stub.call({ method: "GET", path: "issues/17" });
      expect(fetched.answer).toMatchObject({ source: "upstream", cache: { age_ms: 0 } });

      now = "2026-08-19T12:00:09.000Z";
      const cached = await stub.call({ method: "GET", path: "issues/17" });

      expect(stub.reads()).toBe(1);
      expect(cached.answer).toMatchObject({
        source: "cache",
        cache: { outcome: "fresh", fetched_at: "2026-08-19T12:00:00.000Z", age_ms: 9_000 },
      });
    } finally {
      await stub.close();
    }
  });

  it("refuses another repository, a caller-named header, and a body", async () => {
    const stub = await harness({ upstream: async () => ({ value: {}, budget: null }) });

    try {
      await expect(stub.call({ method: "GET", path: "repos/other/repo/issues/1" }))
        .rejects.toThrow(/cannot address another repository/);
      await expect(stub.call({
        method: "GET",
        path: "issues/17",
        headers: { authorization: "token smuggled-in-by-the-caller" },
      })).rejects.toThrow(/owns its own request headers/);
      await expect(stub.call({ method: "GET", path: "issues/17", body: { state: "closed" } }))
        .rejects.toThrow(/carries no body/);
      expect(stub.reads()).toBe(0);
    } finally {
      await stub.close();
    }
  });
});

describe("a write through `rs_github`", () => {
  it("schedules the mutation through the durable outbox and answers with its receipt", async () => {
    const stub = await harness({
      upstream: async () => ({ value: {}, budget: null }),
      clock: () => "2026-08-19T12:00:00.000Z",
    });

    try {
      const answer = await stub.call({
        method: "POST",
        path: "issues/17/comments",
        body: { body: "publication evidence" },
      });

      expect(answer.mode).toBe("write");
      expect(answer.answer).toMatchObject({
        project_id: "github:101",
        credential_profile: "engineering",
        state: "published",
        queued_at: "2026-08-19T12:00:00.000Z",
      });
      expect(stub.writes()).toEqual([`${(answer.answer as { idempotency_key: string }).idempotency_key}:issue-publication`]);
      expect((answer.answer as { idempotency_key: string }).idempotency_key).toMatch(/^ghreq-[0-9a-f]{48}$/);

      // The key is derived from the request, so the retry after a timeout whose
      // write may already have landed returns the FIRST receipt, not a second
      // comment. That is the whole point of routing a write through an outbox.
      const retried = await stub.call({
        method: "POST",
        path: "issues/17/comments",
        body: { body: "publication evidence" },
      });
      expect(retried.answer).toEqual(answer.answer);
      expect(stub.writes()).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  it("refuses a mutation the outbox cannot make idempotent, naming what it can", async () => {
    const stub = await harness({ upstream: async () => ({ value: {}, budget: null }) });

    try {
      await expect(stub.call({ method: "DELETE", path: "issues/17" }))
        .rejects.toThrow(/schedules no DELETE write/);
      await expect(stub.call({ method: "POST", path: "releases", body: { tag_name: "v1" } }))
        .rejects.toThrow(/issues\/<number>\/comments/);
      expect(stub.writes()).toEqual([]);
    } finally {
      await stub.close();
    }
  });
});
