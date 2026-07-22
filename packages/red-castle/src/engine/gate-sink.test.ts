import { describe, expect, it, vi } from "vitest";
import { makeHeadlessGateSink, makeInteractiveGateSink } from "./gate-sink.js";

describe("castle gate sinks", () => {
  it("headless sink parks intent escalations", async () => {
    const parkIntent = vi.fn(async () => {});
    const sink = makeHeadlessGateSink({ parkIntent });

    await expect(sink.intentFinding({ kind: "intent", description: "changes behavior" })).resolves.toBe("parked");

    expect(parkIntent).toHaveBeenCalledTimes(1);
  });

  it("interactive sink delegates decisions to caller prompts", async () => {
    const askIntent = vi.fn(async () => "approved" as const);
    const sink = makeInteractiveGateSink({ askIntent });

    await expect(sink.intentFinding({ kind: "intent", description: "changes behavior" })).resolves.toBe("approved");
  });
});
