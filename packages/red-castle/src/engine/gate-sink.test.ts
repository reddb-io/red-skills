import { describe, expect, it, vi } from "vitest";
import { makeHeadlessGateSink, makeInteractiveGateSink } from "./gate-sink.js";

describe("castle gate sinks", () => {
  it("headless sink parks intent and sensitive-path escalations", async () => {
    const parkIntent = vi.fn(async () => {});
    const parkSensitivePath = vi.fn(async () => {});
    const sink = makeHeadlessGateSink({ parkIntent, parkSensitivePath });

    await expect(sink.intentFinding({ kind: "intent", description: "changes behavior" })).resolves.toBe("parked");
    await expect(sink.sensitivePath({ path: ".red/config.yaml", reason: "trust/gate configuration" })).resolves.toBe("parked");

    expect(parkIntent).toHaveBeenCalledTimes(1);
    expect(parkSensitivePath).toHaveBeenCalledTimes(1);
  });

  it("interactive sink delegates decisions to caller prompts", async () => {
    const askIntent = vi.fn(async () => "approved" as const);
    const askSensitivePath = vi.fn(async () => "skipped" as const);
    const sink = makeInteractiveGateSink({ askIntent, askSensitivePath });

    await expect(sink.intentFinding({ kind: "intent", description: "changes behavior" })).resolves.toBe("approved");
    await expect(sink.sensitivePath({ path: ".github/workflows/ci.yml", reason: "CI workflow file" })).resolves.toBe("skipped");
  });
});
