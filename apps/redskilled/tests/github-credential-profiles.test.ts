import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RedskilledGithubCredentialProfileError,
  createRedskilledGithubCredentialProfileResolver,
  readProjectGithubCredentialProfile,
} from "../src/github-credential-profiles.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(config?: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-profile-"));
  roots.push(root);
  if (config != null) {
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), [...config, ""].join("\n"));
  }
  return root;
}

function project(workspacePath: string) {
  return { projectId: "github:101", projectLabel: "acme/widgets", workspacePath };
}

describe("daemon-owned GitHub credential profiles", () => {
  it("uses the compatibility personal profile when Project config has no binding and re-resolves rotation", async () => {
    const workspacePath = await workspace();
    const tokens = ["personal-one", "personal-two"];
    const resolve = createRedskilledGithubCredentialProfileResolver({
      profiles: {},
      resolvePersonal: () => {
        const token = tokens.shift();
        return token == null ? null : { token };
      },
    });

    await expect(resolve(project(workspacePath))).resolves.toEqual({
      profile: "personal",
      credential: { secret: "personal-one" },
    });
    await expect(resolve(project(workspacePath))).resolves.toEqual({
      profile: "personal",
      credential: { secret: "personal-two" },
    });
  });

  it("binds Projects to independent named profiles and mints a fresh App installation credential", async () => {
    const engineering = await workspace([
      "plugins:",
      "  dev:",
      "    github:",
      "      credential_profile: engineering",
    ]);
    const release = await workspace([
      "plugins:",
      "  dev:",
      "    github:",
      "      credential_profile: release",
    ]);
    const minted: string[] = [];
    const resolve = createRedskilledGithubCredentialProfileResolver({
      profiles: {
        engineering: {
          kind: "github-app",
          appId: "1",
          installationId: "11",
          privateKeyPath: "~/.red/redskilled/credentials/engineering.pem",
        },
        release: {
          kind: "github-app",
          appId: "2",
          installationId: "22",
          privateKeyPath: "/credentials/release.pem",
        },
      },
      homeDir: "/daemon-home",
      resolvePersonal: () => ({ token: "must not fall back" }),
      mintInstallationToken: async (app) => {
        minted.push(`${app.appId}:${app.installationId}:${app.privateKeyPath}`);
        return `installation-${minted.length}`;
      },
    });

    await expect(resolve(project(engineering))).resolves.toEqual({
      profile: "engineering",
      credential: { secret: "installation-1" },
    });
    await expect(resolve(project(release))).resolves.toEqual({
      profile: "release",
      credential: { secret: "installation-2" },
    });
    await expect(resolve(project(engineering))).resolves.toEqual({
      profile: "engineering",
      credential: { secret: "installation-3" },
    });
    expect(minted).toEqual([
      "1:11:/daemon-home/.red/redskilled/credentials/engineering.pem",
      "2:22:/credentials/release.pem",
      "1:11:/daemon-home/.red/redskilled/credentials/engineering.pem",
    ]);
  });

  it("refuses an unknown binding without falling back to personal credentials", async () => {
    const workspacePath = await workspace([
      "plugins:",
      "  dev:",
      "    github:",
      "      credential_profile: missing",
    ]);
    let personalCalls = 0;
    const resolve = createRedskilledGithubCredentialProfileResolver({
      profiles: {},
      resolvePersonal: () => {
        personalCalls += 1;
        return { token: "fallback" };
      },
    });

    const refusal = await resolve(project(workspacePath)).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RedskilledGithubCredentialProfileError);
    expect((refusal as RedskilledGithubCredentialProfileError).refusal).toEqual({
      version: 1,
      kind: "github-credential-profile",
      reason: "unknown-profile",
      credential_profile: "missing",
    });
    expect(personalCalls).toBe(0);
  });

  it("refuses Project-owned credentials and reports no secret material", async () => {
    const workspacePath = await workspace([
      "plugins:",
      "  dev:",
      "    github:",
      "      credential_profile: personal",
      "      token: project-secret",
      "      private_key: |",
      "        -----BEGIN PRIVATE KEY-----",
      "        project-pem",
      "        -----END PRIVATE KEY-----",
    ]);

    const refusal = await readProjectGithubCredentialProfile(workspacePath).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RedskilledGithubCredentialProfileError);
    expect((refusal as RedskilledGithubCredentialProfileError).refusal.reason).toBe("project-credential-forbidden");
    expect(JSON.stringify((refusal as RedskilledGithubCredentialProfileError).refusal)).not.toMatch(/project-secret|project-pem|BEGIN/);
  });

  it("returns a typed secret-free refusal when personal credentials are missing", async () => {
    const workspacePath = await workspace();
    const resolve = createRedskilledGithubCredentialProfileResolver({
      profiles: {},
      resolvePersonal: () => null,
    });

    const refusal = await resolve(project(workspacePath)).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RedskilledGithubCredentialProfileError);
    expect((refusal as RedskilledGithubCredentialProfileError).refusal).toEqual({
      version: 1,
      kind: "github-credential-profile",
      reason: "missing-credentials",
      credential_profile: "personal",
    });
  });
});
