import { decode } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";
import { renderAutomaticOutput } from "../src/automatic-output-policy.js";

class MemoryStore {
  readonly originals = new Map<string, Buffer>();
  mintCalls = 0;

  async mint(original: Uint8Array | Buffer): Promise<string> {
    this.mintCalls += 1;
    this.originals.set("el:automaticfixture", Buffer.from(original));
    return "el:automaticfixture";
  }
}

describe("rsp automatic output policy", () => {
  it("keeps small structured output complete and mints no recovery handle", async () => {
    const original = Buffer.from('{"services":[{"name":"api","healthy":true},{"name":"worker","healthy":false}]}\n');
    const store = new MemoryStore();

    const result = await renderAutomaticOutput(original, {
      command: "service-status --json",
      level: "lossless",
      store,
    });

    expect(result.lossy).toBe(false);
    expect(result.handle).toBeUndefined();
    expect(store.mintCalls).toBe(0);
    expect(decode(result.stdout.toString("utf8"))).toEqual({
      services: [
        { name: "api", healthy: true },
        { name: "worker", healthy: false },
      ],
    });
  });

  it("reduces large repetitive structured rows with declared caps and pinned aggregates", async () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      service: `worker-${String(index).padStart(2, "0")}`,
      status: "healthy",
      latency_ms: 40 + index,
    }));
    const original = Buffer.from(`${JSON.stringify(rows)}\n`);
    const store = new MemoryStore();

    const first = await renderAutomaticOutput(original, {
      command: "service-status --json",
      level: "lossless",
      store,
      sizeThresholdBytes: 128,
      repetitionThresholdRows: 20,
      topRows: 5,
    });
    const second = await renderAutomaticOutput(original, {
      command: "service-status --json",
      level: "lossless",
      store,
      sizeThresholdBytes: 128,
      repetitionThresholdRows: 20,
      topRows: 5,
    });

    expect(first.stdout).toEqual(second.stdout);
    expect(first.lossy).toBe(true);
    expect(first.handle).toBe("el:automaticfixture");
    expect(first.bytesElided).toBe(original.length);
    expect(store.originals.get("el:automaticfixture")).toEqual(original);
    expect(first.stdout.toString("utf8").match(/el:[a-z0-9]+/g)).toEqual(["el:automaticfixture"]);

    const decoded = decode(first.stdout.toString("utf8")) as Record<string, unknown>;
    expect(valueAt(decoded, ["reduction", "reason"])).toBe("size-and-repetition-threshold");
    expect(valueAt(decoded, ["reduction", "rows_total"])).toBe(40);
    expect(valueAt(decoded, ["reduction", "rows_kept"])).toBe(5);
    expect(valueAt(decoded, ["reduction", "rows_omitted"])).toBe(35);
    expect(valueAt(decoded, ["reduction", "changes", 0])).toBe("rows capped to first 5; 35 omitted");
    expect(valueAt(decoded, ["summary", "numeric", "latency_ms", "min"])).toBe(40);
    expect(valueAt(decoded, ["summary", "numeric", "latency_ms", "max"])).toBe(79);
    expect(valueAt(decoded, ["summary", "numeric", "latency_ms", "sum"])).toBe(2380);
    expect(valueAt(decoded, ["rows", 4, "service"])).toBe("worker-04");
    expect(valueAt(decoded, ["next_steps", 0])).toBe("Recover exact bytes with rsp show <handle>");
    expect(valueAt(decoded, ["next_steps", 1])).toBe("Re-run service-status --json with --full to suppress reduction");
    expect(valueAt(decoded, ["recovery", "original"])).toBe("rsp show el:automaticfixture");
  });
});

function valueAt(value: unknown, path: readonly (string | number)[]): unknown {
  let cursor = value;
  for (const segment of path) {
    if (typeof segment === "number" && Array.isArray(cursor)) {
      cursor = cursor[segment];
    } else if (typeof segment === "string" && typeof cursor === "object" && cursor !== null && !Array.isArray(cursor)) {
      cursor = (cursor as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}
