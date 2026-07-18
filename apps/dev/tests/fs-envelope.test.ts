import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { readEnvelopePosted, writeEnvelopePosted } from "../src/runtime/fs.js";

describe("envelope posted state persistence", () => {
  it("preserves accumulated worker state while updating the envelope flag", async () => {
    const attemptDir = await mkdtemp(join(tmpdir(), "afk-envelope-"));
    const statePath = join(attemptDir, "afk.state.toon");
    const original = `${JSON.stringify({
      worker_id: "wENV",
      pid: 123,
      runner: "codex",
      envelope: { posted: false },
      current: {
        number: 1238,
        runner: "codex",
        model: "gpt-5",
        effort: "high",
        activity: "impl",
        loc_added: 12,
        loc_removed: 4,
      },
    })}\n`;
    await writeFile(statePath, original, "utf8");

    await writeEnvelopePosted(attemptDir, true);

    const after = decode(await readFile(statePath, "utf8")) as {
      worker_id?: string;
      pid?: number;
      runner?: string;
      current?: Record<string, unknown>;
    };
    expect(after.worker_id).toBe("wENV");
    expect(after.pid).toBe(123);
    expect(after.runner).toBe("codex");
    expect(after.current).toMatchObject({
      number: 1238,
      runner: "codex",
      model: "gpt-5",
      effort: "high",
      activity: "impl",
      loc_added: 12,
      loc_removed: 4,
    });
    expect(await readEnvelopePosted(attemptDir)).toBe(true);
  });
});
