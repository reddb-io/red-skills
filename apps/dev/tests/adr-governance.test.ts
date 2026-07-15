import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ADR_DIR = join(ROOT, ".red", "adr");
const CONTEXT_MAP = join(ROOT, ".red", "CONTEXT-MAP.md");

describe("ADR governance docs", () => {
  it("keeps ADR filename numbers and index bullets unique", async () => {
    const files = (await readdir(ADR_DIR))
      .filter((file) => /^\d{4}-.+\.md$/.test(file))
      .sort();

    const numbersByFilename = files.map((file) => file.slice(0, 4));
    const duplicateFilenameNumbers = duplicates(numbersByFilename);
    expect(duplicateFilenameNumbers).toEqual([]);

    const index = await readFile(join(ADR_DIR, "INDEX.md"), "utf8");
    const indexNumbers = Array.from(index.matchAll(/^- \*\*(\d{4})\*\*/gm), (match) => match[1]);
    const duplicateIndexNumbers = duplicates(indexNumbers);
    expect(duplicateIndexNumbers).toEqual([]);

    expect(new Set(indexNumbers)).toEqual(new Set(numbersByFilename));
  });

  it("documents any missing ADR numbers in the index", async () => {
    const files = (await readdir(ADR_DIR))
      .filter((file) => /^\d{4}-.+\.md$/.test(file))
      .sort();
    const numbers = files.map((file) => Number(file.slice(0, 4)));
    const present = new Set(numbers);
    const missing: string[] = [];

    for (let number = Math.min(...numbers); number <= Math.max(...numbers); number += 1) {
      if (!present.has(number)) missing.push(String(number).padStart(4, "0"));
    }

    const index = await readFile(join(ADR_DIR, "INDEX.md"), "utf8");
    const undocumented = missing.filter((number) => !index.includes(`**${number}**`));
    expect(undocumented).toEqual([]);
  });

  it("keeps context map local markdown links resolvable", async () => {
    const text = await readFile(CONTEXT_MAP, "utf8");
    const links = Array.from(text.matchAll(/\[[^\]]+\]\((\.\/[^)#]+\.md)(?:#[^)]+)?\)/g), (match) => match[1]);
    const missing: string[] = [];

    for (const link of links) {
      const resolved = normalize(join(dirname(CONTEXT_MAP), link));
      try {
        await access(resolved);
      } catch {
        missing.push(link);
      }
    }

    expect(missing).toEqual([]);
  });
});

function duplicates(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}
