/**
 * The CLI's agent-facing stdout is TOON, not JSON (#2946).
 *
 * The daemon already speaks TOON everywhere it writes to disk — the event lane is
 * `.toonl`, the lease is `.toon` — and `stop`, `provision` and `reclaim` print it.
 * `host-state` and the three `unit` actions were the last surfaces still emitting
 * `JSON.stringify(..., null, 2)`, which is exactly the shape the mandate exists to
 * remove from an agent's context.
 *
 * **Each surface is pinned to its encoding, not merely to parsing.** A test that
 * only asserted "the output parses" would pass on JSON forever, because JSON is
 * also a document one can read; so every case compares against `encode(...)` byte
 * for byte AND asserts `JSON.parse` refuses it. The two escape hatches are pinned
 * the same way in the other direction: `--version --json` is a stated JSON opt-out
 * and stays JSON, and an error that quotes a path is quoting a string for
 * legibility rather than encoding a payload, so it keeps its quotes.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode as encodeToon } from "@reddb-io/toon";
import { readBuildInfo } from "@reddb-io/build-info";

const HOST_STATE = {
  version: 1,
  protocol_version: 1,
  daemon_version: "3.0.4",
  machine_id_hash: "abcd1234",
  session_key_hash: "beef5678",
  pid: 4242,
  started_at: "2026-07-31T10:00:00.000Z",
  workers: [
    {
      worker_id: "w-1",
      project_label: "alpha",
      pid: 4343,
      started_at: "2026-07-31T10:01:00.000Z",
      workspace_path: "/workspaces/alpha",
      isolated: true,
      warnings: [] as string[],
    },
  ],
  projects: [{ project_label: "alpha", workers: 1 }],
  budget_accounting: { promised_workers: 1 },
  upgrade: { running_version: "3.0.4", state: "current" },
};

vi.mock("../src/client.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/client.js")>();
  return { ...actual, readRedskilledHostState: async () => HOST_STATE };
});

const { runRedskilledCli, runUnit } = await import("../src/cli.js");
const { resolveRedskilledPaths } = await import("../src/paths.js");

const roots: string[] = [];
let printed: string;
const restore = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
  if (!restore.has(key)) restore.set(key, process.env[key]);
  process.env[key] = value;
}

beforeEach(() => {
  printed = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of restore) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  restore.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-toon-"));
  roots.push(root);
  return root;
}

/** The unit surfaces, on a machine with no systemd and no bundle on disk. */
async function unitFixture() {
  const root = await sessionRoot();
  setEnv("XDG_CONFIG_HOME", join(root, "config"));
  setEnv("REDSKILLED_BIN", join(root, "redskilled.bundle.min.mjs"));
  return {
    paths: resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    }),
    unitIO: {
      writeFile: async () => undefined,
      removeFile: async () => undefined,
      exists: () => true,
      run: () => ({ status: 0, stdout: "", stderr: "" }),
    },
  };
}

/** The whole assertion, in one place: this is TOON and it is not JSON. */
function expectToon(out: string, payload: unknown): void {
  expect(out).toBe(`${encodeToon(payload)}\n`);
  expect(() => JSON.parse(out) as unknown).toThrow();
}

describe("`redskilled host-state`", () => {
  it("prints the host's state as TOON", async () => {
    const code = await runRedskilledCli([]);

    expect(code).toBe(0);
    expectToon(printed, HOST_STATE);
    // The shape a reader recognises, stated rather than left to the encoder: keys
    // at column zero and a `workers[1]:` table head, not a brace in sight.
    expect(printed.startsWith("version: 1\n")).toBe(true);
    expect(printed).toContain("workers[1]");
    expect(printed).not.toContain("{");
  });
});

describe("`redskilled unit`", () => {
  it("prints `status` as TOON", async () => {
    const { paths, unitIO } = await unitFixture();
    let out = "";

    const code = await runUnit(["status"], { paths, unitIO, write: (text) => {
      out += text;
    } });

    expect(code).toBe(0);
    expectToon(out, {
      unitName: "redskilled.service",
      unitPath: join(process.env.XDG_CONFIG_HOME!, "systemd", "user", "redskilled.service"),
      installed: true,
      enabled: true,
      active: true,
      floor: "auto-spawn",
    });
    expect(out).toContain("floor: auto-spawn");
  });

  it("defaults to `status`, still as TOON", async () => {
    const { paths, unitIO } = await unitFixture();
    let out = "";

    await runUnit([], { paths, unitIO, write: (text) => {
      out += text;
    } });

    expect(out.startsWith("unitName: redskilled.service\n")).toBe(true);
    expect(() => JSON.parse(out) as unknown).toThrow();
  });

  it("prints `install` as TOON, steps and all", async () => {
    const { paths, unitIO } = await unitFixture();
    let out = "";

    const code = await runUnit(["install"], { paths, unitIO, write: (text) => {
      out += text;
    } });

    expect(code).toBe(0);
    expect(() => JSON.parse(out) as unknown).toThrow();
    expect(out).toContain("installed: true");
    // The step list is the part a JSON emitter would have spelled with braces.
    expect(out).toContain("steps[3]");
    expect(out).toContain("- step: write-unit");
    expect(out).toContain("- step: enable");
    expect(out).not.toContain("{");
  });

  it("prints `uninstall` as TOON", async () => {
    const { paths, unitIO } = await unitFixture();
    let out = "";

    const code = await runUnit(["uninstall"], { paths, unitIO, write: (text) => {
      out += text;
    } });

    expect(code).toBe(0);
    expect(() => JSON.parse(out) as unknown).toThrow();
    expect(out).toContain("installed: false");
    expect(out).toContain("- step: disable");
    expect(out).toContain("- step: remove-unit");
    expect(out).not.toContain("{");
  });

  it("keeps quoting the action it was given in the error it throws", async () => {
    const { paths, unitIO } = await unitFixture();

    // Quoting a bad word back at its author is legibility, not encoding: without
    // the quotes, `redskilled unit ""` reports an error naming nothing at all.
    await expect(runUnit(["bogus"], { paths, unitIO })).rejects.toThrow(
      'unsupported redskilled unit action "bogus": expected install, uninstall or status',
    );
  });
});

describe("`redskilled --version`", () => {
  it("keeps `--json` JSON — the stated opt-out the mandate does not govern", async () => {
    const code = await runRedskilledCli(["--version", "--json"]);

    expect(code).toBe(0);
    expect(printed).toBe(`${JSON.stringify(readBuildInfo("redskilled"))}\n`);
    expect(JSON.parse(printed) as { version: string }).toHaveProperty("version");
  });

  it("still prints the human stamp without `--json`", async () => {
    const code = await runRedskilledCli(["--version"]);

    expect(code).toBe(0);
    expect(printed).not.toContain("{");
  });
});
