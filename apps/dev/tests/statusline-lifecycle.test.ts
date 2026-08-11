import { describe, expect, it } from "vitest";
import {
  lifecycleTailLines,
  renderStatuslineLifecycleToken,
  resolveStatuslineLifecycle,
  type StatuslineLifecycleState,
} from "../src/core/statusline-lifecycle.js";
import {
  collectStatuslineTail,
  type StatuslineTailProbe,
  type StatuslineTailWireDeps,
} from "../src/runtime/wire/statusline-lifecycle.js";

const ROOT = "/tmp/statusline-lifecycle-fixture";

describe("Statusline Lifecycle render", () => {
  it.each([
    "bedrock-only",
    "connecting",
    "registering",
    "unregistered",
    "degraded",
  ] satisfies StatuslineLifecycleState[])("renders %s as the compact rsk token", (state) => {
    expect(renderStatuslineLifecycleToken(state)).toBe(`rsk=${state}`);
    expect(lifecycleTailLines({ state })).toEqual([`rsk=${state}`]);
  });

  it("renders no lifecycle token in live", () => {
    expect(renderStatuslineLifecycleToken("live")).toBeNull();
    expect(lifecycleTailLines({ state: "live", tail: ["daemon tail"] })).toEqual(["daemon tail"]);
  });

  it.each([
    [{ probe: "disabled" }, "bedrock-only"],
    [{ probe: "unreachable" }, "bedrock-only"],
    [{ probe: "connecting" }, "connecting"],
    [{ probe: "answered", registration: "pending" }, "registering"],
    [{ probe: "answered", registration: "absent" }, "unregistered"],
    [{ probe: "answered", registration: "present", payloadAgeMs: 30_001, stalenessWindowMs: 30_000 }, "degraded"],
    [{ probe: "answered", registration: "present", payloadAgeMs: 30_000, stalenessWindowMs: 30_000 }, "live"],
  ] as const)("maps %o to %s", (input, expected) => {
    expect(resolveStatuslineLifecycle(input)).toBe(expected);
  });
});

function probe(overrides: Partial<StatuslineTailProbe> = {}): StatuslineTailProbe {
  return {
    lines: ["1w rdy=5 iss=24 pr=3 mrg=7 128M", "w123 working"],
    generatedAt: "2026-08-11T12:00:00.000Z",
    payloadAgeMs: 5_000,
    stalenessWindowMs: 30_000,
    payloadStale: false,
    mode: "local",
    projectMatch: "matched",
    ...overrides,
  };
}

function harness(now = Date.parse("2026-08-11T12:00:05.000Z")) {
  const files = new Map<string, string>();
  let clock = now;
  const deps: StatuslineTailWireDeps = {
    nowMs: () => clock,
    readCache: (path) => files.get(path) ?? null,
    writeCache: (path, text) => {
      files.set(path, text);
    },
  };
  return {
    deps,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("Statusline Lifecycle wire", () => {
  it("distinguishes an in-flight registration from a repo nobody is registering", async () => {
    const h = harness();

    const registering = await collectStatuslineTail(ROOT, [], {
      ...h.deps,
      probe: async () => probe({ projectMatch: "name-only" }),
    });
    const unregistered = await collectStatuslineTail(ROOT, [], {
      ...h.deps,
      probe: async () => probe({ projectMatch: "unregistered" }),
    });

    expect(registering).toEqual({ state: "registering", lines: ["rsk=registering"] });
    expect(unregistered).toEqual({ state: "unregistered", lines: ["rsk=unregistered"] });
  });

  it("serves the last-known tail with age and degraded state inside the socket deadline", async () => {
    const h = harness();
    const live = await collectStatuslineTail(ROOT, [], {
      ...h.deps,
      probe: async () => probe(),
    });
    expect(live.state).toBe("live");

    h.advance(12_000);
    const started = performance.now();
    const served = await collectStatuslineTail(ROOT, [], {
      ...h.deps,
      deadlineMs: 25,
      probe: () => new Promise<StatuslineTailProbe>(() => undefined),
    });
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(100);
    expect(served.state).toBe("degraded");
    expect(served.lines).toEqual([
      "1w rdy=5 iss=24 pr=3 mrg=7 128M · age=17s · rsk=degraded",
      "w123 working",
    ]);
  });

  it("renders connecting on a deadline miss when no last-known tail exists", async () => {
    const h = harness();
    const served = await collectStatuslineTail(ROOT, [], {
      ...h.deps,
      deadlineMs: 5,
      probe: () => new Promise<StatuslineTailProbe>(() => undefined),
    });

    expect(served).toEqual({ state: "connecting", lines: ["rsk=connecting"] });
  });

  it("renders bedrock-only when the socket probe rejects promptly", async () => {
    const h = harness();
    const served = await collectStatuslineTail(ROOT, [], {
      ...h.deps,
      probe: async () => {
        throw new Error("socket unavailable");
      },
    });

    expect(served).toEqual({ state: "bedrock-only", lines: ["rsk=bedrock-only"] });
  });
});
