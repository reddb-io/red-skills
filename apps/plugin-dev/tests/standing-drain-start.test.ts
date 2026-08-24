/**
 * The seam that makes a standing declaration register (#4293).
 *
 * A project's standing block is documented as the way it stays registered across
 * daemon restarts. It only can be if something reads it on a surface that runs
 * without a human typing `drain`, and the MCP adapter's startup is that surface.
 */
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ensureStandingDrain,
  type StandingDrainStartDeps,
} from "../src/runtime/standing-drain-start.js";
import type { StandingDrainReading } from "../src/core/standing-drain-declaration.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const DECLARED: StandingDrainReading = {
  kind: "declared",
  standing: { runner: "claude-code", target: 1 },
};

function drainSpy() {
  return vi.fn(async (_input: Record<string, unknown>) => ({ status: "draining" }));
}

function warnSpy() {
  return vi.fn((_line: string) => undefined);
}

/** A registration composer that needs neither a checkout nor a git remote. */
const fakeInput: StandingDrainStartDeps["input"] = (root, version, stated) => ({
  ...stated,
  registration: { workspace_path: root, target: stated.target, argv: ["npx", version] },
});

describe("a project that declared a standing drain", () => {
  it("registers it at startup, with the declared runner and target", async () => {
    const drain = drainSpy();

    await expect(ensureStandingDrain({
      version: "4.1.27",
      root: () => "/repo",
      drain,
      warn: warnSpy(),
      reading: () => DECLARED,
      input: fakeInput,
    })).resolves.toEqual({ kind: "registered", runner: "claude-code", target: 1 });

    expect(drain).toHaveBeenCalledWith({
      runner: "claude-code",
      target: 1,
      registration: { workspace_path: "/repo", target: 1, argv: ["npx", "4.1.27"] },
    });
  });

  it("composes the registration through the shared namer, so its argv carries the declared runner", async () => {
    const drain = drainSpy();

    // No `input` seam: the real `drainInputFor` runs against this checkout.
    const outcome = await ensureStandingDrain({
      version: "4.1.27",
      root: () => REPO_ROOT,
      drain,
      warn: warnSpy(),
      reading: () => ({ kind: "declared", standing: { runner: "claude-code", target: 2 } }),
    });

    expect(outcome).toEqual({ kind: "registered", runner: "claude-code", target: 2 });
    const sent = drain.mock.calls[0]![0] as {
      readonly runner: string;
      readonly target: number;
      readonly registration: { readonly argv: readonly string[]; readonly target: number };
    };
    expect(sent.runner).toBe("claude-code");
    expect(sent.target).toBe(2);
    expect(sent.registration.target).toBe(2);
    expect(sent.registration.argv).toEqual(expect.arrayContaining(["--child-agent", "claude-code"]));
  });
});

describe("what the seam refuses to do", () => {
  it("registers NOTHING for a project that declared nothing — strictly opt-in", async () => {
    const drain = drainSpy();

    await expect(ensureStandingDrain({
      version: "4.1.27",
      root: () => "/repo",
      drain,
      warn: warnSpy(),
      reading: () => ({ kind: "absent" }),
      input: fakeInput,
    })).resolves.toEqual({ kind: "undeclared" });

    expect(drain).not.toHaveBeenCalled();
  });

  it("leaves an incomplete block inert and tells the operator", async () => {
    const drain = drainSpy();
    const warn = warnSpy();

    const outcome = await ensureStandingDrain({
      version: "4.1.27",
      root: () => "/repo",
      drain,
      warn,
      reading: () => ({
        kind: "incomplete",
        stated: ["afk.standing.runner"],
        missing: ["afk.standing.target"],
      }),
      input: fakeInput,
    });

    expect(outcome.kind).toBe("incomplete");
    expect(drain).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("afk.standing.target");
  });

  it("sends nothing when the checkout cannot name a repository, and says so to the operator", async () => {
    const drain = drainSpy();
    const warn = warnSpy();

    await expect(ensureStandingDrain({
      version: "4.1.27",
      root: () => "/repo",
      drain,
      warn,
      reading: () => DECLARED,
      // The shape `drainRegistrationFor` returns for a directory with no
      // `owner/name`: no registration, so there is no queue to register.
      input: (_root, _version, stated) => ({ ...stated }),
    })).resolves.toEqual({
      kind: "unregisterable",
      detail: expect.stringContaining("the declaration registers nothing"),
    });

    expect(drain).not.toHaveBeenCalled();
    // This outcome was silent: a declaration that could not register looked
    // identical to one that did.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("no owner/name repository");
  });

  it("never rejects when the daemon refuses — the tool surface outlives the daemon", async () => {
    const warn = warnSpy();

    const outcome = await ensureStandingDrain({
      version: "4.1.27",
      root: () => "/repo",
      drain: async () => {
        throw new Error("REDSKILLED_UNREACHABLE");
      },
      warn,
      reading: () => DECLARED,
      input: fakeInput,
    });

    expect(outcome.kind).toBe("unreachable");
    expect(warn.mock.calls[0]![0]).toContain("REDSKILLED_UNREACHABLE");
  });

  it("never rejects when the project root cannot be resolved", async () => {
    const drain = drainSpy();

    await expect(ensureStandingDrain({
      version: "4.1.27",
      root: async () => {
        throw new Error("no roots");
      },
      drain,
      warn: warnSpy(),
      reading: () => DECLARED,
      input: fakeInput,
    })).resolves.toMatchObject({ kind: "unreachable" });

    expect(drain).not.toHaveBeenCalled();
  });
});
