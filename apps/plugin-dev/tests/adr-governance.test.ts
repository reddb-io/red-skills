import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AdrRecord,
  adrFiles,
  adrNumbers,
  appendOnlyViolations,
  archivedRecordViolations,
  deletedArchivePaths,
  duplicates,
  headingViolations,
  indexNumbers,
  undocumentedGaps,
} from "../src/core/adr-governance.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ADR_DIR = join(ROOT, ".red", "adr");
const ARCHIVE_DIR = join(ADR_DIR, "archive");
const ARCHIVE_REL = ".red/adr/archive";
const CONTEXT_MAP = join(ROOT, ".red", "CONTEXT-MAP.md");

describe("ADR governance docs", () => {
  it("keeps ADR filename numbers and index bullets unique", async () => {
    const active = adrNumbers(await readdir(ADR_DIR));
    const archived = adrNumbers(await readdir(ARCHIVE_DIR));

    expect(duplicates([...active, ...archived])).toEqual([]);

    const index = await readFile(join(ADR_DIR, "INDEX.md"), "utf8");
    expect(duplicates(indexNumbers(index))).toEqual([]);

    expect(new Set(indexNumbers(index))).toEqual(new Set([...active, ...archived]));
  });

  it("documents any missing ADR numbers in the index", async () => {
    const active = adrNumbers(await readdir(ADR_DIR));
    const archived = adrNumbers(await readdir(ARCHIVE_DIR));
    const index = await readFile(join(ADR_DIR, "INDEX.md"), "utf8");

    expect(undocumentedGaps([...active, ...archived], index)).toEqual([]);
  });

  it("keeps every archived ADR statused with a successor pointer", async () => {
    const files = (await readdir(ARCHIVE_DIR)).filter((file) => /^\d{4}-.+\.md$/.test(file));
    const violations: string[] = [];

    for (const file of files) {
      const text = await readFile(join(ARCHIVE_DIR, file), "utf8");
      violations.push(...archivedRecordViolations({ file, text }));
    }

    expect(violations).toEqual([]);
  });

  it("keeps the archive lane append-only", async () => {
    const present = (await readdir(ARCHIVE_DIR)).map((file) => `${ARCHIVE_REL}/${file}`);
    const deleted = deletedArchivePaths(ROOT, ARCHIVE_REL);

    expect(appendOnlyViolations(present, deleted)).toEqual([]);
  });

  it("keeps every ADR H1 numbered to match its filename", async () => {
    const records: AdrRecord[] = [];

    for (const dir of [ADR_DIR, ARCHIVE_DIR]) {
      for (const file of adrFiles(await readdir(dir))) {
        records.push({ file, text: await readFile(join(dir, file), "utf8") });
      }
    }

    expect(records.length).toBeGreaterThan(0);
    expect(headingViolations(records)).toEqual([]);
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

describe("ADR bijection over active ∪ archived", () => {
  const INDEX = ["- **0001** Live decision", "- **0002** Retired decision"].join("\n");

  it("stays green when an ADR moves from the active set to the archive", () => {
    const before = new Set([...adrNumbers(["0001-live.md", "0002-retired.md"]), ...adrNumbers([])]);
    const after = new Set([...adrNumbers(["0001-live.md"]), ...adrNumbers(["0002-retired.md"])]);

    expect(after).toEqual(before);
    expect(after).toEqual(new Set(indexNumbers(INDEX)));
  });

  it("fails when an archived number disappears from the tree", () => {
    const after = new Set(adrNumbers(["0001-live.md"]));

    expect(after).not.toEqual(new Set(indexNumbers(INDEX)));
  });
});

describe("archivedRecordViolations", () => {
  const archived = (status: string, pointer: string) =>
    ["# Retired decision", "", "## Status", "", status, "", pointer, ""].join("\n");

  it("accepts a superseded record that names its successor", () => {
    const text = archived("Superseded by ADR 0113.", "superseded-by: 0113");
    expect(archivedRecordViolations({ file: "0002-retired.md", text })).toEqual([]);
  });

  it("accepts an inert record that declares it has no successor", () => {
    const text = archived("Inert — fully shipped, no longer guidance.", "superseded-by: none (inert)");
    expect(archivedRecordViolations({ file: "0002-retired.md", text })).toEqual([]);
  });

  it("rejects an archived record without a successor pointer", () => {
    const text = ["# Retired decision", "", "## Status", "", "Superseded.", ""].join("\n");
    expect(archivedRecordViolations({ file: "0002-retired.md", text })).toEqual([
      "0002-retired.md: missing a `superseded-by:` successor pointer",
    ]);
  });

  it("rejects a superseded record whose pointer names no successor ADR", () => {
    const text = archived("Superseded.", "superseded-by: none (inert)");
    expect(archivedRecordViolations({ file: "0002-retired.md", text })).toEqual([
      "0002-retired.md: `superseded-by:` must name a successor ADR number for status `superseded`",
    ]);
  });

  it("rejects an archived record with no terminal status", () => {
    const text = archived("Accepted.", "superseded-by: 0113");
    expect(archivedRecordViolations({ file: "0002-retired.md", text })).toEqual([
      "0002-retired.md: `## Status` must declare one of superseded, deprecated, inert",
    ]);
  });
});

describe("headingViolations", () => {
  it("accepts an H1 whose number matches the filename", () => {
    const record = { file: "0124-castle-crossing.md", text: "# 0124 — Castle crossing\n" };
    expect(headingViolations([record])).toEqual([]);
  });

  it("reports a renumbered file whose H1 kept the old number", () => {
    const record = { file: "0124-castle-crossing.md", text: "# 0120 — Castle crossing\n" };
    expect(headingViolations([record])).toEqual(["0124-castle-crossing.md: H1 says `0120`, filename says `0124`"]);
  });

  it("reports an H1 that omits the number entirely", () => {
    const record = { file: "0121-releases.md", text: "# Releases flow through a PR\n" };
    expect(headingViolations([record])).toEqual([
      "0121-releases.md: line 1 must read `# 0121 — Title`, got `# Releases flow through a PR`",
    ]);
  });
});

describe("archive append-only guard", () => {
  it("reports an archived file that history added and the tree no longer has", () => {
    const present = [`${ARCHIVE_REL}/0002-retired.md`];
    const deleted = [`${ARCHIVE_REL}/0003-erased.md`];

    expect(appendOnlyViolations(present, deleted)).toEqual([`${ARCHIVE_REL}/0003-erased.md`]);
  });

  it("ignores a deleted path that was restored to the tree", () => {
    const path = `${ARCHIVE_REL}/0003-restored.md`;
    expect(appendOnlyViolations([path], [path])).toEqual([]);
  });

  it("detects a deleted archived ADR in a real repository", async () => {
    const repo = await mkdtemp(join(tmpdir(), "adr-archive-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");

      await mkdir(join(repo, ARCHIVE_REL), { recursive: true });
      await writeFile(join(repo, ARCHIVE_REL, "0002-retired.md"), "# Retired\n");
      await writeFile(join(repo, ARCHIVE_REL, "0003-erased.md"), "# Erased\n");
      git("add", "-A");
      git("commit", "-qm", "archive two records");

      expect(deletedArchivePaths(repo, ARCHIVE_REL)).toEqual([]);

      await rm(join(repo, ARCHIVE_REL, "0003-erased.md"));
      git("add", "-A");
      git("commit", "-qm", "erase history");

      const deleted = deletedArchivePaths(repo, ARCHIVE_REL);
      expect(deleted).toEqual([`${ARCHIVE_REL}/0003-erased.md`]);

      const present = [`${ARCHIVE_REL}/0002-retired.md`];
      expect(appendOnlyViolations(present, deleted)).toEqual([`${ARCHIVE_REL}/0003-erased.md`]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("stays green when an ADR is moved into the archive lane", async () => {
    const repo = await mkdtemp(join(tmpdir(), "adr-archive-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
      git("init", "-q");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");

      await mkdir(join(repo, ARCHIVE_REL), { recursive: true });
      await writeFile(join(repo, ".red/adr/0002-retired.md"), "# Retired\n");
      await writeFile(join(repo, ARCHIVE_REL, ".gitkeep"), "");
      git("add", "-A");
      git("commit", "-qm", "seed");

      git("mv", ".red/adr/0002-retired.md", `${ARCHIVE_REL}/0002-retired.md`);
      git("commit", "-qm", "archive the record");

      const present = (await readdir(join(repo, ARCHIVE_REL))).map((file) => `${ARCHIVE_REL}/${file}`);
      expect(appendOnlyViolations(present, deletedArchivePaths(repo, ARCHIVE_REL))).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
