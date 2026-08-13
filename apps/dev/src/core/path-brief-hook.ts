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
  readonly tool_input?: { readonly file_path?: unknown };
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

function editedRepoPath(payload: ClaudeEditPayload, repoRoot: string): string | undefined {
  if (payload.tool_name !== "Edit" && payload.tool_name !== "Write") return undefined;
  const filePath = stringField(payload.tool_input?.file_path);
  if (!filePath) return undefined;
  const candidate = relative(repoRoot, isAbsolute(filePath) ? filePath : resolve(repoRoot, filePath));
  if (candidate === "" || candidate === ".." || candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return undefined;
  }
  return candidate;
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

/** Resolve and claim Claude Code path briefs for one PostToolUse edit event. */
export async function injectClaudePathBriefs(
  payload: ClaudeEditPayload,
  options: PathBriefOptions,
): Promise<ClaudePathBriefOutput> {
  const sessionId = stringField(payload.session_id);
  const repoRoot = stringField(payload.cwd) ?? options.repoRoot;
  if (!sessionId || !repoRoot) return {};
  const filePath = editedRepoPath(payload, repoRoot);
  if (!filePath) return {};

  const briefs = await declaredSkills(options.pluginRoot);
  const matches = matchPathBriefs(briefs, filePath) as PathBriefDeclaration[];
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
