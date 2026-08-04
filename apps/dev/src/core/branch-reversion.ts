// branch-reversion — geometric guard against erasing work that reached the
// base after a worker branch forked (#3279).
//
// Both inputs are zero-context unified patches in the coordinate system of the
// current base:
//   afterForkBasePatch: fork point -> current base (added line coordinates)
//   diff:               current base -> worker branch (deleted line coordinates)
// Their coordinate intersection is content the base gained after the fork and
// the branch would erase. No semantic guess or LLM review is involved.

export interface BranchReversionDeclaration {
  readonly files: readonly string[];
  readonly citation: string;
}

export interface BranchReversionRepair {
  readonly files: readonly string[];
  readonly command: string;
}

/** Raw evidence captured around one completed base integration. */
export interface BranchReversionGeometry {
  readonly diff: string;
  readonly forkPoint: string;
  readonly afterForkBasePatch: string;
  readonly baseRef: string;
}

export interface BranchReversionFinding {
  readonly forkPoint: string;
  readonly blocked: boolean;
  /** All files that erase at least one after-fork base line. */
  readonly revertingFiles: readonly string[];
  /** Reverting files not covered by an issue-body deletion declaration. */
  readonly undeclaredRevertingFiles: readonly string[];
  /** Test-source line delta from current base to branch, before declarations. */
  readonly testLineDelta: number;
  /** Test-source line delta after declared files are excluded. */
  readonly undeclaredTestLineDelta: number;
  readonly testFilesShrunk: readonly string[];
  /** Per-test-file evidence; the #3279 incident names birth-latch.test.ts at -173. */
  readonly testFileLineDeltas: readonly { readonly file: string; readonly delta: number }[];
  readonly declaredFiles: readonly string[];
  readonly declarations: readonly BranchReversionDeclaration[];
  readonly repair: BranchReversionRepair | null;
}

export interface TestSourceLineRatchet {
  readonly testLineDelta: number;
  readonly testFilesShrunk: readonly string[];
  readonly testFileLineDeltas: readonly { readonly file: string; readonly delta: number }[];
}

export const BRANCH_REVERSION_SCHEMA = "red.afk.branch-reversion.v1" as const;

/** One audit/validation record for either call site. PURE. */
export function formatBranchReversionRecord(
  finding: BranchReversionFinding,
  stage: "base-merge" | "landing",
): string {
  return JSON.stringify({
    schema: BRANCH_REVERSION_SCHEMA,
    stage,
    status: finding.blocked ? "failed" : "passed",
    fork_point: finding.forkPoint,
    reverting_files: finding.revertingFiles,
    undeclared_reverting_files: finding.undeclaredRevertingFiles,
    test_line_delta: finding.testLineDelta,
    undeclared_test_line_delta: finding.undeclaredTestLineDelta,
    test_files_shrunk: finding.testFilesShrunk,
    test_file_line_deltas: finding.testFileLineDeltas,
    declarations: finding.declarations,
    repair: finding.repair,
  });
}

interface FilePatchGeometry {
  added: Set<number>;
  deleted: Set<number>;
}

interface PatchGeometry {
  files: Map<string, FilePatchGeometry>;
}

function geometryFor(files: Map<string, FilePatchGeometry>, file: string): FilePatchGeometry {
  let geometry = files.get(file);
  if (!geometry) {
    geometry = { added: new Set(), deleted: new Set() };
    files.set(file, geometry);
  }
  return geometry;
}

function patchPath(header: string): string | null {
  const raw = header.slice(4).trim();
  if (raw === "/dev/null") return null;
  const unquoted = raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    : raw;
  return unquoted.replace(/^[ab]\//, "");
}

/** Parse the line coordinates of a `git diff --unified=0` patch. PURE. */
function parsePatchGeometry(patch: string): PatchGeometry {
  const files = new Map<string, FilePatchGeometry>();
  let oldFile: string | null = null;
  let newFile: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldFile = null;
      newFile = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldFile = patchPath(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      newFile = patchPath(line);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("-")) {
      if (oldFile) geometryFor(files, oldFile).deleted.add(oldLine);
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      if (newFile) geometryFor(files, newFile).added.add(newLine);
      newLine += 1;
      continue;
    }
    // Context is normally absent (`--unified=0`) but accepting it makes the
    // pure function safe for callers that provide a wider patch.
    if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { files };
}

function isTestSource(file: string): boolean {
  return /(^|\/)(?:__tests__|tests?)(\/|$)/i.test(file) || /\.(?:test|spec)\.[^/]+$/i.test(file);
}

function testSourceLineRatchetFor(branch: PatchGeometry): TestSourceLineRatchet {
  const testDeltaByFile = new Map<string, number>();
  for (const [file, geometry] of branch.files) {
    if (isTestSource(file)) {
      testDeltaByFile.set(file, geometry.added.size - geometry.deleted.size);
    }
  }
  const testFilesShrunk = [...testDeltaByFile]
    .filter(([, delta]) => delta < 0)
    .map(([file]) => file)
    .sort();
  const testFileLineDeltas = [...testDeltaByFile]
    .map(([file, delta]) => ({ file, delta }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return {
    testLineDelta: [...testDeltaByFile.values()].reduce((total, delta) => total + delta, 0),
    testFilesShrunk,
    testFileLineDeltas,
  };
}

/**
 * Independent belt against silently shrinking test source. This deliberately
 * does not depend on fork geometry: deleting a test that predates the branch is
 * still a decrease that must be declared.
 */
export function testSourceLineRatchet(diff: string): TestSourceLineRatchet {
  return testSourceLineRatchetFor(parsePatchGeometry(diff));
}

function deletionSentences(body: string): string[] {
  return body
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, "").replace(/\s+/g, " ").trim())
    .filter((part) => {
      if (!/\b(?:delet(?:e|es|ed|ing|ion)|remov(?:e|es|ed|ing|al)|drop(?:s|ped|ping)?|retir(?:e|es|ed|ing))\b/i.test(part)) {
        return false;
      }
      return !/\b(?:do not|don't|must not|never|without|avoid|prevent|should not)\b.{0,48}\b(?:delete|remove|drop|retire)\b/i.test(part);
    });
}

function declarationForFile(file: string, sentences: readonly string[]): string | undefined {
  const basename = file.slice(file.lastIndexOf("/") + 1);
  return sentences.find((sentence) => {
    const plain = sentence.replace(/`/g, "");
    if (plain.includes(file) || (basename.length > 0 && plain.includes(basename))) return true;
    if (!/\bcontract phase\b/i.test(sentence)) return false;
    // #3266 names the removed API object (`deprecation aliases`) rather than a
    // path. Match that object to meaningful basename tokens, never every file in
    // the diff: one declared alias removal must not whitelist an unrelated
    // after-fork reversion elsewhere.
    const tokens = basename
      .replace(/\.[^.]+$/, "")
      .split(/[^A-Za-z0-9]+|(?=[A-Z])/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 5 && !["index", "source", "tests"].includes(token));
    const lower = plain.toLowerCase();
    return tokens.some((token) => lower.includes(token) || lower.includes(token.replace(/ed$/, "ion")));
  });
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Detect after-fork base reversion and silent test-source shrinkage. PURE.
 *
 * `diff` is `base..branch`; `afterForkBasePatch` is the net `forkPoint..base` patch. Both
 * should be produced with `--unified=0`, so their line numbers share the current
 * base coordinate system.
 */
export function detectBranchReversion(
  diff: string,
  forkPoint: string,
  afterForkBasePatch: string,
  issueBody: string,
  baseRef: string,
): BranchReversionFinding {
  const branch = parsePatchGeometry(diff);
  const afterFork = parsePatchGeometry(afterForkBasePatch);
  const revertingFiles: string[] = [];

  for (const [file, geometry] of branch.files) {
    const mainAdded = afterFork.files.get(file)?.added;
    if (mainAdded && [...geometry.deleted].some((line) => mainAdded.has(line))) {
      revertingFiles.push(file);
    }
  }

  revertingFiles.sort();
  const { testLineDelta, testFilesShrunk, testFileLineDeltas } = testSourceLineRatchetFor(branch);
  const candidateFiles = [...new Set([...revertingFiles, ...testFilesShrunk])].sort();
  const sentences = deletionSentences(issueBody);
  const declarationByFile = new Map<string, string>();
  for (const file of candidateFiles) {
    const citation = declarationForFile(file, sentences);
    if (citation) declarationByFile.set(file, citation);
  }

  const declaredFiles = [...declarationByFile.keys()].sort();
  const declarations = [...new Set(declarationByFile.values())].map((citation) => ({
    files: declaredFiles.filter((file) => declarationByFile.get(file) === citation),
    citation,
  }));
  const undeclaredRevertingFiles = revertingFiles.filter((file) => !declarationByFile.has(file));
  const undeclaredTestLineDelta = testFileLineDeltas
    .filter(({ file }) => !declarationByFile.has(file))
    .reduce((total, { delta }) => total + delta, 0);
  const repairFiles = [...new Set([
    ...undeclaredRevertingFiles,
    ...(undeclaredTestLineDelta < 0
      ? testFilesShrunk.filter((file) => !declarationByFile.has(file))
      : []),
  ])].sort();
  const blocked = undeclaredRevertingFiles.length > 0 || undeclaredTestLineDelta < 0;

  return {
    forkPoint,
    blocked,
    revertingFiles,
    undeclaredRevertingFiles,
    testLineDelta,
    undeclaredTestLineDelta,
    testFilesShrunk,
    testFileLineDeltas,
    declaredFiles,
    declarations,
    repair: blocked
      ? {
          files: repairFiles,
          command: `git checkout ${shellQuote(baseRef)} -- ${repairFiles.map(shellQuote).join(" ")}`,
        }
      : null,
  };
}
