import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// The skill-format parser is deliberately JavaScript: the repository's shell
// validators execute it directly with Node, while esbuild includes the same
// source in the dev runtime bundle.
// @ts-expect-error The canonical JavaScript parser has no separate declaration file.
import { matchPathBriefs, parseSkillPaths } from "../../../../scripts/lib/path-briefs.mjs";

interface ClaudeEditPayload {
  readonly session_id?: unknown;
  readonly cwd?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: {
    readonly file_path?: unknown;
    readonly input?: unknown;
    readonly patch?: unknown;
    readonly paths?: unknown;
    readonly files?: unknown;
    readonly changes?: unknown;
  };
}

interface PathBriefOptions {
  readonly pluginRoot: string;
  readonly repoRoot?: string;
  readonly stateRoot?: string;
}

interface PathBriefDeclaration {
  readonly id: string;
  readonly name: string;
  readonly paths: readonly string[];
  readonly body: string;
}

export interface ClaudePathBriefOutput {
  readonly hookSpecificOutput?: {
    readonly hookEventName: "PostToolUse";
    readonly additionalContext: string;
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function skillBody(source: string): string {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return source.trim();
  const end = lines.indexOf("---", 1);
  return end === -1 ? "" : lines.slice(end + 1).join("\n").trim();
}

function skillName(source: string): string | undefined {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end === -1) return undefined;
  const declaration = lines.slice(1, end).find((line) => /^name:\s*\S/.test(line));
  return declaration?.replace(/^name:\s*/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
}

async function declaredSkills(pluginRoot: string): Promise<PathBriefDeclaration[]> {
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  let manifest: { skills?: unknown };
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { skills?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(manifest.skills)) return [];

  const declarations: PathBriefDeclaration[] = [];
  for (const entry of manifest.skills) {
    if (typeof entry !== "string") continue;
    const declaredPath = resolve(pluginRoot, entry);
    const skillPath = declaredPath.endsWith("SKILL.md") ? declaredPath : join(declaredPath, "SKILL.md");
    if (relative(pluginRoot, skillPath).startsWith("..")) continue;
    try {
      const source = await readFile(skillPath, "utf8");
      const paths = parseSkillPaths(source) as string[];
      const name = skillName(source);
      const body = skillBody(source);
      if (paths.length > 0 && name && body) {
        declarations.push({ id: relative(pluginRoot, skillPath), name, paths, body });
      }
    } catch {
      // Invalid skill metadata is rejected by the repository validation gate.
      // A hook hot path remains fail-open so an edit is never blocked by it.
    }
  }
  return declarations;
}

function repoPath(filePath: string, repoRoot: string): string | undefined {
  const candidate = relative(repoRoot, isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath));
  if (candidate === "" || candidate === ".." || candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return undefined;
  }
  return candidate;
}

function patchPaths(input: ClaudeEditPayload["tool_input"]): string[] {
  if (!input) return [];
  const paths: string[] = [];
  const envelope = stringField(input.input) ?? stringField(input.patch);
  if (envelope) {
    const pattern = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/gim;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(envelope)) !== null) paths.push(match[1]);
  }
  const list = input.paths ?? input.files;
  if (Array.isArray(list)) {
    for (const path of list) if (typeof path === "string" && path.trim()) paths.push(path);
  }
  if (input.changes && typeof input.changes === "object" && !Array.isArray(input.changes)) {
    paths.push(...Object.keys(input.changes));
  }
  return paths;
}

function editedRepoPaths(payload: ClaudeEditPayload, repoRoot: string): string[] {
  const tool = stringField(payload.tool_name)?.toLowerCase();
  const rawPaths = tool === "edit" || tool === "write"
    ? [stringField(payload.tool_input?.file_path)]
    : tool === "apply_patch"
      ? patchPaths(payload.tool_input)
      : [];
  return [...new Set(rawPaths.flatMap((path) => path ? [repoPath(path, repoRoot)] : []).filter((path): path is string => Boolean(path)))];
}

async function claimBrief(stateRoot: string, sessionId: string, briefId: string): Promise<boolean> {
  const sessionRoot = join(stateRoot, digest(sessionId));
  await mkdir(sessionRoot, { recursive: true });
  try {
    await mkdir(join(sessionRoot, digest(briefId)));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** Resolve and claim path briefs for one host-projected PostToolUse edit event. */
export async function injectPathBriefs(
  payload: ClaudeEditPayload,
  options: PathBriefOptions,
): Promise<ClaudePathBriefOutput> {
  const sessionId = stringField(payload.session_id);
  const repoRoot = stringField(payload.cwd) ?? options.repoRoot;
  if (!sessionId || !repoRoot) return {};
  const filePaths = editedRepoPaths(payload, repoRoot);
  if (filePaths.length === 0) return {};

  const briefs = await declaredSkills(options.pluginRoot);
  const matches = [...new Map(
    filePaths.flatMap((filePath) => matchPathBriefs(briefs, filePath) as PathBriefDeclaration[])
      .map((brief) => [brief.id, brief]),
  ).values()];
  const newlyClaimed: PathBriefDeclaration[] = [];
  const stateRoot = options.stateRoot ?? join(tmpdir(), "red-skills-path-briefs");
  for (const brief of matches) {
    if (await claimBrief(stateRoot, sessionId, `${options.pluginRoot}:${brief.id}`)) newlyClaimed.push(brief);
  }
  if (newlyClaimed.length === 0) return {};

  return {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: newlyClaimed.map((brief) => `# Path brief: ${brief.name}\n\n${brief.body}`).join("\n\n"),
    },
  };
}

/** Compatibility name retained for the original Claude Code adapter. */
export const injectClaudePathBriefs = injectPathBriefs;
