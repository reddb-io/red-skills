import { describe, expect, it, vi } from "vitest";
import { renderClaimComment } from "@reddb-io/worker/engine";

import { createMobileTicketDispatcher } from "../src/mobile-ticket-dispatch.js";

function harness(options: { labels?: string[]; competingClaim?: boolean } = {}) {
  const comments: Array<{ id: number; body: string }> = options.competingClaim
    ? [{ id: 3, body: renderClaimComment({ worker: "other:W0" }) }]
    : [];
  const events: string[] = [];
  const authorities: Array<{ projectId: string; credentialProfile: string }> = [];
  const reader = {
    async read(request: { path: string }) {
      if (request.path === "repos/reddb-io/red-skills") {
        return answer({
          id: 19,
          full_name: "reddb-io/red-skills",
          default_branch: "main",
          clone_url: "https://github.com/reddb-io/red-skills.git",
        });
      }
      if (request.path.endsWith("/issues/42")) {
        return answer({ state: "open", title: "Ship the circuit", labels: options.labels ?? ["type:feature"] });
      }
      if (request.path.endsWith("/issues/42/comments?per_page=100")) return answer([...comments]);
      throw new Error(`unexpected read ${request.path}`);
    },
    async write(request: { write: { body: string } }) {
      events.push("claim-write");
      const comment = { id: comments.length + 10, body: request.write.body };
      comments.push(comment);
      return answer(comment);
    },
  };
  const runTurn = vi.fn(async (request: { onBorn?: (workerId: string) => void }) => {
    events.push("run-turn");
    request.onBorn?.("Wmobile");
    return { workerId: "Wmobile", outcome: "landed" };
  });
  const dispatch = createMobileTicketDispatcher({
    paths: { projectWorkspaceRoot: "/daemon/projects" },
    hostState: () => ({ workers: [], daemon_version: "4.2.0" } as never),
    githubGateway: {
      credentialForProfile: async (profile) => profile === "personal" ? { secret: "token" } : null,
      credentialForProject: async () => null,
      gateway: {
        forProject(authority) {
          authorities.push(authority);
          return reader as never;
        },
      },
    },
    workspaceForRemote: async (identity) => ({
      ...identity,
      checkoutRoot: "/daemon/projects/red-skills/workspace",
      workspacePath: "/daemon/projects/red-skills/workspace",
    }),
    runTurn: runTurn as never,
  });
  return { dispatch, runTurn, events, authorities, comments };
}

describe("Mobile Ticket dispatch", () => {
  it("resolves, provisions and wins the claim before native Worker admission", async () => {
    const h = harness();

    await expect(h.dispatch({
      issue_url: "https://github.com/reddb-io/red-skills/issues/42",
    })).resolves.toEqual({
      version: 1,
      repository: "reddb-io/red-skills",
      ticket: 42,
      worker_id: "Wmobile",
    });

    expect(h.authorities.map((authority) => authority.credentialProfile)).toEqual(["personal", "personal"]);
    expect(h.authorities[1]?.projectId).toBe("github:19");
    expect(h.events).toEqual(["claim-write", "run-turn"]);
    expect(h.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      project: expect.objectContaining({ projectId: "github:19", credentialProfile: "personal" }),
      ticket: expect.objectContaining({ number: 42, base: "main", preclaimed: true }),
    }));
  });

  it.each([["type:spec"], ["blocked:dependency"], ["ready-for-human"]])(
    "refuses the lifecycle gate %s before claim or birth",
    async (label) => {
      const h = harness({ labels: [label] });
      await expect(h.dispatch({
        issue_url: "https://github.com/reddb-io/red-skills/issues/42",
      })).rejects.toThrow();
      expect(h.events).toEqual([]);
      expect(h.runTurn).not.toHaveBeenCalled();
    },
  );

  it("concedes and refuses when an earlier live remote claim exists", async () => {
    const h = harness({ competingClaim: true });
    await expect(h.dispatch({
      issue_url: "https://github.com/reddb-io/red-skills/issues/42",
    })).rejects.toThrow("already claimed by other:W0");
    expect(h.runTurn).not.toHaveBeenCalled();
    expect(h.comments.at(-1)?.body).toContain("kind=concede reason=lost");
  });
});

function answer(value: unknown) {
  return {
    version: 1,
    project_id: "github:19",
    credential_profile: "personal",
    source: "upstream",
    cache: { outcome: "miss", fetched_at: "2026-08-23T00:00:00.000Z", age_ms: 0, fresh_ms: 1 },
    budget: null,
    value,
  } as never;
}
