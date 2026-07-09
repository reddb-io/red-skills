import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { pickAllowedEnv } from "@reddb-io/red-castle/sandboxes/no-sandbox";
import { AFK_HOST_ENV_ALLOWLIST, resolveHostEnvAllowlist } from "../src/core/host-env-allowlist.js";
import { buildLineRedactor } from "../src/runtime/outbound-redaction.js";

describe("AFK_HOST_ENV_ALLOWLIST", () => {
  const pick = (env: Record<string, string>) => pickAllowedEnv(env, AFK_HOST_ENV_ALLOWLIST);

  it("admits shell basics, ssh/git/gh auth, agent auth, RED_* and toolchains", () => {
    const admitted = pick({
      PATH: "/bin",
      HOME: "/home/x",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      GH_TOKEN: "t",
      GITHUB_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CODEX_HOME: "/home/x/.codex",
      RED_AFK_RUNNER: "codex",
      CARGO_TARGET_DIR: "/tmp/slot-1",
      PNPM_HOME: "/home/x/.pnpm",
      GOPATH: "/home/x/go",
      JAVA_HOME: "/usr/lib/jvm",
      LC_ALL: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/x/.config",
    });
    expect(Object.keys(admitted)).toHaveLength(15);
  });

  it("denies unrelated host secrets (default-deny)", () => {
    const denied = pick({
      AWS_SECRET_ACCESS_KEY: "leak",
      AWS_ACCESS_KEY_ID: "leak",
      GOOGLE_APPLICATION_CREDENTIALS: "/leak.json",
      SLACK_BOT_TOKEN: "leak",
      DOCKER_PASSWORD: "leak",
      MY_RANDOM_EXPORT: "leak",
      DATABASE_URL: "leak",
    });
    expect(denied).toEqual({});
  });

  it("the Go entries are enumerated so GOOGLE_* is never admitted by a glob", () => {
    const out = pick({ GOPATH: "x", GOOGLE_API_KEY: "leak" });
    expect(out).toEqual({ GOPATH: "x" });
  });
});

describe("resolveHostEnvAllowlist", () => {
  it("returns the default list when the override is unset", () => {
    expect(resolveHostEnvAllowlist({})).toBe(AFK_HOST_ENV_ALLOWLIST);
  });

  it("extends the default with comma-separated extra entries", () => {
    const out = resolveHostEnvAllowlist({ RED_AFK_HOST_ENV_ALLOW: "FOO, BAR_*" });
    expect(out).toContain("FOO");
    expect(out).toContain("BAR_*");
    expect(out).toContain("PATH");
  });

  it("the literal * escape hatch disables minimization entirely", () => {
    expect(resolveHostEnvAllowlist({ RED_AFK_HOST_ENV_ALLOW: "*" })).toBeUndefined();
    expect(resolveHostEnvAllowlist({ RED_AFK_HOST_ENV_ALLOW: "FOO,*" })).toBeUndefined();
  });
});

describe("buildLineRedactor", () => {
  it("precomputes inputs once and masks session links, env secrets, and home paths per line", () => {
    const redact = buildLineRedactor({
      env: { MY_TEST_TOKEN: "tok-abcdef-123456" },
      homeDir: "/home/alice",
      hostname: "host-a",
      hostReplacement: "hostfp",
    });
    expect(redact("x https://claude.ai/code/session_zz9 y")).toBe("x [REDACTED_CLAUDE_SESSION] y");
    expect(redact("value tok-abcdef-123456 end")).toBe("value [REDACTED_SECRET] end");
    expect(redact("/home/alice/w and /home/bob/w on host-a")).toBe(
      "[REDACTED_HOME]/w and /home/[REDACTED_USER]/w on hostfp",
    );
  });

  it("is idempotent and preserves machine markers", () => {
    const redact = buildLineRedactor({ env: {}, homeDir: homedir(), hostname: "host-a" });
    const marker = "<!-- afk:claim v1 worker=abc:w1 kind=claim runner=codex -->";
    expect(redact(marker)).toBe(marker);
    const once = redact("s https://claude.ai/code/session_a1");
    expect(redact(once)).toBe(once);
  });
});
