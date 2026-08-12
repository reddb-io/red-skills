export function renderCliHelp(argv: readonly string[]): string {
  const command = argv[0] === "--help" || argv[0] === "-h" ? undefined : argv[0];
  const lines = commandHelpLines(command);
  return `${lines.join("\n")}\n`;
}

function commandHelpLines(command: string | undefined): string[] {
  switch (command) {
    case "stats":
      return scopedHelp("rsp stats [--since <days>d] [--full]", [
        "Defaults: --since 30d, --full false",
        "--since <days>d  telemetry window, default 30d",
        "--full           include wider daily/top-command/failure lists, default false",
        "--store-uri <uri> read a non-default store",
      ], ["rsp stats", "rsp stats --since 7d --full"]);
    case "gains":
      return scopedHelp("rsp gains [--since <days>d]", [
        "--since <days>d  gains window, default 28d",
        "--store-uri <uri> read a non-default shared RedDB store",
      ], ["rsp gains", "rsp gains --since 14d"]);
    case "show":
      return scopedHelp("rsp show <handle>", [
        "<handle>        elision handle such as el:<id>",
        "--store-uri <uri> read a non-default store",
      ], ["rsp show el:<id>", "rsp show <handle>"]);
    case "git":
      return scopedHelp("rsp git <status|log|diff|show|blame|branch|commit|push> [options]", [
        "--brief          compact output, default lossless",
        "--terse          aggressively summarize and mint recovery handles",
        "--query <text>   filter rendered rows",
        "--full           keep full supported wrapper detail",
      ], ["rsp git status --brief", "rsp git log --terse", "rsp git diff --query <path>"]);
    case "gh":
      return scopedHelp("rsp gh <pr|issue|run> <list|view> [options] | api <REST-path> | <issues|prs|edit-labels|link-sub-issues> ...", [
        "--brief          compact output, default lossless",
        "--terse          aggressively summarize and mint recovery handles",
        "--query <text>   filter rendered rows",
        "--full           keep full supported wrapper detail",
        "--json <fields>  select fields for batched issues/prs",
        "--repo <slug>    owner/repo override for batched operations",
        "api GET reads    use the resident ETag/rate-aware client and emit canonical TOON",
      ], [
        "rsp gh issues 42 43 --json state,title,labels,body",
        "rsp gh prs 12 13 --json state,mergeable,statusCheckRollup",
        "rsp gh edit-labels --add ready-for-agent --remove blocked:crashed 42 43",
        "rsp gh link-sub-issues 100 101 102",
        "rsp gh api repos/owner/repo/actions/runs/123",
      ]);
    case "vitest":
      return scopedHelp("rsp vitest [run] [vitest-options]", [
        "--brief          compact output, default lossless",
        "--terse          summarize long failures and mint recovery handles",
        "--query <text>   filter failure rows",
      ], ["rsp vitest run", "rsp vitest run --query <suite-or-test>"]);
    case "cargo":
      return scopedHelp("rsp cargo test [cargo-test-options]", [
        "--brief          compact output, default lossless",
        "--terse          summarize long failures and mint recovery handles",
        "--query <text>   filter failure rows",
      ], ["rsp cargo test", "rsp cargo test --query <test-name>"]);
    case "cat":
      return scopedHelp("rsp cat [--head <n>|--tail <n>|--full] <file>", [
        "--head <n>       show first n lines, default slice 10",
        "--tail <n>       show last n lines, default slice 10",
        "--full           emit full text even when it is large",
        "--brief/--terse  reduce large text context",
      ], ["rsp cat <file>", "rsp cat --head 20 <file>", "rsp cat --tail 20 <file>"]);
    case "exec":
      return scopedHelp("rsp exec -- \"<command line>\"", [
        "--brief          compact recognized stdout, default lossless",
        "--terse          summarize large stdout and mint recovery handles",
        "--query <text>   filter supported structured summaries",
      ], ["rsp exec -- \"pnpm -C apps/rsp build\"", "rsp exec -- \"git status --short\""]);
    case "proxy":
      return scopedHelp("rsp proxy -- <command line>", [
        "--brief          compact recognized stdout, default lossless",
        "--terse          summarize recognized large stdout",
      ], ["rsp proxy -- git status", "rsp proxy -- pnpm test"]);
    case "wait":
      return [
        "usage: rsp wait <subcommand> [options]",
        "",
        "Flags and defaults:",
        "  --timeout <duration> default 30m for cmd, 45m for pr/run/job, 2h for release",
        "  --reason <text>     default empty",
        "  --signal-pid <pid>  optional completion signal target",
        "  --signal <signal>   default USR1",
        "  --notify-cmd <cmd>  optional completion command",
        "",
        "Examples:",
        "  rsp wait pr 123 --reason \"before merge\"",
        "  rsp wait run --branch feature/wait --latest",
        "  rsp wait job 93919316178",
        "  rsp wait release --tag \"v2.*\" --existing",
        "  rsp wait cmd -- \"pnpm -C apps/rsp build\"",
        "  rsp wait ls",
        "",
        "Exit codes: 0 = success verdict, 1 = failure verdict, 2 = timeout/indeterminate.",
      ];
    case "doctor":
      return scopedHelp("rsp doctor [--since <days>d]", [
        "--since <days>d  recent degradation window, default 1d",
      ], ["rsp doctor", "rsp doctor --since 7d"]);
    case "status":
      return scopedHelp("rsp status", [
        "No flags. Prints resident registry status as TOON.",
      ], ["rsp status"]);
    case "sweep":
      return scopedHelp("rsp sweep", [
        "No flags. Removes stale resident registry entries, reclaims orphan state temps,",
        "re-bounds the gh ETag cache, and prints TOON status.",
      ], ["rsp sweep"]);
    case "setup":
      return scopedHelp("rsp setup", [
        "No flags. Provisions repo rsp configuration and store state.",
      ], ["rsp setup"]);
    case "mcp":
      return scopedHelp("rsp mcp", [
        "No flags. Starts the rsp MCP server over stdio.",
      ], ["rsp mcp"]);
    case "shell-init":
      return scopedHelp("rsp shell-init <fish|bash|zsh>", [
        "<fish|bash|zsh> target shell, no default",
      ], ["rsp shell-init bash", "rsp shell-init fish"]);
    case "server":
      return scopedHelp("rsp server [options]", [
        "--socket <path>                      default resident socket",
        "--pid-file <path>                    default resident pid file",
        "--store-uri <uri>                    default repo store",
        "--ttl-days <days>                    default from config",
        "--ephemeral-ttl-hours <hours>        default from config",
        "--byte-budget <bytes>                default from config",
        "--idle-ms <ms>                       default from config",
      ], ["rsp server", "rsp server --socket <path> --store-uri <uri>"]);
    case "warm-resident":
      return scopedHelp("rsp warm-resident [options]", [
        "--socket <path>               default resident socket",
        "--wake-lock <path>            default resident wake lock",
        "--store-uri <uri>             default repo store",
        "--idle-ms <ms>                default from config",
      ], ["rsp warm-resident", "rsp warm-resident --store-uri <uri>"]);
    case "gh-api-json":
      return scopedHelp("rsp gh-api-json <path> [-f name=value ...]", [
        "-f name=value     string GitHub API field",
        "-F name=value     typed GitHub API field",
      ], ["rsp gh-api-json repos/{owner}/{repo}", "rsp gh-api-json repos/{owner}/{repo}/pulls -f state=open"]);
    case "dashboard":
      return scopedHelp("rsp dashboard", [
        "No flags. The explicit spelling of the bare `rsp` invocation.",
      ], ["rsp", "rsp dashboard"]);
    case "hook":
      return scopedHelp("rsp hook <claude-pre-exec|codex-pre-exec|claude-post-exec|codex-post-exec>", [
        "Reads hook payload from stdin. Defaults come from the calling host.",
      ], ["rsp hook codex-pre-exec", "rsp hook claude-pre-exec"]);
    case undefined:
      return [
        "usage: rsp <subcommand> [options]",
        "",
        "Bare invocation:",
        "  rsp",
        "    renders a live TOON dashboard with recovery handles, active waits, savings, and health.",
        "",
        "Subcommands:",
        "  dashboard, stats, gains, show, git, gh, vitest, cargo, cat, exec, proxy, wait",
        "  doctor, status, sweep, setup, mcp, shell-init, server, warm-resident, gh-api-json, hook",
        "",
        "Global flags:",
        "  --store-uri <uri>  default repo store",
        "  --brief            compact summaries",
        "  --terse            aggressive summaries with recovery handles",
        "  --full             suppress automatic reduction",
        "  --query <text>     filter supported rendered output",
        "  --help, -h         scoped help",
        "  --version, -v      build version; add --json for structured build info",
        "",
        "Examples:",
        "  rsp",
        "  rsp stats --since 7d",
        "  rsp git log --terse",
        "  rsp --full -- <command> <args...>",
        "  rsp show el:<id>",
      ];
    default:
      return scopedHelp(`rsp ${command} [options]`, [
        "Unknown rsp subcommand. Use root help to list supported subcommands.",
      ], ["rsp --help"]);
  }
}

function scopedHelp(usage: string, flags: readonly string[], examples: readonly string[]): string[] {
  return [
    `usage: ${usage}`,
    "",
    "Flags and defaults:",
    ...flags.map((flag) => `  ${flag}`),
    "",
    "Examples:",
    ...examples.map((example) => `  ${example}`),
  ];
}
