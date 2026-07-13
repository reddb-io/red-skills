import { RSP_WRAPPER_CAPABILITIES, type RspWrapperCapability } from "./intercept.js";

export type RspShell = "fish" | "bash" | "zsh";

export function renderShellInit(
  shell: RspShell,
  capabilities: readonly RspWrapperCapability[] = RSP_WRAPPER_CAPABILITIES,
): string {
  if (shell === "fish") return renderFishInit(capabilities);
  if (shell === "bash" || shell === "zsh") return renderPosixishInit(shell, capabilities);
  throw new Error(`unsupported shell: ${shell}`);
}

function renderFishInit(capabilities: readonly RspWrapperCapability[]): string {
  const commandWords = [...new Set(capabilities.map((entry) => entry.command[0]).filter(isShellWord))];
  return [
    "# rsp shell-init fish",
    "# Opt-in only: source this output from config.fish; remove that line to restore raw commands.",
    "if type -q rsp",
    ...commandWords.map((word) => `    abbr --add --position command -- ${word} '${fishSingleQuote(`rsp ${word}`)}'`),
    "    function rspx --description 'Run a shell pipeline through rsp exec'",
    "        rsp exec -- $argv",
    "    end",
    "else",
    "    # rsp is not on PATH; rsp abbreviations and rspx were not installed.",
    "end",
    "",
  ].join("\n");
}

function renderPosixishInit(shell: "bash" | "zsh", capabilities: readonly RspWrapperCapability[]): string {
  const groups = groupedCapabilities(capabilities);
  return [
    `# rsp shell-init ${shell}`,
    `# Opt-in only: source this output from ${shell} startup files; remove that line to restore raw commands.`,
    ...renderCommandFunction("git", groups.get("git") ?? []),
    ...renderCommandFunction("gh", groups.get("gh") ?? []),
    ...renderCommandFunction("vitest", groups.get("vitest") ?? []),
    ...renderCommandFunction("cargo", groups.get("cargo") ?? []),
    "rspx() {",
    "  if command -v rsp >/dev/null 2>&1; then",
    "    command rsp exec -- \"$@\"",
    "    return",
    "  fi",
    "  printf '%s\\n' 'rspx requires rsp with exec support on PATH' >&2",
    "  return 127",
    "}",
    "",
  ].join("\n");
}

function renderCommandFunction(command: string, capabilities: readonly RspWrapperCapability[]): string[] {
  if (capabilities.length === 0) return [];
  if (capabilities.some((entry) => entry.command.length === 1)) {
    return [
      `${command}() {`,
      "  if command -v rsp >/dev/null 2>&1; then",
      `    command rsp ${command} "$@"`,
      "    return",
      "  fi",
      `  command ${command} "$@"`,
      "}",
    ];
  }
  const singleSubcommands = capabilities
    .map((entry) => entry.command.slice(1))
    .filter((tail) => tail.length === 1)
    .map((tail) => tail[0])
    .filter(isShellWord);
  const multiSubcommands = capabilities
    .map((entry) => entry.command.slice(1))
    .filter((tail) => tail.length > 1 && tail.every(isShellWord));
  const lines = [
    `${command}() {`,
    "  if ! command -v rsp >/dev/null 2>&1; then",
    `    command ${command} "$@"`,
    "    return",
    "  fi",
    "  case \"$1\" in",
  ];
  if (singleSubcommands.length > 0) {
    const pattern = singleSubcommands.map((word) => shellPatternWord(word)).join("|");
    lines.push(`    ${pattern}) command rsp ${command} "$@" ;;`);
  }
  for (const [first, tails] of groupMultiSubcommands(multiSubcommands)) {
    const tests = tails.map((tail) => tail
      .map((word, index) => `[ "\$${index + 2}" = '${shellSingleQuote(word)}' ]`)
      .join(" && ")).join(" || ");
    lines.push(`    ${shellPatternWord(first)}) if ${tests}; then command rsp ${command} "$@"; else command ${command} "$@"; fi ;;`);
  }
  lines.push(
    `    *) command ${command} "$@" ;;`,
    "  esac",
    "}",
  );
  return lines;
}

function groupMultiSubcommands(tails: readonly string[][]): Map<string, string[][]> {
  const groups = new Map<string, string[][]>();
  for (const [first, ...rest] of tails) {
    if (!first) continue;
    const group = groups.get(first) ?? [];
    group.push(rest);
    groups.set(first, group);
  }
  return groups;
}

function groupedCapabilities(capabilities: readonly RspWrapperCapability[]): Map<string, RspWrapperCapability[]> {
  const groups = new Map<string, RspWrapperCapability[]>();
  for (const entry of capabilities) {
    const command = entry.command[0];
    if (!command || !isShellWord(command)) continue;
    const group = groups.get(command) ?? [];
    group.push(entry);
    groups.set(command, group);
  }
  return groups;
}

function isShellWord(value: string | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_./:-]+$/.test(value));
}

function shellPatternWord(value: string): string {
  return value.replace(/[\\|)&;]/g, "\\$&");
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function fishSingleQuote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
