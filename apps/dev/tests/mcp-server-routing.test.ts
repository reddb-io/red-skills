import { describe, expect, it, vi } from "vitest";
import {
  connectResidentMcp,
  main,
  resolveCastleResidentBundle,
} from "../src/mcp-server.js";

describe("dev:afk MCP entrypoint routing", () => {
  it("resolves the dedicated Castle resident beside plain and versioned MCP bundles", () => {
    expect(resolveCastleResidentBundle("/plugin/dist/redskilled-mcp.bundle.min.mjs"))
      .toBe("/plugin/dist/castle-resident.bundle.min.mjs");
    expect(resolveCastleResidentBundle("/cache/dist/redskilled-mcp-3.18.6.bundle.min.mjs"))
      .toBe("/cache/dist/castle-resident-3.18.6.bundle.min.mjs");
  });
  // ADR 0130 Amendment 4 removed the per-project process (#2909), so
  // `__supervise` is no longer a role this bundle owns — it is refused by name
  // like any other unroutable subcommand rather than silently starting one.
  it("refuses the removed __supervise entrypoint by name", async () => {
    const connect = vi.fn(async () => undefined);
    const startCurator = vi.fn(async () => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(
      main(["__supervise"], {
        connect,
        startCurator,
        startMergeDriver: async () => undefined,
      }),
    ).resolves.toBe(2);

    expect(stderr.mock.calls[0]![0]).toContain('unroutable subcommand "__supervise"');
    stderr.mockRestore();
    expect(connect).not.toHaveBeenCalled();
    expect(startCurator).not.toHaveBeenCalled();
  });

  // #2918: `--help` fell into the unroutable-subcommand refusal below, so the
  // one question that asks which subcommands exist was answered by rejecting an
  // unknown one. Usage opens no transport and starts nothing.
  it.each([["--help"], ["-h"], ["help"]])("answers %s with usage, touching nothing", async (arg) => {
    const connect = vi.fn(async () => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(
      main([arg], {
        connect,
        startCurator: async () => undefined,
        startMergeDriver: async () => undefined,
      }),
    ).resolves.toBe(0);

    expect(String(stdout.mock.calls[0]![0])).toContain("Usage: red-skills-redskilled-mcp");
    stdout.mockRestore();
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
        main(argv, { connect, startCurator, startMergeDriver }),
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
        startCurator: async () => undefined,
        startMergeDriver: async () => undefined,
        connect,
        canary,
      }),
    ).resolves.toBe(0);

    expect(canary).toHaveBeenCalledWith(["--fleet", "canary"]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("starts the issue curator without reviving the retired session-bound merge driver", async () => {
    const calls: string[] = [];

    await expect(
      main([], {
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

    expect(calls).toEqual(["curator", "connect"]);
  });

  // #3014: on a repo operated through live sessions only, the resident is the
  // one thing awake when a human closes a dependent's last `req:*` blocker. The
  // Unblock belt has to start with it — and before the transport, since its own
  // first pass is detached and must not wait on the stdio handshake.
  it("starts the unblock belt in the redskilled MCP resident before opening stdio", async () => {
    const calls: string[] = [];

    await expect(
      main([], {
        startCurator: async () => {
          calls.push("curator");
        },
        startMergeDriver: async () => {
          calls.push("merge-driver");
        },
        startUnblockSweep: async () => {
          calls.push("unblock");
        },
        startSelfUpdate: async () => {
          calls.push("self-update");
        },
        connect: async () => {
          calls.push("connect");
        },
      }),
    ).resolves.toBe(0);

    expect(calls).toEqual(["curator", "unblock", "self-update", "connect"]);
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
