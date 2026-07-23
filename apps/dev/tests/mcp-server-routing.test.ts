import { describe, expect, it, vi } from "vitest";
import { main } from "../src/mcp-server.js";

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
});
