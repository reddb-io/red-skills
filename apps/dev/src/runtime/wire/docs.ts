import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyDocsPath, planDocsSweep, type DocsSweepFileState, type DocsSweepPlan } from "../../core/docs-sweep.js";
import type { DocsInput } from "../../core/statusline.js";
import * as gitx from "../git.js";
import * as fsx from "../fs.js";
import { execTool } from "../exec.js";
import { afkPaths, type RepoContext } from "./paths.js";

type GitExec = typeof execTool;

export async function collectStatuslineDocs(
  ctx: RepoContext,
  base = "main",
  exec: GitExec = execTool,
): Promise<DocsInput | undefined> {
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const baseRef = `${ctx.remote}/${base}`;
  const precedent = new Map<DocsSweepFileState["group"], boolean>([
    ["glossary", await docsTrackedPrecedentWithExec(gitCtx, baseRef, "glossary", exec)],
    ["adr", await docsTrackedPrecedentWithExec(gitCtx, baseRef, "adr", exec)],
  ]);

  const status = await exec("git", ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", ...DOC_SWEEP_PATHS], { cwd: ctx.root });
  const files = status.code === 0 ? parseDocsPorcelain(status.stdout, precedent) : [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  const ahead = await exec("git", ["diff", "--name-only", `${baseRef}...HEAD`, "--", ...DOC_SWEEP_PATHS], { cwd: ctx.root });
  if (ahead.code === 0) {
    for (const raw of ahead.stdout.split("\n")) {
      const path = raw.trim();
      if (!path || byPath.has(path)) continue;
      const group = classifyDocsPath(path);
      if (group !== "glossary" && group !== "adr") continue;
      byPath.set(path, {
        path,
        state: "ahead",
        group,
        ignored: false,
        trackedPrecedent: precedent.get(group) ?? false,
      });
    }
  }

  const plan = planDocsSweep({ base, files: [...byPath.values()] });
  return plan.files.length > 0 ? { count: plan.files.length } : undefined;
}

const DOC_SWEEP_PATHS = [".red/CONTEXT.md", ".red/CONTEXT-MAP.md", ".red/contexts", ".red/adr"] as const;

function docsSweepGroupPath(group: DocsSweepFileState["group"]): string {
  return group === "adr" ? ".red/adr" : ".red";
}

function parseDocsPorcelain(stdout: string, precedent: Map<DocsSweepFileState["group"], boolean>): DocsSweepFileState[] {
  const files = new Map<string, DocsSweepFileState>();
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    const status = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = gitx.unquotePorcelainPath(path);
    const group = classifyDocsPath(path);
    if (group !== "glossary" && group !== "adr") continue;
    files.set(path, {
      path,
      state: status === "??" || status === "!!" ? "untracked" : "modified",
      group,
      ignored: status === "!!",
      trackedPrecedent: precedent.get(group) ?? false,
    });
  }
  return [...files.values()];
}

async function docsTrackedPrecedent(ctx: gitx.GitContext, baseRef: string, group: DocsSweepFileState["group"]): Promise<boolean> {
  if (group !== "glossary" && group !== "adr") return false;
  const r = await execTool("git", ["ls-tree", "-r", "--name-only", baseRef, "--", docsSweepGroupPath(group)], { cwd: ctx.cwd });
  return r.code === 0 && r.stdout.trim() !== "";
}

async function docsTrackedPrecedentWithExec(
  ctx: gitx.GitContext,
  baseRef: string,
  group: DocsSweepFileState["group"],
  exec: typeof execTool,
): Promise<boolean> {
  if (group !== "glossary" && group !== "adr") return false;
  const r = await exec("git", ["ls-tree", "-r", "--name-only", baseRef, "--", docsSweepGroupPath(group)], { cwd: ctx.cwd });
  return r.code === 0 && r.stdout.trim() !== "";
}

export async function collectDocsSweepInput(ctx: RepoContext, base: string) {
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const fetch = await execTool("git", ["fetch", ctx.remote, base], { cwd: ctx.root });
  const originReachable = fetch.code === 0;
  const baseRef = `${ctx.remote}/${base}`;
  const precedent = new Map<DocsSweepFileState["group"], boolean>([
    ["glossary", await docsTrackedPrecedent(gitCtx, baseRef, "glossary")],
    ["adr", await docsTrackedPrecedent(gitCtx, baseRef, "adr")],
  ]);

  const status = await execTool("git", ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", ...DOC_SWEEP_PATHS], { cwd: ctx.root });
  const files = status.code === 0 ? parseDocsPorcelain(status.stdout, precedent) : [];
  const byPath = new Map(files.map((f) => [f.path, f]));

  if (originReachable) {
    const ahead = await execTool("git", ["diff", "--name-only", `${baseRef}...HEAD`, "--", ...DOC_SWEEP_PATHS], { cwd: ctx.root });
    if (ahead.code === 0) {
      for (const raw of ahead.stdout.split("\n")) {
        const path = raw.trim();
        if (!path || byPath.has(path)) continue;
        const group = classifyDocsPath(path);
        if (group !== "glossary" && group !== "adr") continue;
        byPath.set(path, {
          path,
          state: "ahead",
          group,
          ignored: false,
          trackedPrecedent: precedent.get(group) ?? false,
        });
      }
    }
  }

  return { base, files: [...byPath.values()], originReachable };
}

export async function landDocsSweep(ctx: RepoContext, plan: DocsSweepPlan) {
  const paths = afkPaths(ctx.root);
  const stamp = `${Date.now().toString(36)}-${process.pid}`;
  const worktree = join(paths.tmpDir, "docs-sweep", stamp);
  const branch = `docs/afk-docs-sweep-${stamp}`;
  const title = "docs: land AFK boot docs sweep";
  const body = "Automated Docs Sweep landing for stranded .red documentation.";

  await fsx.ensureDir(dirname(worktree));
  const add = await execTool("git", ["worktree", "add", "-b", branch, worktree, `${ctx.remote}/${plan.base}`], { cwd: ctx.root });
  if (add.code !== 0) return { ok: false, reason: "worktree-add-failed" };

  try {
    for (const f of plan.files) {
      const src = join(ctx.root, f.path);
      const dst = join(worktree, f.path);
      if (existsSync(src)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      } else {
        rmSync(dst, { force: true });
      }
    }
    const addDocs = await execTool("git", ["add", "--force", "--", ...plan.files.map((f) => f.path)], { cwd: worktree });
    if (addDocs.code !== 0) return { ok: false, reason: "add-failed" };
    const commit = await execTool("git", ["commit", "-m", title], { cwd: worktree });
    if (commit.code !== 0) return { ok: false, reason: "commit-failed" };
    const push = await execTool("git", ["push", ctx.remote, `HEAD:refs/heads/${branch}`], { cwd: worktree });
    if (push.code !== 0) return { ok: false, reason: "push-failed" };
    const create = await execTool("gh", ["-R", ctx.repo, "pr", "create", "--base", plan.base, "--head", branch, "--title", title, "--body", body], { cwd: ctx.root });
    if (create.code !== 0) return { ok: false, reason: "pr-create-failed" };
    const prNumber = /\/pull\/([0-9]+)/.exec(create.stdout)?.[1] ?? create.stdout.trim().match(/^[0-9]+$/)?.[0];
    const resolvedPr = prNumber
      ? { code: 0, stdout: prNumber, stderr: "" }
      : await execTool("gh", ["-R", ctx.repo, "pr", "view", branch, "--json", "number", "-q", ".number"], { cwd: ctx.root });
    const number = resolvedPr.stdout.trim();
    if (resolvedPr.code !== 0 || !number) return { ok: false, reason: "pr-resolve-failed" };
    const merge = await execTool("gh", ["-R", ctx.repo, "pr", "merge", number, "--merge", "--delete-branch"], { cwd: ctx.root });
    if (merge.code !== 0) return { ok: false, reason: "merge-failed" };
    await execTool("git", ["fetch", ctx.remote, plan.base], { cwd: ctx.root });
    return { ok: true };
  } finally {
    await execTool("git", ["worktree", "remove", "--force", worktree], { cwd: ctx.root });
  }
}
