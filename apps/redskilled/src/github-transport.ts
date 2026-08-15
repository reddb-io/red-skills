import { GithubBackpressureError, classifyGithubLimit } from "@reddb-io/github";
import {
  RedskilledGithubCredentialProfileError,
  githubCredentialScopeRefusal,
} from "./github-credential-profiles.js";

export function githubHeaders(secret: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${secret}`,
    "x-github-api-version": "2022-11-28",
  };
}

export async function responseValue(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("json") ? response.json() : response.text();
}

export function githubUpstreamRefusal(
  surface: string,
  pool: "rest" | "graphql" | "search",
  response: Response,
  now: string,
  profile: string,
): Error {
  const observed = {
    status: response.status,
    response: { headers: Object.fromEntries(response.headers.entries()) },
  };
  const fact = classifyGithubLimit(observed, pool, Date.parse(now));
  if (fact != null) return new GithubBackpressureError(fact);
  if (response.status === 401) {
    return new RedskilledGithubCredentialProfileError("invalid-credentials", profile);
  }
  if (response.status === 403) return githubCredentialScopeRefusal(profile);
  return new Error(`redskilled GitHub ${surface} failed with status ${response.status}`);
}
