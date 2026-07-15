import { describe, expect, test } from "vitest";
import { encodingForModel } from "js-tiktoken";
import { decode } from "@reddb-io/toon";
import { renderToonDocument } from "../src/toon-output.js";

describe("shared TOON document output", () => {
  test("defaults to lossless strings and lets the encoder quote unsafe cells", () => {
    const payload = {
      rows: [
        {
          source: "keyword:cache",
          markdown: "Keep [brackets]\n  and   whitespace.",
          note: "alpha:beta {raw}",
        },
      ],
    };

    const toon = renderToonDocument(payload);

    expect(toon).toContain("\"keyword:cache\"");
    expect(decode(toon)).toEqual(payload);
  });

  test("compact mode declares the reduction and recovery path in-band", () => {
    const payload = {
      markdown: "Keep [brackets]\n  and   whitespace.",
      note: "alpha:beta {raw}",
    };

    const lossless = renderToonDocument(payload);
    const compact = renderToonDocument(payload, { compact: true });
    const decoded = decode(compact) as {
      _reduction: { mode: string; reduced: string; recover: string };
      value: { markdown: string; note: string };
    };
    const tokenizer = encodingForModel("gpt-4o");
    const losslessTokens = tokenizer.encode(lossless).length;
    const compactTokens = tokenizer.encode(compact).length;
    const reduction = ((losslessTokens - compactTokens) / losslessTokens) * 100;
    console.info(
      `memory TOON compact token delta: lossless=${losslessTokens} compact=${compactTokens} reduction=${reduction.toFixed(1)}%`,
    );

    expect(decoded._reduction).toEqual({
      mode: "compact",
      reduced: "string whitespace collapsed; markdown bracket characters removed",
      recover: "rerun without --compact",
    });
    expect(decoded.value).toEqual({
      markdown: "Keep brackets and whitespace.",
      note: "alpha:beta {raw}",
    });
    expect(Number.isFinite(reduction)).toBe(true);
  });
});
