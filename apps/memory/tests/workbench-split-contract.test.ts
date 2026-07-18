import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const memoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceRoot = join(memoryRoot, "src");
const workbenchBarrel = join(sourceRoot, "workbench.ts");
const workbenchModules = join(sourceRoot, "workbench");
const maxLines = 1_200;

async function lineCount(path: string): Promise<number> {
  const source = await readFile(path, "utf8");
  return source.split(/\r?\n/).length;
}

async function workbenchSourceFiles(): Promise<string[]> {
  const entries = await readdir(workbenchModules, { withFileTypes: true }).catch(() => []);
  return [
    workbenchBarrel,
    ...entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(workbenchModules, entry.name)),
  ];
}

function exportedNames(source: string): string[] {
  return [...source.matchAll(/export(?:\s+type)?\s+\{\s*([^}]+?)\s*\}\s+from/g)]
    .flatMap((match) => match[1].split(","))
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
}

describe("workbench split contract", () => {
  it("keeps the workbench barrel and sibling modules within the line budget", async () => {
    for (const path of await workbenchSourceFiles()) {
      expect(await lineCount(path), path).toBeLessThanOrEqual(maxLines);
    }
  });

  it("keeps the original workbench public surface on the barrel", async () => {
    const source = await readFile(workbenchBarrel, "utf8");

    expect(exportedNames(source)).toEqual([
      "MemoryWorkbench",
      "MemoryWorkbenchArtifact",
      "buildMemoryWorkbench",
      "buildMemoryWorkbenchArtifact",
    ]);
  });
});
