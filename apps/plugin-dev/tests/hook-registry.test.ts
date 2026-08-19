import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_HOOK_NAMES } from "../src/core/hook-config.js";
import { HOOK_REGISTRY, renderHookContextTable } from "../src/core/hook-registry.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CONFIG_MD = join(ROOT, "plugins/dev/skills/engineering/afk/docs/CONFIG.md");

const BEGIN = "<!-- BEGIN GENERATED: hook-context-schema -->";
const END = "<!-- END GENERATED: hook-context-schema -->";

describe("hook registry", () => {
  it("covers every canonical hook name and nothing else", () => {
    expect(Object.keys(HOOK_REGISTRY).sort()).toEqual([...CANONICAL_HOOK_NAMES].sort());
  });

  it("makes every pre_* point abort and every post_*/on_* point continue", () => {
    for (const name of CANONICAL_HOOK_NAMES) {
      const expected = name.startsWith("pre_") ? "abort" : "continue";
      expect(HOOK_REGISTRY[name].exit, name).toBe(expected);
    }
  });

  it("renders a row per hook in execution order", () => {
    const table = renderHookContextTable();
    const dataRows = table.split("\n").slice(2); // drop header + separator
    expect(dataRows).toHaveLength(CANONICAL_HOOK_NAMES.length);
    CANONICAL_HOOK_NAMES.forEach((name, i) => {
      expect(dataRows[i].startsWith(`| \`${name}\` |`), name).toBe(true);
    });
  });

  it("marks read-only points with no mutable slice", () => {
    expect(renderHookContextTable()).toContain(
      "| `on_session_error` | `error` | _none (read-only)_ |",
    );
  });
});

describe("CONFIG.md hook reference is generated from the registry (drift guard)", () => {
  it("carries the rendered table verbatim between the generated markers", async () => {
    const md = await readFile(CONFIG_MD, "utf8");
    const begin = md.indexOf(BEGIN);
    const end = md.indexOf(END);
    expect(begin, "BEGIN marker missing from CONFIG.md").toBeGreaterThanOrEqual(0);
    expect(end, "END marker missing from CONFIG.md").toBeGreaterThan(begin);

    const embedded = md.slice(begin + BEGIN.length, end).trim();
    expect(embedded).toBe(renderHookContextTable());
  });
});
