import { describe, expect, it } from "vitest";
import { renderExecContract } from "../src/exec-wrapper.js";

class MemoryStore {
  readonly originals = new Map<string, Buffer>();

  async mint(original: Uint8Array | Buffer): Promise<string> {
    this.originals.set("el:123456789abc", Buffer.from(original));
    return "el:123456789abc";
  }
}

describe("rsp exec anomaly-preserving elision", () => {
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
    const text = first.stdout.toString("utf8");
    expect(text).toContain("preserved outliers:\n");
    expect(text).toContain("[outlier line 321 ");
    expect(text).toContain("service=checkout level=FATAL panic=NullPointerException shard=17 trace=abc123xyz");
    expect(text).toContain("… elided stdout (+");
    expect(text).toContain("; preserved_outliers: 1) — rsp show el:123456789abc");
    expect(store.originals.get("el:123456789abc")?.toString("utf8")).toBe(stdout);
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

    const text = result.stdout.toString("utf8");
    expect(text).toContain("stdout summary\n");
    expect(text).not.toContain("preserved outliers:");
    expect(text).toContain("… elided stdout (+");
    expect(result.degradation).toEqual({
      reason: "exec-anomaly-scorer-failed",
      family: "exec",
      stderrHead: "fixture scorer failure",
    });
  });
});

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
