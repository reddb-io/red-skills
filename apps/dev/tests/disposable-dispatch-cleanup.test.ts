import { describe, expect, it, vi } from "vitest";
import { cleanupDisposableDispatchOnBootFailure } from "../src/commands/run/disposable-cleanup.js";

describe("cleanupDisposableDispatchOnBootFailure", () => {
  it("closes one targeted /go Ticket with lane/queue diagnostics after boot failure (#3175)", async () => {
    const comment = vi.fn(async (_issue: number, _body: string) => undefined);
    const close = vi.fn(async (_issue: number) => undefined);

    const result = await cleanupDisposableDispatchOnBootFailure(
      { comment, close },
      {
        declaredLane: "lane:go",
        consultedQueue: "ready-for-agent",
        filter: { kind: "issues", numbers: [66] },
        failureType: "session-error",
        failureReason: "requested issue(s) missing after 4 bounded reads",
        retainedDiagnostic: {
          path: ".red/tmp/diagnostics/wFAIL-session-error.log",
          retentionDays: 30,
        },
      },
    );

    expect(result).toEqual({ action: "closed", issue: 66 });
    expect(comment).toHaveBeenCalledOnce();
    expect(comment.mock.calls[0]![0]).toBe(66);
    expect(comment.mock.calls[0]![1]).toContain("declared lane: `lane:go`");
    expect(comment.mock.calls[0]![1]).toContain("consulted queue: `ready-for-agent`");
    expect(comment.mock.calls[0]![1]).toContain("failed during Worker boot");
    expect(comment.mock.calls[0]![1]).toContain(
      "refusal reason: `requested issue(s) missing after 4 bounded reads`",
    );
    expect(comment.mock.calls[0]![1]).toContain(
      "`.red/tmp/diagnostics/wFAIL-session-error.log` (retained for 30 days)",
    );
    expect(close).toHaveBeenCalledWith(66);
  });

  it("says plainly when a pre-lane failure retained no readable diagnosis", async () => {
    const comment = vi.fn(async (_issue: number, _body: string) => undefined);

    await cleanupDisposableDispatchOnBootFailure(
      { comment, close: vi.fn(async () => undefined) },
      {
        declaredLane: "lane:go",
        consultedQueue: "lane:go",
        filter: { kind: "issues", numbers: [3524] },
        failureType: "boot-error",
      },
    );

    expect(comment.mock.calls[0]![1]).toContain("No local diagnostics were retained");
    expect(comment.mock.calls[0]![1]).not.toContain("remain in the local Worker error lane");
  });

  it("never publishes an absolute diagnostic path", async () => {
    const comment = vi.fn(async (_issue: number, _body: string) => undefined);

    await cleanupDisposableDispatchOnBootFailure(
      { comment, close: vi.fn(async () => undefined) },
      {
        declaredLane: "lane:go",
        consultedQueue: "lane:go",
        filter: { kind: "issues", numbers: [3525] },
        failureType: "boot-error",
        retainedDiagnostic: { path: "/private/worker/boot-error.log", retentionDays: 30 },
      },
    );

    expect(comment.mock.calls[0]![1]).toContain("No local diagnostics were retained");
    expect(comment.mock.calls[0]![1]).not.toContain("/private/worker");
  });

  it("still closes the disposable Ticket when its explanatory comment fails", async () => {
    const close = vi.fn(async (_issue: number) => undefined);
    const result = await cleanupDisposableDispatchOnBootFailure(
      {
        comment: async () => {
          throw new Error("comment unavailable");
        },
        close,
      },
      {
        declaredLane: "lane:scout",
        consultedQueue: "lane:scout",
        filter: { kind: "issues", numbers: [67] },
        failureType: "boot-error",
      },
    );

    expect(result).toEqual({ action: "closed", issue: 67, commentFailed: true });
    expect(close).toHaveBeenCalledWith(67);
  });

  it("never closes fleet work or a multi-Ticket drain", async () => {
    const close = vi.fn(async (_issue: number) => undefined);
    const deps = {
      comment: vi.fn(async (_issue: number, _body: string) => undefined),
      close,
    };

    await expect(
      cleanupDisposableDispatchOnBootFailure(deps, {
        declaredLane: "ready-for-agent",
        consultedQueue: "ready-for-agent",
        filter: { kind: "issues", numbers: [68] },
        failureType: "session-error",
      }),
    ).resolves.toEqual({ action: "not-disposable" });
    await expect(
      cleanupDisposableDispatchOnBootFailure(deps, {
        declaredLane: "lane:go",
        consultedQueue: "lane:go",
        filter: { kind: "issues", numbers: [68, 69] },
        failureType: "session-error",
      }),
    ).resolves.toEqual({ action: "not-disposable" });
    expect(close).not.toHaveBeenCalled();
  });
});
