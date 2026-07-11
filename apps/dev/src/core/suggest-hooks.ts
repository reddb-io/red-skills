// suggest-hooks.ts — detect concrete repo signals and produce the ordered list
// of `.red/hooks/<point>/red-*.sh` scripts to offer in Section I of
// /red-setup.
//
// Pure + IO-injected: SignalFs carries the only two FS operations needed so
// the detection and suggestion mapping are unit-testable against fixture inputs
// without touching the real filesystem. The caller (the agent following the
// SKILL.md) is responsible for presenting the suggestions, asking for
// confirmation, and writing the confirmed scripts — this module only detects.

import { join } from "node:path";
import type { HookName } from "./hook-config.js";

/** A suggested script to seed into `.red/hooks/<point>/`. */
export interface HookSuggestion {
  /** Canonical lifecycle point (e.g. `pre_merge`, `post_merge`). */
  point: HookName;
  /** Script filename — always `red-*.sh`. */
  name: string;
  /** Full script body, ready to write verbatim. */
  content: string;
  /** One-line description of the concrete signal that triggered this offer. */
  signal: string;
}

/** Injected filesystem — the only IO this module performs. */
export interface SignalFs {
  /** Read the file at `path` as UTF-8; return `null` if the path does not exist. */
  readText(path: string): string | null;
  /** Return `true` when `path` exists (file or directory). */
  exists(path: string): boolean;
}

/** Package manager inferred from the lockfile present in `root`. */
export type PackageManager = "pnpm" | "yarn" | "npm";

/**
 * Infer the package manager from the first lockfile found in `root`.
 * Falls back to `npm` when none of the known lockfiles are present.
 */
export function detectPackageManager(root: string, fs: SignalFs): PackageManager {
  if (fs.exists(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.exists(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/** CI-convention Makefile target names that warrant a `pre_merge` hook. */
const MAKE_CI_TARGETS = new Set(["test", "check", "verify", "lint", "build"]);

/**
 * Parse top-level target names from a Makefile text string. Returns only
 * single-word targets (letters, digits, hyphens, underscores) whose line
 * starts at column 0 with a `:` that is NOT a `:=` assignment — the minimal
 * subset reliably parseable without a real make parser.
 */
export function parseMakeTargets(makefileText: string): string[] {
  const seen = new Set<string>();
  for (const line of makefileText.split("\n")) {
    // Exclude := and ::= assignment lines; match only `TARGET:` declarations.
    const m = /^([A-Za-z][A-Za-z0-9_-]*):(?!=)/.exec(line);
    if (m && m[1]) seen.add(m[1]);
  }
  return Array.from(seen);
}

const SCRIPT_HEADER = "#!/usr/bin/env bash\nset -euo pipefail\n";

/**
 * Scan `root` for concrete repo signals and return the ordered list of hook
 * scripts to offer in `/red-setup` Section I.
 *
 * Returns an empty array when no signals are found — the caller should skip
 * Section I entirely when the result is empty (absence of signals → no offer).
 *
 * Signals checked, in order:
 *   1. `package.json` `scripts.*` — test / typecheck / type-check / lint /
 *      build / e2e / test:e2e. Package manager is inferred from lockfile.
 *   2. `Makefile` targets matching the CI-convention set (test, check, verify,
 *      lint, build).
 *   3. `Cargo.toml` presence — offer `cargo test` at `pre_merge`.
 *   4. `build.gradle` / `build.gradle.kts` presence — offer `./gradlew check`
 *      at `pre_merge`.
 *   5. `.husky/` directory — offer `npx lint-staged` at `pre_merge`.
 *   6. `.pre-commit-config.yaml` — offer `pre-commit run --all-files` at
 *      `pre_merge`.
 *   7. `.env.example` containing `SLACK_WEBHOOK_URL` or
 *      `SLACK_INCOMING_WEBHOOK` — offer a `post_merge` Slack notification hook.
 */
export function suggestHooksFromRepo(root: string, fs: SignalFs): HookSuggestion[] {
  const suggestions: HookSuggestion[] = [];
  const pm = detectPackageManager(root, fs);
  const run = pm === "pnpm" ? "pnpm run" : pm === "yarn" ? "yarn run" : "npm run";

  // 1. package.json scripts
  const pkgText = fs.readText(join(root, "package.json"));
  if (pkgText !== null) {
    let scripts: Record<string, string> = {};
    try {
      const parsed = JSON.parse(pkgText) as { scripts?: Record<string, string> };
      scripts = parsed.scripts ?? {};
    } catch {
      // malformed package.json — skip signal detection
    }

    if (scripts["test"]) {
      suggestions.push({
        point: "pre_merge",
        name: "red-run-tests.sh",
        content: `${SCRIPT_HEADER}\n${run} test\n`,
        signal: `package.json declares \`scripts.test\` (${scripts["test"]})`,
      });
    }

    const typecheckKey = scripts["typecheck"] ? "typecheck" : scripts["type-check"] ? "type-check" : null;
    if (typecheckKey) {
      suggestions.push({
        point: "pre_merge",
        name: "red-typecheck.sh",
        content: `${SCRIPT_HEADER}\n${run} ${typecheckKey}\n`,
        signal: `package.json declares \`scripts.${typecheckKey}\` (${scripts[typecheckKey] ?? ""})`,
      });
    }

    if (scripts["lint"]) {
      suggestions.push({
        point: "pre_merge",
        name: "red-lint.sh",
        content: `${SCRIPT_HEADER}\n${run} lint\n`,
        signal: `package.json declares \`scripts.lint\` (${scripts["lint"]})`,
      });
    }

    if (scripts["build"]) {
      suggestions.push({
        point: "pre_merge",
        name: "red-build.sh",
        content: `${SCRIPT_HEADER}\n${run} build\n`,
        signal: `package.json declares \`scripts.build\` (${scripts["build"]})`,
      });
    }

    const e2eKey = scripts["e2e"] ? "e2e" : scripts["test:e2e"] ? "test:e2e" : null;
    if (e2eKey) {
      suggestions.push({
        point: "post_merge",
        name: "red-e2e.sh",
        content: `${SCRIPT_HEADER}\n${run} ${e2eKey}\n`,
        signal: `package.json declares \`scripts.${e2eKey}\` (${scripts[e2eKey] ?? ""})`,
      });
    }
  }

  // 2. Makefile targets
  const makefileText = fs.readText(join(root, "Makefile"));
  if (makefileText !== null) {
    const ciTargets = parseMakeTargets(makefileText).filter((t) => MAKE_CI_TARGETS.has(t));
    for (const target of ciTargets) {
      suggestions.push({
        point: "pre_merge",
        name: `red-make-${target}.sh`,
        content: `${SCRIPT_HEADER}\nmake ${target}\n`,
        signal: `Makefile declares \`${target}\` target`,
      });
    }
  }

  // 3. Cargo.toml (built-in default handles worktree isolation; suggest test run)
  if (fs.exists(join(root, "Cargo.toml"))) {
    suggestions.push({
      point: "pre_merge",
      name: "red-cargo-test.sh",
      content: `${SCRIPT_HEADER}\ncargo test\n`,
      signal: "Cargo.toml detected (Rust project)",
    });
  }

  // 4. build.gradle / build.gradle.kts (built-in handles isolation; suggest check)
  if (fs.exists(join(root, "build.gradle")) || fs.exists(join(root, "build.gradle.kts"))) {
    suggestions.push({
      point: "pre_merge",
      name: "red-gradle-check.sh",
      content: `${SCRIPT_HEADER}\n./gradlew check\n`,
      signal: "build.gradle detected (Gradle project)",
    });
  }

  // 5. husky — suggest lint-staged as the typical pre-merge companion
  if (fs.exists(join(root, ".husky"))) {
    suggestions.push({
      point: "pre_merge",
      name: "red-lint-staged.sh",
      content: `${SCRIPT_HEADER}\nnpx lint-staged\n`,
      signal: ".husky/ directory detected (husky hooks present)",
    });
  }

  // 6. pre-commit
  if (fs.exists(join(root, ".pre-commit-config.yaml"))) {
    suggestions.push({
      point: "pre_merge",
      name: "red-pre-commit.sh",
      content: `${SCRIPT_HEADER}\npre-commit run --all-files\n`,
      signal: ".pre-commit-config.yaml detected",
    });
  }

  // 7. Slack webhook env in .env.example
  const envExample = fs.readText(join(root, ".env.example"));
  if (envExample !== null && /SLACK_WEBHOOK_URL|SLACK_INCOMING_WEBHOOK/i.test(envExample)) {
    suggestions.push({
      point: "post_merge",
      name: "red-slack-notify.sh",
      content: [
        SCRIPT_HEADER,
        "# Post-merge Slack notification. Set SLACK_WEBHOOK_URL before running /afk.",
        '[ -z "${SLACK_WEBHOOK_URL:-}" ] && exit 0',
        'curl -sf -X POST "$SLACK_WEBHOOK_URL" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d "{\\"text\\":\\"AFK merged issue #${RED_AFK_ISSUE:-?} on ${RED_AFK_REPO:-repo}\\"}"',
        "",
      ].join("\n"),
      signal: "SLACK_WEBHOOK_URL found in .env.example",
    });
  }

  return suggestions;
}
