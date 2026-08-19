import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  classifyLaunchProbe,
  defaultLaunchProbe,
  launchProbeArgv,
  launchProbeRefusal,
} from "../src/launch-probe.js";

/**
 * Asked at registration, because 22 deaths later is too late.
 *
 * #4006 birthed 22 Workers from an argv that could not run, and a human found
 * it by reading a log. Every shipped binary answers `--version` offline without
 * a working machine, which is what makes it usable as a probe: one process, no
 * work, no side effect.
 */
describe("a launch that cannot run is refused at registration", () => {
  it("asks the launch to identify itself, and nothing more", () => {
    expect(launchProbeArgv(["npx", "-y", "-p", "@reddb-io/red-skills@4.0.0", "red-skills-redskilled"]))
      .toEqual(["npx", "-y", "-p", "@reddb-io/red-skills@4.0.0", "red-skills-redskilled", "--version"]);
  });

  it("calls an answer of zero runnable", () => {
    expect(classifyLaunchProbe({ status: 0 })).toBe("runnable");
  });

  it("refuses only when nothing ran", () => {
    expect(classifyLaunchProbe({ status: 127 })).toBe("unrunnable");
    expect(classifyLaunchProbe({ status: 126 })).toBe("unrunnable");
    expect(classifyLaunchProbe({ status: null, error: "spawn ENOENT" })).toBe("unrunnable");
  });

  it("keeps a binary that ran and disliked its arguments", () => {
    // It exists; the registration's own flags may simply not accept a trailing
    // `--version`, and refusing that would be the probe inventing a defect.
    expect(classifyLaunchProbe({ status: 2 })).toBe("runnable");
  });

  it("treats a slow cache as inconclusive, never as a refusal", () => {
    expect(classifyLaunchProbe({ status: null, timedOut: true })).toBe("inconclusive");
    expect(classifyLaunchProbe({ status: null, error: "EACCES: permission denied" })).toBe("inconclusive");
  });

  it("names the canonical form in its refusal, so an operator sees what works", () => {
    const refusal = launchProbeRefusal("a/b", ["red-skills-dev", "run"]);

    expect(refusal).toContain("npx -y -p @reddb-io/red-skills@<version>");
    expect(refusal).toContain("ADR 0091");
    expect(refusal).toContain("a/b");
  });

  it("probes a real command without a shell, and answers about a missing one", () => {
    expect(classifyLaunchProbe(defaultLaunchProbe([process.execPath]))).toBe("runnable");
    expect(classifyLaunchProbe(defaultLaunchProbe(["red-skills-a-binary-that-was-never-published"])))
      .toBe("unrunnable");
    expect(classifyLaunchProbe(defaultLaunchProbe([]))).toBe("inconclusive");
  });
});

describe("who asks the probe", () => {
  it("is the serving daemon, not every daemon a test constructs", async () => {
    const cli = await readFile(join(import.meta.dirname, "..", "src", "cli.ts"), "utf8");
    const lifecycle = await readFile(join(import.meta.dirname, "..", "src", "daemon", "lifecycle.ts"), "utf8");

    // Running a registration's argv is the one place the daemon touches a
    // string it otherwise only carries, so the reach is granted by the entry
    // that serves a real machine rather than assumed by the lifecycle.
    expect(cli).toContain("probeLaunch: defaultLaunchProbe");
    expect(lifecycle).not.toContain("options.probeLaunch ?? defaultLaunchProbe");
  });
});
