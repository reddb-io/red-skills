import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { encode } from "@reddb-io/toon";
import {
  buildOutputShapingReport,
  collectOutputShapingSamples,
  renderOutputShapingReport,
} from "../src/core/output-shaping-report.js";

function writeState(root: string, worker: string, attempt: string, variant: string, outputTokens: number): void {
  const dir = join(root, ".red", "tmp", "workers", worker, attempt);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "afk.state.toon"),
    JSON.stringify({
      current: {
        number: Number(attempt.split("-")[0]),
        output_shaping_variant: variant,
        output_tokens: outputTokens,
      },
    }),
    "utf8",
  );
}

describe("AFK output shaping report", () => {
  it("groups persisted worker-state output tokens by holdout arm", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-output-shaping-"));
    writeState(root, "wA", "2-a1", "steered", 100);
    writeState(root, "wB", "4-a1", "steered", 140);
    writeState(root, "wC", "1-a1", "holdout", 180);
    writeState(root, "wD", "3-a1", "holdout", 220);

    const samples = collectOutputShapingSamples(join(root, ".red", "tmp"));
    const report = buildOutputShapingReport(samples);

    expect(samples).toHaveLength(4);
    expect(report.arms.steered.output_tokens_mean).toBe(120);
    expect(report.arms.holdout.output_tokens_mean).toBe(200);
    expect(report.delta_output_tokens_mean).toBe(-80);
    expect(report.delta_output_tokens_pct).toBe(-0.4);
    expect(report.confidence_range_output_tokens).not.toBeNull();
    expect(renderOutputShapingReport(report)).toContain("delta steered-holdout: -80 tokens (-40%)");
  });

  it("ignores attempts without an output-shaping variant", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-output-shaping-"));
    writeState(root, "wA", "2-a1", "", 100);
    expect(collectOutputShapingSamples(join(root, ".red", "tmp"))).toEqual([]);
  });

  it("sniffs TOON state snapshots while keeping legacy JSON state readable", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-output-shaping-"));
    const toonDir = join(root, ".red", "tmp", "workers", "wTOON", "8-a1");
    const legacyDir = join(root, ".red", "tmp", "workers", "wJSON", "9-a1");
    mkdirSync(toonDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(toonDir, "afk.state.toon"),
      encode({
        current: {
          number: 8,
          output_shaping_variant: "steered",
          output_tokens: 77,
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(legacyDir, "afk.state.toon"),
      JSON.stringify({
        current: {
          number: 9,
          output_shaping_variant: "holdout",
          output_tokens: 88,
          diff_added: 3,
        },
      }),
      "utf8",
    );

    expect(
      collectOutputShapingSamples(join(root, ".red", "tmp")).sort((a, b) => Number(a.issue) - Number(b.issue)),
    ).toEqual([
      { issue: 8, variant: "steered", output_tokens: 77 },
      { issue: 9, variant: "holdout", output_tokens: 88 },
    ]);
  });
});
