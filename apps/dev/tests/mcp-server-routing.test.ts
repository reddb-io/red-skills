import { describe, expect, it, vi } from "vitest";
import { connectResidentMcp, main } from "../src/mcp-server.js";

describe("dev:afk MCP entrypoint routing", () => {
  it("delegates __supervise to the native supervisor command", async () => {
    const supervise = vi.fn(async () => 0);
    const connect = vi.fn(async () => undefined);
    const startCurator = vi.fn(async () => undefined);
    const startMergeDriver = vi.fn(async () => undefined);

    await expect(
      main(["__supervise", "--fleet", "codex"], {
        supervise,
        connect,
        startCurator,
        startMergeDriver,
      }),
    ).resolves.toBe(0);

    expect(supervise).toHaveBeenCalledWith(["--fleet", "codex"]);
    expect(connect).not.toHaveBeenCalled();
    expect(startCurator).not.toHaveBeenCalled();
  });

  // #2918: `--help` fell into the unroutable-subcommand refusal below, so the
  // one question that asks which subcommands exist was answered by rejecting an
  // unknown one. Usage opens no transport and starts no supervisor.
  it.each([["--help"], ["-h"], ["help"]])("answers %s with usage, touching nothing", async (arg) => {
    const supervise = vi.fn(async () => 0);
    const connect = vi.fn(async () => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      main([arg], {
        supervise,
        connect,
        startCurator: async () => undefined,
        startMergeDriver: async () => undefined,
      }),
    ).resolves.toBe(0);

    expect(String(stdout.mock.calls[0]![0])).toContain("Usage: red-skills-castle-mcp");
    stdout.mockRestore();
    expect(supervise).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  // #2677: a slot spawned against this bundle used to fall through to the
  // resident path, contend on the singleton leases and die with an opaque
  // "singleton lease pid" error — deaths == respawns, zero drainage.
  it.each([["run"], ["run", "--once"], ["--once"], ["monitor"]])(
    "refuses the worker subcommand %s by name instead of opening a second resident",
    async (...argv: string[]) => {
      const connect = vi.fn(async () => undefined);
      const startCurator = vi.fn(async () => undefined);
      const startMergeDriver = vi.fn(async () => undefined);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(
        main(argv, { supervise: async () => 0, connect, startCurator, startMergeDriver }),
      ).resolves.toBe(2);

      expect(connect).not.toHaveBeenCalled();
      expect(startCurator).not.toHaveBeenCalled();
      expect(startMergeDriver).not.toHaveBeenCalled();
      expect(stderr.mock.calls[0]![0]).toContain(`unroutable subcommand ${JSON.stringify(argv[0])}`);
      stderr.mockRestore();
    },
  );

  // #2706: the lane's canary ships in THIS bundle, so the unroutable-subcommand
  // guard must let it through instead of refusing it like a worker subcommand.
  it("delegates __mcp-canary to the lane canary rather than refusing it", async () => {
    const canary = vi.fn(async () => 0);
    const connect = vi.fn(async () => undefined);

    await expect(
      main(["__mcp-canary", "--fleet", "canary"], {
        supervise: async () => 0,
        startCurator: async () => undefined,
        startMergeDriver: async () => undefined,
        connect,
        canary,
      }),
    ).resolves.toBe(0);

    expect(canary).toHaveBeenCalledWith(["--fleet", "canary"]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("starts the issue curator in the castle resident before opening stdio", async () => {
    const calls: string[] = [];

    await expect(
      main([], {
        supervise: async () => 0,
        startMergeDriver: async () => {
          calls.push("merge-driver");
        },
        startCurator: async () => {
          calls.push("curator");
        },
        connect: async () => {
          calls.push("connect");
        },
      }),
    ).resolves.toBe(0);

    expect(calls).toEqual(["curator", "merge-driver", "connect"]);
  });

  it("awaits resident cleanup after the MCP transport closes", async () => {
    let finishStop!: () => void;
    const resident = {
      start: vi.fn(async () => ({ acquired: true, reaped: false, lease: {} })),
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishStop = resolve;
          }),
      ),
    };
    const protocol: { onclose?: () => void } = {};
    const server = {
      server: protocol,
      connect: vi.fn(async () => undefined),
    };
    const janitor = {
      start: vi.fn(async () => ({ acquired: true, reaped: false, lease: {} })),
      stop: vi.fn(async () => undefined),
    };
    let finished = false;
    const running = connectResidentMcp({
      server: server as never,
      transport: {} as never,
      resident: resident as never,
      janitor: janitor as never,
    }).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(server.connect).toHaveBeenCalledTimes(1));
    expect(janitor.start).toHaveBeenCalledTimes(1);

    protocol.onclose?.();

    await vi.waitFor(() => expect(resident.stop).toHaveBeenCalledTimes(1));
    expect(janitor.stop).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    finishStop();
    await running;
    expect(finished).toBe(true);
  });
});
