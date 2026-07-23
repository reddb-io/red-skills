import { describe, expect, it, vi } from "vitest";
import { connectResidentMcp, main } from "../src/mcp-server.js";

describe("dev:afk MCP entrypoint routing", () => {
  it("delegates __supervise to the native supervisor command", async () => {
    const supervise = vi.fn(async () => 0);
    const connect = vi.fn(async () => undefined);
    const startCurator = vi.fn(async () => undefined);

    await expect(
      main(["__supervise", "--fleet", "codex"], { supervise, connect, startCurator }),
    ).resolves.toBe(0);

    expect(supervise).toHaveBeenCalledWith(["--fleet", "codex"]);
    expect(connect).not.toHaveBeenCalled();
    expect(startCurator).not.toHaveBeenCalled();
  });

  it("starts the issue curator in the castle resident before opening stdio", async () => {
    const calls: string[] = [];

    await expect(
      main([], {
        supervise: async () => 0,
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
    let finished = false;
    const running = connectResidentMcp({
      server: server as never,
      transport: {} as never,
      resident: resident as never,
    }).then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(server.connect).toHaveBeenCalledTimes(1));

    protocol.onclose?.();

    await vi.waitFor(() => expect(resident.stop).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(finished).toBe(false);
    finishStop();
    await running;
    expect(finished).toBe(true);
  });
});
