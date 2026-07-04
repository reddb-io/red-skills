import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ADR_DIR = join(ROOT, ".red", "adr");

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
});

function duplicates(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}
