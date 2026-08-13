/**
 * The suite's daemon absence is its OWN (#2981).
 *
 * Every refusal test in this package asserts that no `redskilled` daemon
 * answers. Resolved from the ambient environment that assertion is about the
 * developer's machine, so a contributor running a daemon saw a red suite on
 * untouched code. These cases pin the pin: the isolation is wired as a setup
 * file, the derived socket is inside the sandbox, and nothing on the host can be
 * reached or started from here.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import { resolveRedskilledEntry } from "../../redskilled/src/daemon-entry.js";
import {
  ISOLATED_REDSKILLED_HOST_ROOT,
  pinIsolatedRedskilledHost,
} from "./support/redskilled-isolation.js";

const SETUP_FILE = "./tests/support/redskilled-isolation.ts";

describe("the test host is the sandbox's, not the operator's", () => {
  it("wires the isolation as a setup file, so no test has to remember it", () => {
    // The leak was a DEFAULT, so the cure has to be one too: a per-file pin is a
    // pin the next test file can forget, and forgetting is invisible until the
    // next machine with a live daemon runs the suite.
    const config = readFileSync(join(import.meta.dirname, "..", "vitest.config.ts"), "utf8");

    expect(config).toContain(SETUP_FILE);
  });

  it("resolves this session's socket inside the sandbox", () => {
    const paths = resolveRedskilledPaths();

    expect(paths.sessionKey).toContain(ISOLATED_REDSKILLED_HOST_ROOT);
    expect(paths.socketPath.startsWith(ISOLATED_REDSKILLED_HOST_ROOT)).toBe(true);
    // The machine claim lives in a SHARED directory by design, so an unpinned
    // read finds the live claim of the operator's daemon rather than nothing.
    expect(paths.machineClaimPath.startsWith(ISOLATED_REDSKILLED_HOST_ROOT)).toBe(true);
    // The durable host lane is derived from the daemon's home, independently
    // of its runtime and machine scope. Leaving HOME ambient lets sandbox
    // births and deaths cross into the operator's real daemon history.
    expect(paths.eventLanePath.startsWith(ISOLATED_REDSKILLED_HOST_ROOT)).toBe(true);
    expect(process.env.REDSKILLED_UNIT_DISCOVERY).toBe("off");
  });

  it("resolves an auto-spawn entry that cannot start a daemon", () => {
    // ADR 0130 rule 7 makes reaching a silent socket a START. Unpinned, a host
    // with a cached bundle answers its own refusal test by launching the daemon
    // whose absence is under assertion.
    const entry = resolveRedskilledEntry();

    expect(entry).toMatchObject({ source: "env-redskilled-bin" });
    expect((entry as { command: string }).command.startsWith(ISOLATED_REDSKILLED_HOST_ROOT)).toBe(true);
  });

  it("reaps the sandboxes of processes that are gone, and spares the living", () => {
    // A vitest worker is usually SIGKILLed at the end of a run, which runs no
    // exit hook: one suite left 362 directories in the temp dir before the
    // reaper existed. Keyed on a DEAD pid, so a run happening right now keeps its
    // own sandbox.
    const parent = dirname(ISOLATED_REDSKILLED_HOST_ROOT);
    const dead = spawnSync(process.execPath, ["-e", ""]).pid!;
    const abandoned = join(parent, String(dead));
    const living = join(parent, String(process.ppid));
    mkdirSync(join(abandoned, "runtime"), { recursive: true });
    mkdirSync(living, { recursive: true });

    try {
      pinIsolatedRedskilledHost({ ...process.env });

      expect(existsSync(abandoned)).toBe(false);
      expect(existsSync(living)).toBe(true);
      expect(existsSync(ISOLATED_REDSKILLED_HOST_ROOT)).toBe(true);
    } finally {
      rmSync(living, { recursive: true, force: true });
    }
  });
});
