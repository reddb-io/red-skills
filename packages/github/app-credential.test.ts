import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  GITHUB_APP_ID_ENV,
  GITHUB_APP_INSTALLATION_ENV,
  GITHUB_APP_KEY_ENV,
  readGithubAppCredentialFromEnv,
  readGithubAppPrivateKey,
  createGithubIdentityRouter,
  githubBalanceFileName,
  githubIdentityRef,
} from "./app-credential.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempKey(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), "app-credential-"));
  roots.push(root);
  const path = join(root, "app.pem");
  writeFileSync(path, contents);
  return path;
}

describe("the host's GitHub identity", () => {
  it("reads a complete App credential", () => {
    const path = tempKey("-----BEGIN RSA PRIVATE KEY-----\n");
    expect(readGithubAppCredentialFromEnv({
      [GITHUB_APP_ID_ENV]: "4575633",
      [GITHUB_APP_INSTALLATION_ENV]: "153309957",
      [GITHUB_APP_KEY_ENV]: path,
    })).toEqual({ appId: "4575633", installationId: "153309957", privateKeyPath: path });
  });

  it("answers null when no App is declared, because a person is a supported identity", () => {
    expect(readGithubAppCredentialFromEnv({})).toBeNull();
  });

  it("refuses a half-declared App instead of falling back to the shared personal bucket", () => {
    expect(() => readGithubAppCredentialFromEnv({ [GITHUB_APP_ID_ENV]: "4575633" }))
      .toThrow(/all three/);
    expect(() => readGithubAppCredentialFromEnv({
      [GITHUB_APP_ID_ENV]: "4575633",
      [GITHUB_APP_INSTALLATION_ENV]: "153309957",
    })).toThrow(new RegExp(GITHUB_APP_KEY_ENV));
  });

  it("names the path when the private key cannot be read", () => {
    expect(() => readGithubAppPrivateKey({
      appId: "1",
      installationId: "2",
      privateKeyPath: "/nonexistent/app.pem",
    })).toThrow(/\/nonexistent\/app\.pem/);
  });
});

describe("which identity pays, per repository", () => {
  const app = { appId: "4575633", installationId: "153309957", privateKeyPath: "/tmp/app.pem" };

  it("uses the App where it is installed and the person where it is not", async () => {
    const seen: string[] = [];
    const router = createGithubIdentityRouter({
      token: "pat",
      app,
      lookup: async (owner) => owner === "reddb-io",
      onDecision: (d) => seen.push(`${d.owner}/${d.repo}=${d.kind}`),
    });

    expect((await router.forRepo("reddb-io", "red-skills")).kind).toBe("app");
    // The daemon is host-global: the operator's own repository is outside the
    // installation and must still be paid for.
    expect((await router.forRepo("filipeforattini", "dotfiles")).kind).toBe("personal");
    expect(seen).toEqual(["reddb-io/red-skills=app", "filipeforattini/dotfiles=personal"]);
  });

  it("falls back to the person when coverage cannot be established", async () => {
    const reasons: string[] = [];
    const router = createGithubIdentityRouter({
      token: "pat",
      app,
      lookup: async () => null,
      onDecision: (d) => reasons.push(d.reason),
    });

    expect((await router.forRepo("reddb-io", "red-skills")).kind).toBe("personal");
    // An outage must not masquerade as "not installed".
    expect(reasons[0]).toMatch(/unknown/);
  });

  it("asks once per repository, because coverage changes at human speed", async () => {
    let asks = 0;
    const router = createGithubIdentityRouter({
      token: "pat",
      app,
      lookup: async () => { asks += 1; return true; },
    });

    await router.forRepo("reddb-io", "red-skills");
    await router.forRepo("reddb-io", "red-skills");
    await router.forRepo("reddb-io", "RED-SKILLS");
    expect(asks).toBe(1);
  });

  it("stays on the person when this host declares no App", async () => {
    const router = createGithubIdentityRouter({ token: "pat", lookup: async () => true });
    expect(await router.forRepo("reddb-io", "red-skills")).toEqual({ kind: "personal", token: "pat" });
  });
});

describe("two identities keep two balances", () => {
  const app = { appId: "4575633", installationId: "153309957", privateKeyPath: "/tmp/app.pem" };

  it("names the balance file after the identity that owns the bucket", () => {
    expect(githubBalanceFileName({ kind: "personal", token: "pat" })).toBe("balance.toon");
    expect(githubBalanceFileName({ kind: "app", app })).toBe("balance-app-153309957.toon");
  });

  it("labels each identity for the operator", () => {
    expect(githubIdentityRef({ kind: "personal", token: "pat" })).toBe("pat");
    expect(githubIdentityRef({ kind: "app", app })).toBe("app:153309957");
  });
});
