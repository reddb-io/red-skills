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
import { join } from "node:path";

const DEFAULT_STATUS_LINE =
  '["project", "git-branch", "model-with-reasoning", "context-remaining", "task-progress"]';

function emitAndExit() {
  // Codex hook contract: pass the context through unchanged.
  process.stdout.write("{}");
  process.exit(0);
}

// Drain stdin (the piped hook context) so the producer never blocks; ignore it.
try {
  readFileSync(0);
} catch {
  /* no stdin / closed — fine */
}

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
