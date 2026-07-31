/**
 * `redskilled --help` answers on a host where nothing works (issue #2918).
 *
 * The bug was not that usage was wrong — it was that asking for it routed to the
 * default `host-state` command, which asks the daemon. The operator typing
 * `--help` is usually already lost: the daemon will not start, or they are
 * hunting for the subcommand that stops it. So the proof here is not "usage was
 * printed" but "usage was printed AND the client module was never touched",
 * because the first can be true while a daemon is spawned behind it.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reached: string[] = [];

vi.mock("../src/client.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/client.js")>();
  return {
    ...actual,
    ensureRedskilledDaemon: async () => {
      reached.push("ensureRedskilledDaemon");
      throw new Error("a help request must never start a daemon");
    },
    readRedskilledHostState: async () => {
      reached.push("readRedskilledHostState");
      return { workers: [] };
    },
    readRedskilledStatuslineString: async () => {
      reached.push("readRedskilledStatuslineString");
      return { lines: ["…"] };
    },
  };
});

const { REDSKILLED_USAGE, runRedskilledCli } = await import("../src/cli.js");
const { REDSKILLED_SESSION_ENV } = await import("../src/paths.js");

let session: string;
let printed: string;
let restoreSession: string | undefined;

beforeEach(async () => {
  reached.length = 0;
  printed = "";
  // A runtime dir with no socket in it: the unreachable host the bug needed.
  session = await mkdtemp(join(tmpdir(), "redskilled-help-"));
  restoreSession = process.env[REDSKILLED_SESSION_ENV];
  process.env[REDSKILLED_SESSION_ENV] = session;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    printed += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (restoreSession === undefined) delete process.env[REDSKILLED_SESSION_ENV];
  else process.env[REDSKILLED_SESSION_ENV] = restoreSession;
  await rm(session, { recursive: true, force: true });
});

describe("--help answers with the socket unreachable", () => {
  for (const token of ["--help", "-h", "help"]) {
    it(`answers \`${token}\` with the subcommand list`, async () => {
      const code = await runRedskilledCli([token]);

      expect(code).toBe(0);
      expect(printed).toBe(REDSKILLED_USAGE);
      expect(printed).toContain("serve");
      expect(printed).toContain("provision");
    });
  }

  it("starts no daemon and contacts no socket", async () => {
    await runRedskilledCli(["--help"]);

    // The whole defect, stated: usage may reach NOTHING in the client module.
    expect(reached).toEqual([]);
    expect(await readdir(session)).toEqual([]);
  });

  it("answers every subcommand's own help without dispatching it", async () => {
    for (const command of ["serve", "host-state", "statusline", "unit", "provision", "reclaim"]) {
      printed = "";

      const code = await runRedskilledCli([command, "--help"]);

      expect(code).toBe(0);
      expect(printed, `${command} --help printed nothing`).toContain(`redskilled ${command}`);
    }
    expect(reached).toEqual([]);
  });

  it("still reaches the daemon when no help was asked for — the check has teeth", () => {
    // Without this, a `runRedskilledCli` that short-circuited EVERYTHING would
    // pass the assertions above while doing nothing at all.
    return runRedskilledCli([]).then(() => {
      expect(reached).toEqual(["readRedskilledHostState"]);
    });
  });
});
