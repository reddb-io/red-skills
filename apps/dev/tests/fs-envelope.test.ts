import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvelopePosted, writeEnvelopePosted } from "../src/runtime/fs.js";

describe("envelope posted state persistence", () => {
  it("preserves the original state when the atomic temp write fails", async () => {
    const attemptDir = await mkdtemp(join(tmpdir(), "afk-envelope-"));
    const statePath = join(attemptDir, "afk.state.json");
    const original = `${JSON.stringify({ pid: 123, envelope: { posted: false }, current: { stage: "impl" } })}\n`;
    await writeFile(statePath, original, "utf8");
    await mkdir(`${statePath}.tmp`);

    await expect(writeEnvelopePosted(attemptDir, true)).rejects.toThrow();
    expect(await readFile(statePath, "utf8")).toBe(original);
    expect(await readEnvelopePosted(attemptDir)).toBe(false);
  });
});
