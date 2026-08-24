// The daemon has served `_redskills/go_dispatch` since ADR 0150 §3 with ZERO
// callers: the /go skill dispatched through `worker_dispatch`, which was
// declared unserved and refused before the wire — the whole /go lane was
// structurally dead. These tests pin the first slice-2 landing: a demand-form
// dispatch reaches the daemon method, and everything the one-field wire cannot
// express refuses by name instead of being dropped.
import { describe, expect, it, vi } from "vitest";

import { invokeProjectMcp } from "../src/project-acp-adapter.js";
import type { RedskillsProjectAcpSession } from "@reddb-io/redskilled/acp-client";

function sessionWith(goDispatch: (demand: string) => Promise<unknown>): RedskillsProjectAcpSession {
  return {
    goDispatch,
    control: async () => {
      throw new Error("worker_dispatch must not reach the control surface");
    },
    prompt: async () => {
      throw new Error("worker_dispatch must never degrade to a Worker prompt");
    },
  } as never;
}

describe("worker_dispatch serves the go_dispatch wire", () => {
  it("a demand dispatch reaches session.goDispatch and returns the daemon's answer", async () => {
    const goDispatch = vi.fn(async (demand: string) => ({
      version: 1,
      worker_id: "worker-go-1",
      ticket: 4390,
      lane: "lane:go",
      demand,
    }));

    const answer = await invokeProjectMcp(
      sessionWith(goDispatch),
      "worker_dispatch",
      { demand: "touch nothing; reply DONE" },
    );

    expect(goDispatch).toHaveBeenCalledWith("touch nothing; reply DONE");
    expect(answer).toMatchObject({ worker_id: "worker-go-1", ticket: 4390, lane: "lane:go" });
  });

  it("an issue-form dispatch is refused by name, not degraded or dropped", async () => {
    const goDispatch = vi.fn(async () => ({}));

    await expect(invokeProjectMcp(sessionWith(goDispatch), "worker_dispatch", { issue: 4280 }))
      .rejects.toThrow(/a tracked-issue dispatch rides the registered drain/);
    expect(goDispatch).not.toHaveBeenCalled();
  });

  it("mode and runner are refused by name — the wire carries the demand alone", async () => {
    const goDispatch = vi.fn(async () => ({}));

    await expect(invokeProjectMcp(
      sessionWith(goDispatch),
      "worker_dispatch",
      { demand: "do it", mode: "scout" },
    )).rejects.toThrow(/not expressible on the go_dispatch wire/);
    await expect(invokeProjectMcp(
      sessionWith(goDispatch),
      "worker_dispatch",
      { demand: "do it", runner: "codex" },
    )).rejects.toThrow(/not expressible on the go_dispatch wire/);
    expect(goDispatch).not.toHaveBeenCalled();
  });

  it("a dispatch naming neither issue nor demand keeps the schema's own refusal", async () => {
    await expect(invokeProjectMcp(sessionWith(async () => ({})), "worker_dispatch", {}))
      .rejects.toThrow(/exactly one of issue or demand/);
  });
});
