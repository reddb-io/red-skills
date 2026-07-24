export declare function parseArgs(argv: string[]): { root: string; check: boolean };
export declare function titleCaseName(name: string): string;
export declare function normalizeSkillEntry(entry: string): string;
export declare function normalizeText(input: unknown): string;
export declare function jsonBytes(value: unknown): string;
export declare function readJson(path: string): Promise<unknown>;
export declare function writeGenerated(
  path: string,
  bytes: string,
  check: boolean,
  mismatches: Array<{ path: string; bytes: string }>,
): Promise<void>;
export declare function printDiffs(
  root: string,
  mismatches: Array<{ path: string; bytes: string; note?: string[] }>,
  options?: { tempLabel?: string },
): Promise<void>;
