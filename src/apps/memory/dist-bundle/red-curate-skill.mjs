#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/curate-skill/cli.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname as dirname3, join as join4, resolve as resolve2 } from "node:path";

// src/config.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
var DEFAULT_L2_TTL_MS = 24 * 60 * 60 * 1e3;
var DEFAULT_L2_BYTE_BUDGET = 16 * 1024 * 1024;
function skillTelemetryEnabled(config) {
  return config.mode === "graph" && config.skillTelemetry === true;
}
function configPath(rootDir) {
  return resolve(rootDir, ".red/memory/config.json");
}
async function readConfig(rootDir) {
  try {
    const raw = await readFile(configPath(rootDir), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// src/curate-skill/types.ts
var READ_ONLY_SOURCE_KINDS = /* @__PURE__ */ new Set(["plugin", "hub"]);
var CURATE_CATEGORIES = [
  "stale",
  "abandoned",
  "frequently-failing",
  "archive"
];
function isCurateCategory(value) {
  return CURATE_CATEGORIES.includes(value);
}

// src/curate-skill/candidate-reader.ts
function readArchiveCandidates(envelope, opts = {}) {
  const pinned = opts.pinned ?? /* @__PURE__ */ new Set();
  const candidates = [];
  const filtered = [];
  for (const rec of envelope.recommendations) {
    if (!isCurateCategory(rec.category)) continue;
    if (READ_ONLY_SOURCE_KINDS.has(rec.source_kind)) {
      filtered.push({
        name: rec.name,
        category: rec.category,
        reason: `source_kind=${rec.source_kind} is read-only`
      });
      continue;
    }
    if (!rec.curatable) {
      filtered.push({
        name: rec.name,
        category: rec.category,
        reason: "not curatable per report"
      });
      continue;
    }
    if (pinned.has(rec.name)) {
      filtered.push({ name: rec.name, category: rec.category, reason: "pinned" });
      continue;
    }
    candidates.push({
      name: rec.name,
      source_kind: rec.source_kind,
      path: rec.path,
      reason: rec.reason,
      category: rec.category,
      pinned: false
    });
  }
  const order = new Map(CURATE_CATEGORIES.map((c, i) => [c, i]));
  candidates.sort(
    (a, b) => (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0) || a.name.localeCompare(b.name)
  );
  const byCategory = {};
  for (const cand of candidates) {
    const bucket = byCategory[cand.category] ?? [];
    bucket.push(cand);
    byCategory[cand.category] = bucket;
  }
  return { candidates, byCategory, filtered };
}
function parseCuratorReport(raw) {
  const value = JSON.parse(raw);
  if (!Array.isArray(value.recommendations)) {
    throw new Error("curator report missing recommendations[]");
  }
  const recs = value.recommendations.map((r) => ({
    name: String(r.name),
    source_kind: String(r.source_kind),
    path: String(r.path),
    curatable: Boolean(r.curatable),
    category: String(r.category),
    reason: String(r.reason ?? "")
  }));
  return {
    generatedAt: String(value.generatedAt ?? ""),
    staleDays: Number(value.staleDays ?? 0),
    totalSkills: Number(value.totalSkills ?? 0),
    curatableSkills: Number(value.curatableSkills ?? 0),
    readOnlySkills: Number(value.readOnlySkills ?? 0),
    recommendations: recs
  };
}

// src/curate-skill/archive-engine.ts
import { createHash } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, readdir, rename, stat, writeFile as writeFile2, access } from "node:fs/promises";
import { dirname as dirname2, join as join2, relative, sep } from "node:path";
var defaultArchiveFs = {
  mkdir: async (p, opts) => {
    await mkdir2(p, opts);
  },
  rename: (src, dst) => rename(src, dst),
  readFile: (p) => readFile2(p),
  writeFile: (p, d) => writeFile2(p, d),
  readdir: (p, opts) => readdir(p, opts),
  stat: (p) => stat(p),
  access: (p) => access(p)
};
var DEFAULT_ARCHIVE_DIR = ".red/memory/skill-archive";
function resolveOptions(opts) {
  return {
    rootDir: opts.rootDir,
    archiveBaseDir: join2(opts.rootDir, opts.archiveDir ?? DEFAULT_ARCHIVE_DIR),
    now: opts.now ?? (() => /* @__PURE__ */ new Date()),
    fs: opts.fs ?? defaultArchiveFs
  };
}
function validateCandidate(c) {
  if (!c.name) {
    return { name: c.name ?? "<unnamed>", reason: "missing-name", detail: "candidate has no name" };
  }
  if (!c.path) {
    return { name: c.name, reason: "missing-path", detail: "candidate has no path" };
  }
  if (READ_ONLY_SOURCE_KINDS.has(c.source_kind)) {
    return {
      name: c.name,
      reason: "read-only-source-kind",
      detail: `source_kind=${c.source_kind} is bundled read-only content (plugin/hub)`
    };
  }
  if (c.pinned === true) {
    return { name: c.name, reason: "pinned", detail: "skill is marked pinned" };
  }
  return null;
}
async function pathExists(fs, p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
async function walkFiles(fs, root, relPath = "") {
  const entries = await fs.readdir(join2(root, relPath), { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    const next = relPath ? `${relPath}${sep}${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...await walkFiles(fs, root, next));
    } else if (ent.isFile()) {
      const data = await fs.readFile(join2(root, next));
      out.push({
        relativePath: next.split(sep).join("/"),
        sha256: createHash("sha256").update(data).digest("hex"),
        byteLength: data.byteLength
      });
    }
  }
  return out;
}
async function executeArchive(candidate, options) {
  const rej = validateCandidate(candidate);
  if (rej) return { ok: false, rejection: rej };
  const { archiveBaseDir, now, fs } = resolveOptions(options);
  const originalRoot = dirname2(candidate.path);
  const skillFileRelative = candidate.path.slice(originalRoot.length + 1) || "SKILL.md";
  const archiveRoot = join2(archiveBaseDir, candidate.name);
  const payloadRoot = join2(archiveRoot, "payload");
  if (await pathExists(fs, archiveRoot)) {
    throw new Error(
      `refusing to clobber existing archive at ${archiveRoot} \u2014 restore or rename first`
    );
  }
  const files = await walkFiles(fs, originalRoot);
  await fs.mkdir(archiveRoot, { recursive: true });
  await fs.rename(originalRoot, payloadRoot);
  const manifest = {
    name: candidate.name,
    originalRoot,
    skillFileRelative,
    source_kind: candidate.source_kind,
    archivedAt: now().toISOString(),
    category: candidate.category,
    reason: candidate.reason,
    files
  };
  const manifestPath = join2(archiveRoot, "manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}
`);
  return {
    ok: true,
    receipt: {
      name: candidate.name,
      originalRoot,
      archiveRoot,
      manifestPath,
      files
    }
  };
}
async function executeRestore(name, options) {
  const { archiveBaseDir, fs } = resolveOptions(options);
  const archiveRoot = join2(archiveBaseDir, name);
  const manifestPath = join2(archiveRoot, "manifest.json");
  const payloadRoot = join2(archiveRoot, "payload");
  const manifestRaw = (await fs.readFile(manifestPath)).toString("utf8");
  const manifest = JSON.parse(manifestRaw);
  if (await pathExists(fs, manifest.originalRoot)) {
    throw new Error(
      `refusing to overwrite live skill at ${manifest.originalRoot} \u2014 move it aside first`
    );
  }
  await fs.mkdir(dirname2(manifest.originalRoot), { recursive: true });
  await fs.rename(payloadRoot, manifest.originalRoot);
  for (const file of manifest.files) {
    const filePath = join2(manifest.originalRoot, ...file.relativePath.split("/"));
    const data = await fs.readFile(filePath);
    const sha = createHash("sha256").update(data).digest("hex");
    if (sha !== file.sha256) {
      throw new Error(
        `restored file ${file.relativePath} hash mismatch \u2014 expected ${file.sha256}, got ${sha}`
      );
    }
    if (data.byteLength !== file.byteLength) {
      throw new Error(
        `restored file ${file.relativePath} size mismatch \u2014 expected ${file.byteLength}, got ${data.byteLength}`
      );
    }
  }
  return {
    name,
    archiveRoot,
    restoredRoot: manifest.originalRoot,
    files: manifest.files
  };
}

// src/curate-skill/issue-filer.ts
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile as writeFile3 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
var CATEGORY_HEADERS = {
  stale: "Stale",
  abandoned: "Abandoned",
  "frequently-failing": "Frequently failing",
  archive: "Archive"
};
function totalCandidates(byCategory) {
  let n = 0;
  for (const c of CURATE_CATEGORIES) n += byCategory[c]?.length ?? 0;
  return n;
}
function renderIssueTitle(byCategory) {
  const n = totalCandidates(byCategory);
  const noun = n === 1 ? "candidate" : "candidates";
  return `/curate: ${n} Curatable-skill ${noun} ready for human review`;
}
function renderIssueBody(report) {
  const { byCategory, totals } = report;
  const lines = [];
  lines.push(
    "Filed by `/curate --background`. Each entry is a **Curatable skill** surfaced by Skill telemetry; no Skill file has been mutated."
  );
  lines.push("");
  lines.push(
    `Totals: ${totals.curatableSkills} curatable / ${totals.totalSkills} total skills (${totals.readOnlySkills} read-only).`
  );
  if (report.generatedAt) {
    lines.push("");
    lines.push(`Report generated at \`${report.generatedAt}\`.`);
  }
  lines.push("");
  lines.push("## Candidates");
  for (const category of CURATE_CATEGORIES) {
    const bucket = byCategory[category];
    if (!bucket || bucket.length === 0) continue;
    lines.push("");
    lines.push(`### ${CATEGORY_HEADERS[category]} (${bucket.length})`);
    lines.push("");
    for (const cand of bucket) {
      lines.push(`- **${cand.name}** \`(${cand.source_kind})\``);
      lines.push(`  - path: \`${cand.path}\``);
      lines.push(`  - evidence: ${cand.reason}`);
    }
  }
  lines.push("");
  lines.push("## How to close the loop");
  lines.push("");
  lines.push(
    "Approve by running interactive `/curate` (or `/afk` against this issue) and naming the skills to archive. The archive path is the same atomic-rename + hash-manifest flow used by the tracer slice; recover any archive with `/curate --restore <name>`."
  );
  return lines.join("\n");
}
async function fileBackgroundIssue(report, opts) {
  const label = opts.label ?? "ready-for-human";
  const spawn = opts.spawn ?? spawnSync;
  const title = renderIssueTitle(report.byCategory);
  const body = renderIssueBody(report);
  const tmp = await mkdtemp(join3(tmpdir(), "curate-bg-issue-"));
  const bodyPath = join3(tmp, "body.md");
  try {
    await writeFile3(bodyPath, body, "utf8");
    const proc = spawn(
      "gh",
      ["issue", "create", "--title", title, "--body-file", bodyPath, "--label", label],
      { cwd: opts.cwd, encoding: "utf8" }
    );
    if (proc.status !== 0) {
      const stderr = (proc.stderr ?? "").toString().trim();
      throw new Error(
        `curate background: gh issue create exited ${proc.status ?? "?"}${stderr ? `: ${stderr}` : ""}`
      );
    }
    return { output: (proc.stdout ?? "").toString().trim(), title };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// src/curate-skill/cli.ts
var INIT_HINT = "memory init --mode graph --skill-telemetry";
function usage() {
  return `red-curate-skill \u2014 workflow engine for the /curate skill

Usage:
  red-curate-skill check                 [--root <dir>]
  red-curate-skill list                  [--root <dir>] [--stale-days N]
  red-curate-skill background            [--root <dir>] [--stale-days N] [--label <name>]
  red-curate-skill archive --candidate <json>  [--root <dir>] [--archive-dir <rel>]
  red-curate-skill restore <name>        [--root <dir>] [--archive-dir <rel>]`;
}
function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== void 0 && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}
function rootOf(flags) {
  return resolve2(typeof flags.root === "string" ? flags.root : process.cwd());
}
function archiveDirOf(flags) {
  return typeof flags["archive-dir"] === "string" ? flags["archive-dir"] : void 0;
}
async function precheck(rootDir) {
  const config = await readConfig(rootDir);
  if (!config) {
    return {
      ok: false,
      message: `curate: memory is not initialized here \u2014 run \`${INIT_HINT}\``
    };
  }
  if (config.mode !== "graph") {
    return {
      ok: false,
      message: `curate: skill telemetry needs graph mode (this project is "${config.mode}") \u2014 run \`${INIT_HINT}\``
    };
  }
  if (!skillTelemetryEnabled(config)) {
    return {
      ok: false,
      message: `curate: skill telemetry is not enabled here \u2014 run \`${INIT_HINT}\``
    };
  }
  return { ok: true };
}
function memoryCliPath() {
  const here = dirname3(fileURLToPath(import.meta.url));
  const isDist = here.includes(`${"dist"}/curate-skill`) || here.endsWith("dist/curate-skill");
  return isDist ? join4(here, "..", "cli.js") : join4(here, "..", "cli.ts");
}
function runMemoryCli(args, rootDir) {
  const cliPath = memoryCliPath();
  const isTs = cliPath.endsWith(".ts");
  const proc = isTs ? spawnSync2(process.execPath, ["--import", "tsx", cliPath, ...args, "--root", rootDir], {
    encoding: "utf8"
  }) : spawnSync2(process.execPath, [cliPath, ...args, "--root", rootDir], { encoding: "utf8" });
  return { stdout: proc.stdout ?? "", status: proc.status ?? 1 };
}
async function runCheck(args) {
  const rootDir = rootOf(args.flags);
  const result = await precheck(rootDir);
  if (!result.ok) {
    console.error(result.message);
    return 2;
  }
  console.log("curate: skill telemetry is enabled \u2014 ready to curate");
  return 0;
}
async function runList(args) {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  const memArgs = ["curate", "skills", "--json"];
  if (typeof args.flags["stale-days"] === "string") {
    memArgs.push("--stale-days", args.flags["stale-days"]);
  }
  const { stdout, status } = runMemoryCli(memArgs, rootDir);
  if (status !== 0) {
    console.error(`curate: memory curate skills exited ${status}`);
    return status;
  }
  const envelope = parseCuratorReport(stdout);
  const { candidates, byCategory, filtered } = readArchiveCandidates(envelope);
  console.log(
    JSON.stringify(
      {
        candidates,
        byCategory,
        filtered,
        totals: {
          totalSkills: envelope.totalSkills,
          curatableSkills: envelope.curatableSkills,
          readOnlySkills: envelope.readOnlySkills
        }
      },
      null,
      2
    )
  );
  return 0;
}
async function runBackground(args) {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  const memArgs = ["curate", "skills", "--json"];
  if (typeof args.flags["stale-days"] === "string") {
    memArgs.push("--stale-days", args.flags["stale-days"]);
  }
  const { stdout, status } = runMemoryCli(memArgs, rootDir);
  if (status !== 0) {
    console.error(`curate: memory curate skills exited ${status}`);
    return status;
  }
  const envelope = parseCuratorReport(stdout);
  const { byCategory } = readArchiveCandidates(envelope);
  if (totalCandidates(byCategory) === 0) {
    console.error("curate: no candidates \u2014 no issue filed");
    return 0;
  }
  const label = typeof args.flags.label === "string" ? args.flags.label : void 0;
  const receipt = await fileBackgroundIssue(
    {
      byCategory,
      totals: {
        totalSkills: envelope.totalSkills,
        curatableSkills: envelope.curatableSkills,
        readOnlySkills: envelope.readOnlySkills
      },
      generatedAt: envelope.generatedAt
    },
    { cwd: rootDir, label }
  );
  console.log(`curate: filed background issue \u2014 ${receipt.output || receipt.title}`);
  return 0;
}
async function runArchive(args) {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  const raw = args.flags.candidate;
  if (typeof raw !== "string") {
    console.error("curate archive: --candidate <json> is required");
    return 2;
  }
  let candidate;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    console.error(`curate archive: invalid --candidate JSON: ${err.message}`);
    return 2;
  }
  const result = await executeArchive(candidate, {
    rootDir,
    archiveDir: archiveDirOf(args.flags)
  });
  if (!result.ok) {
    console.error(
      `curate archive: refused \u2014 ${result.rejection.reason}: ${result.rejection.detail}`
    );
    return 3;
  }
  console.log(
    `curate: archived "${result.receipt.name}" \u2192 ${result.receipt.archiveRoot} (${result.receipt.files.length} file(s), manifest at ${result.receipt.manifestPath})`
  );
  return 0;
}
async function runRestore(args) {
  const rootDir = rootOf(args.flags);
  const pre = await precheck(rootDir);
  if (!pre.ok) {
    console.error(pre.message);
    return 2;
  }
  const name = args.positional[0];
  if (!name) {
    console.error("curate restore: skill name is required");
    return 2;
  }
  const receipt = await executeRestore(name, {
    rootDir,
    archiveDir: archiveDirOf(args.flags)
  });
  console.log(
    `curate: restored "${receipt.name}" \u2192 ${receipt.restoredRoot} (${receipt.files.length} file(s) hash-verified)`
  );
  return 0;
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "check":
      return runCheck(args);
    case "list":
      return runList(args);
    case "background":
      return runBackground(args);
    case "archive":
      return runArchive(args);
    case "restore":
      return runRestore(args);
    case void 0:
    case "--help":
    case "-h":
      console.log(usage());
      return 0;
    default:
      console.error(`unknown subcommand: ${args.command}

${usage()}`);
      return 2;
  }
}
main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
