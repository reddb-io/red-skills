import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MAX_LINES = 1200;

function countLines(path: string): number {
  return readFileSync(path, "utf8").split(/\r?\n/).length;
}

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? tsFilesUnder(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"));
}

describe("run command module shape", () => {
  it("keeps the run barrel and split modules under the line budget", () => {
    const commandDir = join(process.cwd(), "src", "commands");
    const paths = [join(commandDir, "run.ts"), ...tsFilesUnder(join(commandDir, "run"))];

    expect(
      Object.fromEntries(paths.map((path) => [path.replace(`${commandDir}/`, ""), countLines(path)])),
    ).toSatisfy((lineCounts: Record<string, number>) =>
      Object.values(lineCounts).every((lineCount) => lineCount <= MAX_LINES),
    );
  });
});
