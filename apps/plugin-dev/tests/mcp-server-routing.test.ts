import { describe, expect, it, vi } from "vitest";
import { connectProjectMcp, main, resolveMcpProjectRoot } from "../src/mcp-server.js";

describe("MCP project root", () => {
  it("prefers an explicit host project directory over the plugin cwd", async () => {
    const client = {
      getClientCapabilities: () => ({ roots: { listChanged: true } }),
      listRoots: vi.fn(async () => ({ roots: [{ uri: "file:///wrong" }] })),
    };

    await expect(resolveMcpProjectRoot(client, {
      CLAUDE_PROJECT_DIR: "/workspace/project",
    }, "/installed/plugin")).resolves.toBe("/workspace/project");
    expect(client.listRoots).not.toHaveBeenCalled();
  });

  it("uses the MCP client root when the process cwd belongs to the installed plugin", async () => {
    const client = {
      getClientCapabilities: () => ({ roots: { listChanged: true } }),
      listRoots: vi.fn(async () => ({
        roots: [{ uri: "file:///home/cyber/workspace/red-skills", name: "red-skills" }],
      })),
    };

    await expect(resolveMcpProjectRoot(client, {}, "/installed/plugin"))
      .resolves.toBe("/home/cyber/workspace/red-skills");
  });

  it("falls back to cwd when the client does not publish roots", async () => {
    const client = {
      getClientCapabilities: () => ({}),
      listRoots: vi.fn(async () => ({ roots: [] })),
    };

    await expect(resolveMcpProjectRoot(client, {}, "/workspace/fallback"))
      .resolves.toBe("/workspace/fallback");
    expect(client.listRoots).not.toHaveBeenCalled();
  });
});

describe("dev:afk MCP entrypoint routing", () => {
  it.each([["__castle-resident"], ["__supervise"], ["run"], ["run", "--once"], ["--once"], ["monitor"]])(
    "refuses the removed private or Worker role %s",
    async (...argv: string[]) => {
      const connect = vi.fn(async () => undefined);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      await expect(main(argv, { connect })).resolves.toBe(2);

      expect(connect).not.toHaveBeenCalled();
      expect(stderr.mock.calls[0]![0]).toContain(`unroutable subcommand ${JSON.stringify(argv[0])}`);
      stderr.mockRestore();
    },
  );

  it.each([["--help"], ["-h"], ["help"]])("answers %s offline", async (arg) => {
    const connect = vi.fn(async () => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await expect(main([arg], { connect })).resolves.toBe(0);

    expect(String(stdout.mock.calls[0]![0])).toContain("Usage: red-skills-redskilled-mcp");
    expect(String(stdout.mock.calls[0]![0])).not.toContain("castle-resident");
    stdout.mockRestore();
    expect(connect).not.toHaveBeenCalled();
  });

  it("delegates __mcp-canary without opening ACP", async () => {
    const canary = vi.fn(async () => 0);
    const connect = vi.fn(async () => undefined);

    await expect(main(["__mcp-canary", "--fleet", "canary"], { connect, canary })).resolves.toBe(0);

    expect(canary).toHaveBeenCalledWith(["--fleet", "canary"]);
    expect(connect).not.toHaveBeenCalled();
  });

  it("opens only the ACP transport and ignores obsolete injected authorities", async () => {
    const calls: string[] = [];
    await expect(main([], {
      connect: async () => { calls.push("connect"); },
      startCurator: async () => { calls.push("curator"); },
      startMergeDriver: async () => { calls.push("merge-driver"); },
      startUnblockSweep: async () => { calls.push("unblock"); },
    })).resolves.toBe(0);

    expect(calls).toEqual(["connect"]);
  });

  it("ends transport projection on MCP close without adapter-owned cleanup", async () => {
    const protocol: { onclose?: () => void } = {};
    const server = {
      server: protocol,
      connect: vi.fn(async () => undefined),
    };
    let finished = false;
    const running = connectProjectMcp({
      server: server as never,
      transport: {} as never,
    }).then(() => { finished = true; });
    await vi.waitFor(() => expect(server.connect).toHaveBeenCalledOnce());
    expect(finished).toBe(false);

    protocol.onclose?.();
    await running;
    expect(finished).toBe(true);
  });

  it("runs boot-time project work once the transport is live, and does not wait on it (#4293)", async () => {
    // The seam a standing declaration registers through. It fires AFTER the
    // transport is up — so the session can already serve — and it is not
    // awaited, because a daemon that does not answer must not hold stdio.
    const protocol: { onclose?: () => void } = {};
    const order: string[] = [];
    const server = {
      server: protocol,
      connect: vi.fn(async () => { order.push("connect"); }),
    };
    let finished = false;
    const running = connectProjectMcp({
      server: server as never,
      transport: {} as never,
      afterConnect: () => { order.push("afterConnect"); },
    }).then(() => { finished = true; });

    await vi.waitFor(() => expect(order).toEqual(["connect", "afterConnect"]));
    expect(finished).toBe(false);

    protocol.onclose?.();
    await running;
  });
});
