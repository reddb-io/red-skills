/**
 * help.ts — the `rsp wait --help` surface.
 *
 * Help is kept separate from the parser so the doctrine line and the exit-code
 * contract have one home; the docs-surface test asserts against this text, and
 * the ambient skill restates it for agents.
 */
export function renderWaitHelp(): string {
  return [
    "usage: rsp wait <subcommand> [options]",
    "",
    "Subcommands:",
    "  rsp wait pr <number> [--timeout 45m] [--reason <text>]",
    "  rsp wait run <id|--branch <branch> --latest> [--timeout 45m]",
    "  rsp wait job <id> [--timeout 45m]",
    "  rsp wait release [--tag <glob>] [--existing] [--timeout 2h]",
    "  rsp wait cmd -- \"<command line>\" [--timeout 30m]",
    "  rsp wait ls",
    "",
    "Examples:",
    "  rsp wait pr 123 --reason \"before merge\"",
    "  rsp wait run --branch feature/wait --latest",
    "  rsp wait job 93919316178",
    "  rsp wait release --tag \"v2.*\" --existing",
    "  rsp wait cmd -- \"pnpm -C apps/rsp build\"",
    "  rsp wait ls",
    "",
    "Doctrine: never hand-write sleep polling loops; run rsp wait in a background shell - process exit IS the signal.",
    "Exit codes: 0 = success verdict, 1 = failure verdict, 2 = timeout/indeterminate.",
    "Result: TOON by default; --json selects JSON; --result-file <path> is written atomically before any wake.",
    "Command capture: --capture-bytes <n> (default 16384); elision handles recover larger stdout/stderr.",
    "Completion hooks: --signal-pid <pid> [--signal USR1] and --notify-cmd \"<cmd>\" run after the result is durable.",
    "Hook timeout: --notify-timeout 10s. Process termination: TERM, --terminate-grace 2s, then KILL.",
    "GitHub bounds: --probe-timeout 60s caps one probe, so a hung gh call cannot outlive --timeout.",
    "",
  ].join("\n");
}
