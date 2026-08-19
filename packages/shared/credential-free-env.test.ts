import { describe, expect, it } from "vitest";

import { credentialFreeEnv, isCredentialEnvironmentName } from "./credential-free-env.js";

describe("the environment a disposable process may inherit", () => {
  it("refuses every GitHub and Git credential name", () => {
    for (const name of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_APP_KEY",
      "RED_GITHUB_APP_ID",
      "RED_GITHUB_APP_INSTALLATION",
      "RED_GITHUB_APP_KEY",
      "REDSKILLED_HOST_TOKEN",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ]) {
      expect(isCredentialEnvironmentName(name), name).toBe(true);
    }
  });

  // A door authenticates without carrying a secret, so a value-only sweep
  // leaves a working push behind.
  it("refuses the doors as well as the values", () => {
    for (const name of ["SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND"]) {
      expect(isCredentialEnvironmentName(name), name).toBe(true);
    }
  });

  it("keeps everything a Worker actually needs", () => {
    for (const name of ["PATH", "HOME", "RED_MODE", "NODE_OPTIONS", "GITHUB_REPOSITORY"]) {
      expect(isCredentialEnvironmentName(name), name).toBe(false);
    }
  });

  it("strips the credentials and the unset names from a whole environment", () => {
    expect(credentialFreeEnv({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "secret",
      SSH_AUTH_SOCK: "/run/agent.sock",
      RED_MODE: "spec-driven",
      UNSET: undefined,
    })).toEqual({ PATH: "/usr/bin", RED_MODE: "spec-driven" });
  });
});
