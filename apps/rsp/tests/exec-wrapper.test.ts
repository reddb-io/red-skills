import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { renderExecContract } from "../src/exec-wrapper.js";

class MemoryStore {
  readonly originals = new Map<string, Buffer>();

  async mint(original: Uint8Array | Buffer): Promise<string> {
    this.originals.set("el:123456789abc", Buffer.from(original));
    return "el:123456789abc";
  }
}

describe("rsp exec anomaly-preserving elision", () => {
  it("routes structured stdout into deterministic TOON summaries by content shape", async () => {
    const cases = [
      {
        name: "json",
        stdout: JSON.stringify({ ok: true, services: [{ name: "api", status: "green" }, { name: "worker", status: "yellow" }] }, null, 2),
        expectedKind: "json",
        expectedPath: ["summary", "root_type"],
        expectedValue: "object",
      },
      {
        name: "jsonl",
        stdout: [
          JSON.stringify({ service: "api", level: "info", latency_ms: 41 }),
          JSON.stringify({ service: "api", level: "error", latency_ms: 942 }),
          JSON.stringify({ service: "worker", level: "info", latency_ms: 38 }),
        ].join("\n") + "\n",
        expectedKind: "jsonl",
        expectedPath: ["summary", "records"],
        expectedValue: 3,
      },
      {
        name: "diff",
        stdout: [
          "diff --git a/src/app.ts b/src/app.ts",
          "index 1111111..2222222 100644",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1,3 +1,4 @@",
          " const port = 3000;",
          "-console.log('old');",
          "+console.log('new');",
          "+console.log('ready');",
        ].join("\n") + "\n",
        expectedKind: "unified-diff",
        expectedPath: ["summary", "added_lines"],
        expectedValue: 2,
      },
      {
        name: "tabular",
        stdout: [
          "NAME       READY   STATUS      RESTARTS",
          "api-0      1/1     Running     0",
          "worker-0   0/1     CrashLoop   7",
          "db-0       1/1     Running     0",
        ].join("\n") + "\n",
        expectedKind: "tabular",
        expectedPath: ["summary", "columns", 2],
        expectedValue: "STATUS",
      },
      {
        name: "log",
        stdout: largeLog(),
        expectedKind: "log-like",
        expectedPath: ["summary", "levels", "fatal"],
        expectedValue: 1,
      },
      {
        name: "prose",
        stdout: proseOutput(),
        expectedKind: "prose",
        expectedPath: ["summary", "paragraphs"],
        expectedValue: 2,
      },
    ] as const;

    for (const fixture of cases) {
      const result = await renderExecContract(`fixture ${fixture.name}`, {
        stdout: fixture.stdout,
        stderr: "",
        status: 0,
        signal: null,
      }, { level: "terse", store: new MemoryStore(), heavyByteThreshold: 1 });

      const decoded = decode(result.stdout.toString("utf8")) as Record<string, unknown>;
      expect(decoded["family"]).toBe("exec");
      expect(decoded["content"]).toBe(fixture.expectedKind);
      expect(valueAt(decoded, fixture.expectedPath)).toBe(fixture.expectedValue);
      expect(valueAt(decoded, ["recovery", "original"])).toBe("rsp show el:123456789abc");
    }
  });

  it("falls back to TOON head/tail plus anomaly preservation for ambiguous stdout", async () => {
    const stdout = [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "FATAL panic=InvariantViolation trace=ambiguous-9d2f shard=8",
      "zeta",
      "eta",
      "theta",
      "iota",
    ].join("\n") + "\n";

    const result = await renderExecContract("printf ambiguous", {
      stdout,
      stderr: "",
      status: 0,
      signal: null,
    }, {
      level: "terse",
      store: new MemoryStore(),
      heavyByteThreshold: 1,
      anomalyScorer: () => [{
        lineNumber: 6,
        score: 9.5,
        text: "FATAL panic=InvariantViolation trace=ambiguous-9d2f shard=8",
      }],
    });

    const decoded = decode(result.stdout.toString("utf8")) as Record<string, unknown>;
    expect(decoded["content"]).toBe("untyped");
    expect(valueAt(decoded, ["summary", "head"])).toContain("alpha");
    expect(valueAt(decoded, ["summary", "tail"])).toContain("iota");
    expect(valueAt(decoded, ["summary", "outliers", 0, "text"])).toBe("FATAL panic=InvariantViolation trace=ambiguous-9d2f shard=8");
  });

  it("preserves deterministic structural outliers from the elided middle", async () => {
    const stdout = largeLog();
    const store = new MemoryStore();

    const first = await renderExecContract("node emit-log.js", {
      stdout,
      stderr: "",
      status: 0,
      signal: null,
    }, { level: "terse", store });
    const second = await renderExecContract("node emit-log.js", {
      stdout,
      stderr: "",
      status: 0,
      signal: null,
    }, { level: "terse", store });

    expect(first.stdout).toEqual(second.stdout);
    const decoded = decode(first.stdout.toString("utf8")) as Record<string, unknown>;
    expect(decoded["content"]).toBe("log-like");
    expect(valueAt(decoded, ["summary", "outliers", 0, "line"])).toBe(321);
    expect(valueAt(decoded, ["summary", "outliers", 0, "text"])).toContain("service=checkout level=FATAL panic=NullPointerException shard=17 trace=abc123xyz");
    expect(valueAt(decoded, ["recovery", "original"])).toBe("rsp show el:123456789abc");
    expect(store.originals.get("el:123456789abc")?.toString("utf8")).toBe(stdout);
  });

  it("uses the deterministic JSON-array crusher for JSON-classified exec output", async () => {
    const rows: Array<Record<string, unknown>> = Array.from({ length: 220 }, (_, i) => ({
      seq: i,
      metric: i === 80 ? 9000 : 50,
      class: i === 160 ? "rare" : "normal",
    }));
    rows[120] = { ...rows[120]!, variant: "shape-break" };
    const stdout = JSON.stringify(rows);
    const store = new MemoryStore();

    const result = await renderExecContract("node emit-json-array.js", {
      stdout,
      stderr: "",
      status: 0,
      signal: null,
    }, { level: "terse", store, heavyByteThreshold: 1 });

    const decoded = decode(result.stdout.toString("utf8")) as Record<string, unknown>;
    expect(decoded["content"]).toBe("json");
    expect(valueAt(decoded, ["summary", "root_type"])).toBe("array");
    expect(valueAt(decoded, ["summary", "kept"])).toBe(5);
    expect(valueAt(decoded, ["summary", "dropped"])).toBe(215);
    expect(valueAt(decoded, ["summary", "shape_outliers"])).toBe(1);
    expect(valueAt(decoded, ["summary", "value_outliers"])).toBe(2);
    expect(valueAt(decoded, ["summary", "items", 1, "seq"])).toBe(80);
    expect(valueAt(decoded, ["summary", "items", 2, "variant"])).toBe("shape-break");
    expect(valueAt(decoded, ["summary", "items", 3, "class"])).toBe("rare");
    expect(valueAt(decoded, ["recovery", "original"])).toBe("rsp show el:123456789abc");
    expect(store.originals.get("el:123456789abc")?.toString("utf8")).toBe(stdout);
  });

  it("falls open to the prior JSON sample summary and reports degradation when array crushing fails", async () => {
    const stdout = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ seq: i, metric: 50 })));

    const result = await renderExecContract("node emit-json-array.js", {
      stdout,
      stderr: "",
      status: 0,
      signal: null,
    }, {
      level: "terse",
      store: new MemoryStore(),
      heavyByteThreshold: 1,
      jsonArrayCrusher: () => {
        throw new Error("fixture crusher failure");
      },
    });

    const decoded = decode(result.stdout.toString("utf8")) as Record<string, unknown>;
    expect(decoded["content"]).toBe("json");
    expect(valueAt(decoded, ["summary", "items"])).toBe(40);
    expect(valueAt(decoded, ["summary", "sample", 4, "seq"])).toBe(4);
    expect(valueAt(decoded, ["summary", "kept"])).toBeUndefined();
    expect(result.degradation).toEqual({
      reason: "exec-json-array-crusher-failed",
      family: "exec",
      stderrHead: "fixture crusher failure",
    });
  });

  it("falls open to head and tail when scoring fails and reports degradation identity", async () => {
    const stdout = largeLog();
    const result = await renderExecContract("node emit-log.js", {
      stdout,
      stderr: "",
      status: 0,
      signal: null,
    }, {
      level: "terse",
      store: new MemoryStore(),
      anomalyScorer: () => {
        throw new Error("fixture scorer failure");
      },
    });

    const decoded = decode(result.stdout.toString("utf8")) as Record<string, unknown>;
    expect(decoded["content"]).toBe("log-like");
    expect(valueAt(decoded, ["summary", "outliers"])).toEqual([]);
    expect(valueAt(decoded, ["recovery", "original"])).toBe("rsp show el:123456789abc");
    expect(result.degradation).toEqual({
      reason: "exec-anomaly-scorer-failed",
      family: "exec",
      stderrHead: "fixture scorer failure",
    });
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

function proseOutput(): string {
  return [
    "The deployment completed after the cache warmed. Operators reviewed the rollout notes, confirmed the database migration had no pending backfill, and left the service in watch mode for the next maintenance window.",
    "",
    "A follow-up check should compare request latency before and after the router change. The current sample suggests the critical path is stable, but the queue worker still deserves a separate measurement.",
  ].join("\n") + "\n";
}

function largeLog(): string {
  const lines: string[] = [];
  for (let i = 1; i <= 640; i++) {
    if (i === 321) {
      lines.push("2026-07-17T12:00:00Z service=checkout level=FATAL panic=NullPointerException shard=17 trace=abc123xyz stack=/srv/app/checkout.ts:918");
    } else {
      lines.push(`2026-07-17T12:00:00Z service=checkout level=info worker=${String(i % 12).padStart(2, "0")} latency_ms=${100 + (i % 9)} queue_depth=${20 + (i % 5)} message=request complete`);
    }
  }
  return `${lines.join("\n")}\n`;
}
