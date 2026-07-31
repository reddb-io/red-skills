import { describe, expect, it } from "vitest";
import {
  createProducerReplacementWatch,
  DEFAULT_PRODUCER_REPLACE_CHECK_MS,
  handOverProducer,
  isLocalProducerBuild,
  planProducerReplacement,
  producerReplaceCheckMs,
  type ProducerHandover,
} from "../src/core/producer-self-replace.js";

describe("planProducerReplacement", () => {
  it("adopts a newer published version inside the running major", () => {
    expect(planProducerReplacement({ running: "3.0.3", published: "3.0.4" })).toEqual({
      act: "replace",
      to: "3.0.4",
    });
  });

  it("holds when the published version is the running one", () => {
    expect(planProducerReplacement({ running: "3.0.4", published: "3.0.4" })).toEqual({
      act: "hold",
      reason: "no-newer-version",
    });
  });

  it("holds when the published version is older than the running one", () => {
    expect(planProducerReplacement({ running: "3.0.4", published: "3.0.3" })).toEqual({
      act: "hold",
      reason: "no-newer-version",
    });
  });

  it("holds when the published version could not be resolved", () => {
    expect(planProducerReplacement({ running: "3.0.3", published: null })).toEqual({
      act: "hold",
      reason: "published-unknown",
    });
    expect(planProducerReplacement({ running: "3.0.3", published: "not-a-version" })).toEqual({
      act: "hold",
      reason: "published-unknown",
    });
  });

  it("never replaces a local build, however far ahead the registry is", () => {
    expect(planProducerReplacement({ running: "0.0.0-dev", published: "9.9.9" })).toEqual({
      act: "hold",
      reason: "local-build",
    });
    expect(planProducerReplacement({ running: "3.0.3+local", published: "3.0.4" })).toEqual({
      act: "hold",
      reason: "local-build",
    });
  });

  it("holds a major boundary rather than crossing it on a timer", () => {
    expect(planProducerReplacement({ running: "3.0.3", published: "4.0.0" })).toEqual({
      act: "hold",
      reason: "major-held",
    });
  });
});

describe("isLocalProducerBuild", () => {
  it("reads a prerelease, a build-metadata version and anything unparseable as local", () => {
    expect(isLocalProducerBuild("0.0.0-dev")).toBe(true);
    expect(isLocalProducerBuild("3.0.3+local")).toBe(true);
    expect(isLocalProducerBuild("")).toBe(true);
    expect(isLocalProducerBuild("3.0.3")).toBe(false);
  });
});

describe("producerReplaceCheckMs", () => {
  it("defaults to the daemon's cadence and accepts an operator override", () => {
    expect(producerReplaceCheckMs({})).toBe(DEFAULT_PRODUCER_REPLACE_CHECK_MS);
    expect(producerReplaceCheckMs({ RED_AFK_REPLACE_CHECK_MS: "60000" })).toBe(60_000);
    expect(producerReplaceCheckMs({ RED_AFK_REPLACE_CHECK_MS: "0" })).toBe(0);
    expect(producerReplaceCheckMs({ RED_AFK_REPLACE_CHECK_MS: "junk" })).toBe(
      DEFAULT_PRODUCER_REPLACE_CHECK_MS,
    );
  });
});

describe("createProducerReplacementWatch", () => {
  it("reproduces the observed case: a producer on 3.0.3 adopts the published 3.0.4", async () => {
    // The fixture the issue describes: the producer resolved 3.0.3 at launch while
    // npm already served 3.0.4, and the skew stood indefinitely because nothing
    // asked again. One tick of the watch is the whole cure.
    const published = ["3.0.3", "3.0.3", "3.0.4"];
    let probes = 0;
    const watch = createProducerReplacementWatch({
      running: "3.0.3",
      probePublished: async () => published[Math.min(probes++, published.length - 1)] ?? null,
    });

    expect(await watch.tick()).toEqual({ act: "hold", reason: "no-newer-version" });
    expect(watch.decided()).toBeNull();
    await watch.tick();
    expect(watch.decided()).toBeNull();

    expect(await watch.tick()).toEqual({ act: "replace", to: "3.0.4" });
    expect(watch.decided()).toEqual({ act: "replace", to: "3.0.4" });
    expect(probes).toBe(3);
  });

  it("keeps the first decision once made, so a flapping registry cannot unmake it", async () => {
    const answers = ["3.0.4", "3.0.3"];
    let probes = 0;
    const watch = createProducerReplacementWatch({
      running: "3.0.3",
      probePublished: async () => answers[probes++] ?? null,
    });

    await watch.tick();
    expect(watch.decided()).toEqual({ act: "replace", to: "3.0.4" });
    expect(await watch.tick()).toEqual({ act: "replace", to: "3.0.4" });
    expect(watch.decided()).toEqual({ act: "replace", to: "3.0.4" });
    // Nothing was probed again after the decision: the answer is already binding.
    expect(probes).toBe(1);
  });

  it("treats a failing probe as unknown, never as a match", async () => {
    const watch = createProducerReplacementWatch({
      running: "3.0.3",
      probePublished: async () => {
        throw new Error("registry unreachable");
      },
    });
    expect(await watch.tick()).toEqual({ act: "hold", reason: "published-unknown" });
    expect(watch.decided()).toBeNull();
  });

  it("never probes at all for a local build", async () => {
    let probes = 0;
    const watch = createProducerReplacementWatch({
      running: "0.0.0-dev",
      probePublished: async () => {
        probes += 1;
        return "9.9.9";
      },
    });
    expect(await watch.tick()).toEqual({ act: "hold", reason: "local-build" });
    expect(probes).toBe(0);
    expect(watch.decided()).toBeNull();
  });
});

describe("handOverProducer", () => {
  const handover: ProducerHandover = {
    to: "3.0.4",
    target: 3,
    adoptSlotPids: [
      { slot: 0, pid: 4242 },
      { slot: 2, pid: 4343 },
    ],
  };

  it("releases the pid identity BEFORE the successor is started", async () => {
    const order: string[] = [];
    const result = await handOverProducer(handover, {
      release: () => {
        order.push("release");
      },
      spawn: async () => {
        order.push("spawn");
        return 99;
      },
      log: () => undefined,
    });

    expect(order).toEqual(["release", "spawn"]);
    expect(result).toEqual({ ok: true, pid: 99 });
  });

  it("hands the live workers to the successor instead of stopping them", async () => {
    let seen: ProducerHandover | undefined;
    await handOverProducer(handover, {
      release: () => undefined,
      spawn: async (input) => {
        seen = input;
        return 99;
      },
      log: () => undefined,
    });

    expect(seen?.adoptSlotPids).toEqual([
      { slot: 0, pid: 4242 },
      { slot: 2, pid: 4343 },
    ]);
    expect(seen?.to).toBe("3.0.4");
    expect(seen?.target).toBe(3);
  });

  it("reports a successor that never came up, loudly", async () => {
    const lines: string[] = [];
    const result = await handOverProducer(handover, {
      release: () => undefined,
      spawn: async () => null,
      log: (line) => lines.push(line),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("3.0.4");
    expect(lines.some((line) => line.includes("producer self-replace failed"))).toBe(true);
  });

  it("reports a successor that refused to start, loudly", async () => {
    const lines: string[] = [];
    const result = await handOverProducer(handover, {
      release: () => undefined,
      spawn: async () => {
        throw new Error("redskilled unreachable");
      },
      log: (line) => lines.push(line),
    });

    expect(result).toEqual({ ok: false, pid: null, error: "redskilled unreachable" });
    expect(lines.some((line) => line.includes("redskilled unreachable"))).toBe(true);
  });
});
