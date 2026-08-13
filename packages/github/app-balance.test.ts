import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createGithubAppBalanceTransport, mintGithubInstallationToken } from "./app-balance.js";
import { githubAppBlockIn, githubBalanceFileName, githubIdentityRef } from "./app-credential.js";
import type { GithubAppCredential } from "./app-credential.js";

// A real key, so the mint exercises the real signature rather than stopping at
// an unreadable file — the failure this pins is a REJECTED mint, not a missing
// one, and the two look identical from outside if nothing ever signs.
const keyRoot = mkdtempSync(join(tmpdir(), "app-balance-"));
const keyPath = join(keyRoot, "key.pem");
writeFileSync(
  keyPath,
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey,
);
afterAll(() => rmSync(keyRoot, { recursive: true, force: true }));

const APP: GithubAppCredential = {
  appId: "4575633",
  installationId: "153309957",
  privateKeyPath: keyPath,
};

describe("the App's ceiling is asked on the App's own credential", () => {
  it("mints a fresh installation token per ask, so nothing goes stale unwatched", async () => {
    const asked: string[] = [];
    let mints = 0;
    const transport = createGithubAppBalanceTransport({
      app: APP,
      mintToken: async () => `token-${++mints}`,
      fetchImpl: (async (url: string, init: { headers: Record<string, string> }) => {
        asked.push(`${String(url)} ${init.headers.authorization}`);
        return { ok: true, json: async () => ({ resources: {} }) };
      }) as unknown as typeof fetch,
    });

    await transport();
    await transport();

    // An installation token lives an hour and a balance ask is rare; a cached
    // one would expire exactly when nobody is looking.
    expect(mints).toBe(2);
    expect(asked[0]).toContain("bearer token-1");
    expect(asked[1]).toContain("bearer token-2");
    expect(asked[0]).toContain("/rate_limit");
  });

  it("honours an enterprise origin on the mint", async () => {
    const seen: string[] = [];
    const call = (async (url: string) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ token: "t" }) };
    }) as unknown as typeof fetch;

    const token = await mintGithubInstallationToken(APP, {
      origin: "https://ghe.example/api/v3",
      fetchImpl: call,
    });

    expect(token).toBe("t");
    expect(seen[0]).toBe("https://ghe.example/api/v3/app/installations/153309957/access_tokens");
  });

  it("refuses a granted response that carries no token", async () => {
    await expect(
      mintGithubInstallationToken(APP, {
        fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/carried no token/);
  });

  it("refuses a mint the server did not grant, rather than asking with an empty token", async () => {
    await expect(
      mintGithubInstallationToken(APP, {
        fetchImpl: (async () => ({ ok: false, status: 401 })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/401/);
  });
});

describe("two buckets are two files and two labels", () => {
  it("names the App's snapshot after its installation", () => {
    expect(githubBalanceFileName({ kind: "app", app: APP })).toBe("balance-app-153309957.toon");
    expect(githubBalanceFileName({ kind: "personal", token: "pat" })).toBe("balance.toon");
  });

  it("labels the rows so a plotted series knows whose ceiling it measures", () => {
    expect(githubIdentityRef({ kind: "app", app: APP })).toBe("app:153309957");
    expect(githubIdentityRef({ kind: "personal", token: "pat" })).toBe("pat");
  });
});

describe("one namer for where the App block lives", () => {
  // The daemon and the dev runtime parse the same file with different YAML
  // dependencies, so the PATH is the one thing they must agree on. Two hand
  // written navigations drift, and the drifted one reads no App at all — which
  // is indistinguishable from a host that declared none.
  it("finds the block the operator declares", () => {
    const document = {
      plugins: { dev: { redskilled: { github_app: { app_id: "1", installation_id: "2", private_key: "k" } } } },
    };
    expect(githubAppBlockIn(document)).toEqual({ app_id: "1", installation_id: "2", private_key: "k" });
  });

  it("answers null for every shape that does not carry one", () => {
    expect(githubAppBlockIn(null)).toBeNull();
    expect(githubAppBlockIn("not a document")).toBeNull();
    expect(githubAppBlockIn({})).toBeNull();
    expect(githubAppBlockIn({ plugins: { dev: {} } })).toBeNull();
    expect(githubAppBlockIn({ plugins: { dev: { redskilled: { worker_ceiling: 6 } } } })).toBeNull();
  });
});
