#!/usr/bin/env node
// RedSkills · Codex statusline ensure (session_start hook)
//
// Codex's footer is global config (`~/.codex/config.toml` -> `[tui].status_line`,
// builtin widgets) with no command hook, so the RedSkills line cannot be injected
// the way it is on Claude Code. Worse: when Codex re-syncs plugin `[hooks.state]`
// on update it can rewrite config.toml and drop the `[tui]` section, blanking the
// footer. This hook re-asserts `status_line` at every session start.
//
// Safety contract (do not weaken):
//   - ADDITIVE ONLY: insert `status_line` solely when it is absent. Never clobber
//     an existing value — the operator's own choice always wins.
//   - ATOMIC WRITE: temp file + rename, so a race with Codex's own writer can lose
//     the update but can never corrupt config.toml.
//   - BEST EFFORT: any error is swallowed; the hook still emits `{}` so Codex's
//     session start is never blocked.
//
// The default widget set matches the statusline SKILL.md Codex recommendation.

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const DEFAULT_STATUS_LINE =
  '["project", "git-branch", "model-with-reasoning", "context-remaining", "task-progress"]';
const HOOK_TIMEOUT_MS = Number(process.env.RED_SKILLS_HOOK_TIMEOUT_MS || 5000);
const STDIN_TIMEOUT_MS = Number(process.env.RED_SKILLS_HOOK_STDIN_TIMEOUT_MS || 5000);

function emitAndExit() {
  // Codex hook contract: pass the context through unchanged.
  process.stdout.write("{}");
  process.exit(0);
}

const hookDeadline = setTimeout(emitAndExit, Number.isFinite(HOOK_TIMEOUT_MS) ? HOOK_TIMEOUT_MS : 5000);
hookDeadline.unref();

async function drainStdin() {
  const timeoutMs = Number.isFinite(STDIN_TIMEOUT_MS) ? STDIN_TIMEOUT_MS : 5000;
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", done);
      process.stdin.off("error", done);
      process.stdin.pause();
      resolve();
    };
    const onData = () => {};
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    process.stdin.on("data", onData);
    process.stdin.once("end", done);
    process.stdin.once("error", done);
    process.stdin.resume();
  });
}

// ── Per-directory plugin gate (ADR 0067) ─────────────────────────────────────
// This hook mutates the user's GLOBAL ~/.codex/config.toml, so it must never run
// for a project that did not opt into the dev plugin. Mirror of
// packages/shared/plugin-gate.ts (strict opt-in over the constrained YAML).
function flatConfigValue(text, dottedKey) {
  const stack = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const indent = line.length - line.trimStart().length;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    const hash = value.indexOf(" #");
    if (hash >= 0) value = value.slice(0, hash).trim();
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key });
    if (value && stack.map((s) => s.key).join(".") === dottedKey) return value;
  }
  return undefined;
}
function devEnabled(cwd) {
  let dir = cwd;
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, ".red", "config.yaml");
    if (existsSync(candidate)) {
      try {
        return flatConfigValue(readFileSync(candidate, "utf8"), "plugins.dev.enabled") === "true";
      } catch {
        return false;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

// Drain stdin with a deadline so the producer never blocks; ignore the payload.
await drainStdin();

// Gate before touching any global config: dormant unless dev is enabled here.
if (!devEnabled(process.cwd())) emitAndExit();

try {
  const cfgPath = join(homedir(), ".codex", "config.toml");
  if (!existsSync(cfgPath)) emitAndExit();

  const text = readFileSync(cfgPath, "utf8");
  const lines = text.split("\n");

  // Locate the [tui] table header.
  let tuiHeader = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[tui\]\s*(#.*)?$/.test(lines[i])) {
      tuiHeader = i;
      break;
    }
  }

  if (tuiHeader >= 0) {
    // Scan the [tui] table body (until the next table header or EOF) for an
    // existing status_line key. If present, respect it and do nothing.
    for (let i = tuiHeader + 1; i < lines.length; i++) {
      if (/^\s*\[/.test(lines[i])) break; // next table — key not found
      if (/^\s*status_line\s*=/.test(lines[i])) emitAndExit(); // already set
    }
    lines.splice(tuiHeader + 1, 0, `status_line = ${DEFAULT_STATUS_LINE}`);
  } else {
    // No [tui] table at all — append one.
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[tui]", `status_line = ${DEFAULT_STATUS_LINE}`, "");
  }

  const tmpPath = `${cfgPath}.redskills.tmp`;
  writeFileSync(tmpPath, lines.join("\n"));
  renameSync(tmpPath, cfgPath); // atomic on the same filesystem
} catch {
  /* best effort — never block session start */
}

emitAndExit();
