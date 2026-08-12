import { decode } from "@reddb-io/toon";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("renders the disk census as a deterministic top-N TOON table", async () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "automatic", "disk-census.json"), "utf8")) as {
      command: string;
      stdout: string;
      size_threshold_bytes: number;
      repetition_threshold_rows: number;
      top_rows: number;
    };
    const original = Buffer.from(fixture.stdout);
    const store = new MemoryStore();

    const result = await renderAutomaticOutput(original, {
      command: fixture.command,
      level: "lossless",
      store,
      sizeThresholdBytes: fixture.size_threshold_bytes,
      repetitionThresholdRows: fixture.repetition_threshold_rows,
      topRows: fixture.top_rows,
    });

    expect(result.lossy).toBe(true);
    expect(store.originals.get("el:automaticfixture")).toEqual(original);
    expect(result.stdout.toString("utf8").match(/el:[a-z0-9]+/g)).toEqual(["el:automaticfixture"]);
    const decoded = decode(result.stdout.toString("utf8")) as Record<string, unknown>;
    expect(decoded["content"]).toBe("disk-census");
    expect(valueAt(decoded, ["reduction", "rows_total"])).toBe(24);
    expect(valueAt(decoded, ["reduction", "rows_kept"])).toBe(5);
    expect(valueAt(decoded, ["reduction", "rows_omitted"])).toBe(19);
    expect(valueAt(decoded, ["reduction", "changes", 0])).toBe("rows sorted by size_kib descending; capped to top 5; 19 omitted");
    expect(valueAt(decoded, ["summary", "total_size_kib"])).toBe(1_854_464);
    expect(valueAt(decoded, ["summary", "largest_size_kib"])).toBe(184_320);
    expect(valueAt(decoded, ["rows", 0, "path"])).toBe("./packages/compiler-fixtures/alpha/target");
    expect(valueAt(decoded, ["rows", 4, "size_kib"])).toBe(138_240);
  });

  it("keeps large non-repetitive structure and command documentation complete", async () => {
    const store = new MemoryStore();
    const uniqueRows = Array.from({ length: 30 }, (_, index) => Object.fromEntries([
      [`field_${index}`, `unique-${index}`],
      ["description", "non-repetitive structured fixture".repeat(8)],
    ]));
    const structured = Buffer.from(JSON.stringify(uniqueRows));
    const cargoHelp = Buffer.from("Usage: cargo [+toolchain] [OPTIONS] [COMMAND]\n\nCommands:\n    build    Compile the current package\n    test     Execute tests\n");
    const rgDocs = Buffer.from("ripgrep recursively searches directories for a regex pattern.\nUse -g to include or exclude paths and --type-list to inspect known file types.\n");

    const structuredResult = await renderAutomaticOutput(structured, {
      command: "unique-report --json",
      level: "lossless",
      store,
      sizeThresholdBytes: 64,
      repetitionThresholdRows: 20,
    });
    const cargoResult = await renderAutomaticOutput(cargoHelp, {
      command: "cargo --help",
      level: "lossless",
      store,
      sizeThresholdBytes: 64,
      repetitionThresholdRows: 2,
    });
    const rgResult = await renderAutomaticOutput(rgDocs, {
      command: "rg --help",
      level: "lossless",
      store,
      sizeThresholdBytes: 64,
      repetitionThresholdRows: 2,
    });

    expect(structuredResult.lossy).toBe(false);
    expect(decode(structuredResult.stdout.toString("utf8"))).toEqual(uniqueRows);
    expect(cargoResult.stdout).toEqual(cargoHelp);
    expect(rgResult.stdout).toEqual(rgDocs);
    expect(store.mintCalls).toBe(0);
  });

  it.each([
    { level: "brief" as const, count: 30, threshold: 64, expectedKept: 12 },
    { level: "terse" as const, count: 10, threshold: 64 * 1024, expectedKept: 5 },
  ])("keeps explicit $level output deterministic and recoverable", async ({ level, count, threshold, expectedKept }) => {
    const original = Buffer.from(JSON.stringify(Array.from({ length: count }, (_, id) => ({ id, state: "steady" }))));
    const store = new MemoryStore();

    const result = await renderAutomaticOutput(original, {
      command: "state-report --json",
      level,
      store,
      sizeThresholdBytes: threshold,
      repetitionThresholdRows: 20,
    });

    expect(result.lossy).toBe(true);
    expect(store.originals.get("el:automaticfixture")).toEqual(original);
    expect(result.stdout.toString("utf8").match(/el:[a-z0-9]+/g)).toEqual(["el:automaticfixture"]);
    const decoded = decode(result.stdout.toString("utf8")) as Record<string, unknown>;
    expect(valueAt(decoded, ["reduction", "rows_kept"])).toBe(expectedKept);
    expect(valueAt(decoded, ["reduction", "rows_omitted"])).toBe(count - expectedKept);
    expect(valueAt(decoded, ["recovery", "original"])).toBe("rsp show el:automaticfixture");
  });

  it("does not make reduced output observable before original bytes are stored", async () => {
    const original = Buffer.from(JSON.stringify(Array.from({ length: 30 }, (_, id) => ({ id, state: "steady" }))));
    let releaseMint: ((handle: string) => void) | undefined;
    const mintFinished = new Promise<string>((resolve) => {
      releaseMint = resolve;
    });
    const pending = renderAutomaticOutput(original, {
      command: "state-report --json",
      level: "lossless",
      sizeThresholdBytes: 64,
      repetitionThresholdRows: 20,
      store: { mint: async () => await mintFinished },
    });
    let observable = false;
    void pending.then(() => {
      observable = true;
    });

    await Promise.resolve();
    expect(observable).toBe(false);
    releaseMint?.("el:automaticfixture");

    const result = await pending;
    expect(result.lossy).toBe(true);
    expect(result.stdout.toString("utf8")).toContain("rsp show el:automaticfixture");
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
