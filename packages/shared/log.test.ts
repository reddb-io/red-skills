import { describe, it, expect } from "vitest";
import { createLogger } from "./log.js";

function capture(opts: Parameters<typeof createLogger>[0] = { serviceName: "t" }) {
  const lines: string[] = [];
  const log = createLogger({ now: () => "2026-01-01T00:00:00.000Z", write: (l) => lines.push(l), ...opts });
  return { log, lines };
}

describe("createLogger", () => {
  it("emits JSON in non-pretty mode with service + level + msg", () => {
    const { log, lines } = capture({ serviceName: "svc-afk", pretty: false });
    log.info("hello");
    expect(JSON.parse(lines[0]!)).toEqual({ ts: "2026-01-01T00:00:00.000Z", level: "info", msg: "hello", service: "svc-afk" });
  });

  it("merges a structured object (obj, msg)", () => {
    const { log, lines } = capture({ serviceName: "s", pretty: false });
    log.warn({ issue: 42 }, "blocked");
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", msg: "blocked", issue: 42 });
  });

  it("serializes an Error in err/error to {message, stack}", () => {
    const { log, lines } = capture({ serviceName: "s", pretty: false });
    log.error({ err: new Error("boom") }, "failed");
    const rec = JSON.parse(lines[0]!);
    expect(rec.err.message).toBe("boom");
    expect(typeof rec.err.stack).toBe("string");
  });

  it("respects the level threshold (debug dropped at info)", () => {
    const { log, lines } = capture({ serviceName: "s", level: "info", pretty: false });
    log.debug("noisy");
    log.info("kept");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).msg).toBe("kept");
  });

  it("pretty mode includes the level label + message", () => {
    const { log, lines } = capture({ serviceName: "s", pretty: true });
    log.error("nope");
    expect(lines[0]).toContain("ERROR");
    expect(lines[0]).toContain("nope");
  });

  it("child() carries bindings onto every record", () => {
    const { log, lines } = capture({ serviceName: "s", pretty: false });
    log.child({ worker: "wZ2R4" }).info("tick");
    expect(JSON.parse(lines[0]!)).toMatchObject({ worker: "wZ2R4", msg: "tick" });
  });
});
