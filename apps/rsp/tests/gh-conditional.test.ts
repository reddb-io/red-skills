import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readGhConditionalJson } from "../src/gh-conditional.js";
import { createRspResidentGithubClient } from "../src/resident-github.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("gh conditional requests", () => {
  it("crosses the resident boundary and reuses its 304-backed answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsp-gh-conditional-"));
    roots.push(root);
    const seen: Array<{ url: string; etag: string | null }> = [];
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      baseUrl: "https://github.invalid/api/v3",
      retryCount: 0,
      throttle: false,
      fetchImpl: async (input, init) => {
        const etag = new Headers(init?.headers).get("if-none-match");
        seen.push({ url: String(input), etag });
        if (etag === '"issue-v1"') return new Response(null, { status: 304, headers: { etag } });
        return new Response(JSON.stringify({ number: 1975, state: "OPEN" }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"issue-v1"' },
        });
      },
    });
    const residentRead = github.read.bind(github);
    const request = {
      path: "repos/owner/repo/issues/1975",
      args: ["issue", "view", "1975"],
      cwd: root,
      telemetryRoot: root,
      residentRead,
    } as const;

    const first = await readGhConditionalJson(request);
    const second = await readGhConditionalJson(request);

    expect(first).toMatchObject({ status: 0, quotaFree: false });
    expect(second).toMatchObject({ status: 0, quotaFree: true });
    expect(second.stdout).toBe('{"number":1975,"state":"OPEN"}');
    expect(seen).toEqual([
      { url: "https://github.invalid/api/v3/repos/owner/repo/issues/1975", etag: null },
      { url: "https://github.invalid/api/v3/repos/owner/repo/issues/1975", etag: '"issue-v1"' },
    ]);
  });
});
