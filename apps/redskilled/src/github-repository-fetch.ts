import { execFile } from "node:child_process";
import type { RedskilledGithubUpstreamInput } from "./github-gateway.js";

/** Fetch one canonical ref without exposing the daemon-owned credential. */
export async function fetchCanonicalRepository(input: RedskilledGithubUpstreamInput): Promise<unknown> {
  if (input.read.kind !== "repository-fetch") throw new Error("repository fetch received a non-fetch read");
  const authorization = Buffer.from(`x-access-token:${input.credential.secret}`, "utf8").toString("base64");
  const args = ["fetch", "--no-tags", "origin", ...(input.read.ref == null ? [] : [input.read.ref])];
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, {
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
    }, (error) => error == null ? resolve() : reject(new Error("redskilled repository fetch failed", { cause: error })));
  });
  return { fetched: true, ref: input.read.ref ?? null };
}
