/**
 * The forge-shaped request, before any gateway sees it (#4025).
 *
 * `rs_github` forwards whatever a caller composed, so the translation is where
 * a caller's authority stops. These tests pin the boundary as a PURE function:
 * what the envelope may carry, which paths belong to this Project, and which
 * mutations the outbox can make idempotent.
 */
import { describe, expect, it } from "vitest";

import { RedskilledGithubAuthorityError } from "../src/github-gateway.js";
import {
  githubRequestIdempotencyKey,
  githubRequestParams,
  planGithubRequest,
} from "../src/github-request.js";

const LABEL = "acme/widgets";

describe("the `_redskills/github_request` params envelope", () => {
  it("accepts exactly one request and nothing beside it", () => {
    expect(githubRequestParams({ request: { method: "GET", path: "issues/17" } }))
      .toEqual({ request: { method: "GET", path: "issues/17" } });
  });

  it.each([
    ["a named Project", { request: { method: "GET", path: "issues/17" }, project_id: "github:202" }],
    ["a named credential profile", { request: { method: "GET", path: "issues/17" }, credential_profile: "root" }],
    ["no request at all", {}],
    ["a request that is not an object", { request: "issues/17" }],
  ])("refuses %s", (_case, params) => {
    expect(() => githubRequestParams(params)).toThrow(RedskilledGithubAuthorityError);
  });
});

describe("planning one request against a Project", () => {
  it("reads an observing method through the gateway's REST read", () => {
    expect(planGithubRequest(LABEL, { method: "GET", path: "/issues/17" }))
      .toEqual({ mode: "read", path: "issues/17", read: { kind: "rest", path: "issues/17" } });
  });

  it("accepts the full repository path of THIS Project and strips it", () => {
    expect(planGithubRequest(LABEL, { method: "HEAD", path: "repos/acme/widgets/pulls?state=open" }))
      .toMatchObject({ mode: "read", path: "pulls?state=open" });
  });

  it.each([
    ["another repository", { method: "GET" as const, path: "repos/other/repo/issues/1" }],
    ["a traversal", { method: "GET" as const, path: "issues/../../admin" }],
    ["an empty path", { method: "GET" as const, path: "  " }],
    ["a caller-named header", { method: "GET" as const, path: "issues/17", headers: { accept: "application/json" } }],
    ["a field outside the envelope", { method: "GET" as const, path: "issues/17", cache: true } as never],
    ["a method that is not one", { method: "TRACE", path: "issues/17" } as never],
  ])("refuses %s", (_case, request) => {
    expect(() => planGithubRequest(LABEL, request)).toThrow(RedskilledGithubAuthorityError);
  });

  it("maps each declared mutation onto the outbox write that publishes it", () => {
    expect(planGithubRequest(LABEL, { method: "POST", path: "issues/17/comments", body: { body: "evidence" } }))
      .toMatchObject({ mode: "write", write: { write: { kind: "issue-publication", issue: 17, body: "evidence" } } });
    expect(planGithubRequest(LABEL, {
      method: "POST",
      path: "issues",
      body: { title: "Ticket", body: "why", labels: ["lane:go"] },
    })).toMatchObject({
      mode: "write",
      write: { write: { kind: "issue-publication", title: "Ticket", body: "why", labels: ["lane:go"] } },
    });
    expect(planGithubRequest(LABEL, {
      method: "POST",
      path: "pulls",
      body: { head: "worker/4025", base: "main", title: "Ship it", body: "Refs #4025" },
    })).toMatchObject({ mode: "write", write: { write: { kind: "pull-request", head: "worker/4025" } } });
  });

  it.each([
    ["a method the outbox cannot reconcile", { method: "PATCH" as const, path: "issues/17", body: { state: "closed" } }],
    ["a route the outbox does not publish", { method: "POST" as const, path: "releases", body: { tag_name: "v1" } }],
    ["a publication with no body", { method: "POST" as const, path: "issues/17/comments", body: {} }],
  ])("refuses %s", (_case, request) => {
    expect(() => planGithubRequest(LABEL, request)).toThrow(RedskilledGithubAuthorityError);
  });
});

describe("the outbox key a passthrough write is scheduled under", () => {
  it("is derived from the request, so a retry re-reaches the same entry", () => {
    const key = githubRequestIdempotencyKey("POST", "issues/17/comments", { body: "evidence" });

    expect(key).toMatch(/^ghreq-[0-9a-f]{48}$/);
    expect(githubRequestIdempotencyKey("POST", "issues/17/comments", { body: "evidence" })).toBe(key);
    expect(githubRequestIdempotencyKey("POST", "issues/17/comments", { body: "different" })).not.toBe(key);
    expect(githubRequestIdempotencyKey("POST", "issues/18/comments", { body: "evidence" })).not.toBe(key);
  });
});
