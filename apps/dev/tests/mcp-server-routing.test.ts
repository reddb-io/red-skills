import { describe, expect, it, vi } from "vitest";
import { main } from "../src/mcp-server.js";

describe("dev:afk MCP entrypoint routing", () => {
  it("delegates __supervise to the native supervisor command", async () => {
    const supervise = vi.fn(async () => 0);
    const connect = vi.fn(async () => undefined);

    await expect(
      main(["__supervise", "--fleet", "codex"], { supervise, connect }),
    ).resolves.toBe(0);

    expect(supervise).toHaveBeenCalledWith(["--fleet", "codex"]);
    expect(connect).not.toHaveBeenCalled();
  });
});
