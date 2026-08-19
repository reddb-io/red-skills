/**
 * The Worker's terminal policy: the inner agent only edits and commits.
 *
 * ADR 0148 states the contract and ADR 0144 §3 says why: no credential ever
 * reaches the process that runs the model, so every operation that would need
 * one — publishing a branch, anything `gh`, any authenticated remote — is the
 * ACP parent's. The inner agent learns that by being REFUSED WITH A REASON it
 * can read, rather than by watching `git push` fail on a missing credential and
 * spending its turn inventing workarounds.
 *
 * **This is a teacher, not a sandbox.** Containment is that the Worker's
 * environment holds no credential at all (`credentialFreeEnv`); a sufficiently
 * creative `xargs` still reaches `git push` and still finds nothing to push
 * with. So the table below is small, explicit and named after the AUTHORITY
 * each entry belongs to, because a rule the agent can predict is a rule it
 * stops testing.
 */

/** Which authority owns the refused operation. The agent reads this verbatim. */
export type WorkerTerminalDenialReason =
  /** Publishing a branch: the Worker asks its parent after the turn. */
  | "publication-is-parent-owned"
  /** Any forge CLI: redskilled is the Project's only GitHub gateway. */
  | "forge-cli-is-parent-owned"
  /** Any other authenticated remote reach: the Worker holds no credential. */
  | "credentialed-remote-is-parent-owned";

export interface WorkerTerminalDenial {
  readonly decision: "deny";
  readonly reason: WorkerTerminalDenialReason;
  /** The simple command that tripped the policy, re-joined for the agent to see. */
  readonly command: string;
  /** What the refused command would have done, in one noun phrase. */
  readonly what: string;
  /** What to do instead, named concretely enough to act on. */
  readonly remedy: string;
}

export interface WorkerTerminalAllowance {
  readonly decision: "allow";
}

export type WorkerTerminalDecision = WorkerTerminalAllowance | WorkerTerminalDenial;

export interface WorkerTerminalRequest {
  readonly command: string;
  readonly args?: readonly string[];
}

/** One refused program, or one refused subcommand family of a program. */
interface DeniedProgram {
  /** Program basename, lowercased, without a Windows executable suffix. */
  readonly program: string;
  /** Absent means the whole program is refused; present narrows it to these. */
  readonly subcommands?: readonly string[];
  readonly reason: WorkerTerminalDenialReason;
  readonly what: string;
}

/**
 * What the Worker refuses, as data.
 *
 * `git` is split by subcommand because refusing the program would refuse the
 * inner agent's actual job — `git add`, `git commit`, `git diff`, `git log` are
 * the whole point. Every entry below is a subcommand that talks to a remote.
 */
export const WORKER_DENIED_TERMINAL_PROGRAMS: readonly DeniedProgram[] = [
  {
    program: "git",
    subcommands: ["push"],
    reason: "publication-is-parent-owned",
    what: "publishing commits to the Project remote",
  },
  {
    program: "git",
    subcommands: [
      "fetch",
      "pull",
      "clone",
      "remote",
      "ls-remote",
      "submodule",
      "send-email",
      "request-pull",
      "credential",
      "credential-cache",
      "credential-store",
    ],
    reason: "credentialed-remote-is-parent-owned",
    what: "an authenticated git operation against a remote",
  },
  { program: "gh", reason: "forge-cli-is-parent-owned", what: "a GitHub CLI call" },
  { program: "glab", reason: "forge-cli-is-parent-owned", what: "a GitLab CLI call" },
  { program: "hub", reason: "forge-cli-is-parent-owned", what: "a GitHub CLI call" },
  { program: "ssh", reason: "credentialed-remote-is-parent-owned", what: "an authenticated SSH session" },
  { program: "scp", reason: "credentialed-remote-is-parent-owned", what: "an authenticated remote copy" },
  { program: "sftp", reason: "credentialed-remote-is-parent-owned", what: "an authenticated remote transfer" },
];

const REMEDIES: Readonly<Record<WorkerTerminalDenialReason, string>> = {
  "publication-is-parent-owned":
    "Commit locally and finish the turn; the Worker asks its ACP parent to publish the branch and commit afterwards.",
  "forge-cli-is-parent-owned":
    "Ask the ACP parent instead: redskilled is the Project's only GitHub gateway and this process holds no token.",
  "credentialed-remote-is-parent-owned":
    "Ask the ACP parent instead: this process holds no credential, so the operation can only succeed there.",
};

/** Shells whose `-c` script is a command line, not an argument. */
const SHELL_PROGRAMS: readonly string[] = ["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell"];

/** Programs that run another program: the real head is further along the argv. */
const WRAPPER_PROGRAMS: readonly string[] = ["env", "sudo", "nohup", "command", "exec", "nice", "stdbuf"];

/**
 * Decide one `terminal/create` request.
 *
 * Shell invocations are opened, because `bash -lc "git push"` is the same
 * operation with one more layer, and an agent that discovers the layer works
 * has learned the opposite of the contract. Quoting is respected while doing it:
 * refusing `git commit -m "ready for gh pr create"` would teach a rule nobody
 * meant and is exactly the false refusal that makes an agent distrust the whole
 * policy.
 */
export function evaluateWorkerTerminalRequest(request: WorkerTerminalRequest): WorkerTerminalDecision {
  for (const simple of simpleCommands([request.command, ...(request.args ?? [])])) {
    const denial = refuse(simple);
    if (denial != null) return denial;
  }
  return { decision: "allow" };
}

/** The typed payload a refusal carries back over ACP, under `_meta.redskills`. */
export function workerTerminalDenialMeta(denial: WorkerTerminalDenial): Record<string, unknown> {
  return {
    redskills: {
      terminalPolicy: {
        decision: "deny",
        reason: denial.reason,
        command: denial.command,
        what: denial.what,
        remedy: denial.remedy,
      },
    },
  };
}

/** One line stating the refusal, its reason and its route, for the agent to read. */
export function workerTerminalDenialMessage(denial: WorkerTerminalDenial): string {
  return `${denial.reason}: the Worker refuses \`${denial.command}\` — ${denial.what} is the ACP parent's. ${denial.remedy}`;
}

function refuse(tokens: readonly string[]): WorkerTerminalDenial | null {
  const head = headOf(tokens);
  if (head == null) return null;
  const program = programName(tokens[head.index] ?? "");
  const subcommand = subcommandOf(program, tokens.slice(head.index + 1));
  for (const denied of WORKER_DENIED_TERMINAL_PROGRAMS) {
    if (denied.program !== program) continue;
    if (denied.subcommands != null && (subcommand == null || !denied.subcommands.includes(subcommand))) {
      continue;
    }
    return {
      decision: "deny",
      reason: denied.reason,
      command: tokens.slice(head.index).join(" "),
      what: denied.what,
      remedy: REMEDIES[denied.reason],
    };
  }
  return null;
}

/**
 * Where the real program starts, past wrappers and `NAME=value` prefixes.
 *
 * `env GIT_TERMINAL_PROMPT=0 git push` names three tokens before the operation
 * this policy is about, and reading the first one would call it `env`.
 */
function headOf(tokens: readonly string[]): { readonly index: number } | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === "") continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (token.startsWith("-")) continue;
    if (WRAPPER_PROGRAMS.includes(programName(token))) continue;
    return { index };
  }
  return null;
}

/** The first token past the program's own options — `git -C dir push` is a push. */
function subcommandOf(program: string, rest: readonly string[]): string | null {
  if (program !== "git") return rest.find((token) => !token.startsWith("-")) ?? null;
  // `git`'s pre-command options are the reason this is not `rest[0]`: `-C`, `-c`
  // and `--git-dir` each swallow or carry a value that is not the subcommand.
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    if (token === "-C" || token === "-c" || token === "--namespace" || token === "--exec-path") {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function programName(token: string): string {
  const base = token.split(/[/\\]/).pop() ?? token;
  return base.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase();
}

/**
 * Every simple command the request would run, argv first and shell scripts too.
 *
 * A non-shell invocation is one simple command: its own argv. A shell `-c`
 * script is however many its operators separate.
 */
function simpleCommands(argv: readonly string[]): readonly (readonly string[])[] {
  const simple: (readonly string[])[] = [argv];
  const program = programName(argv[0] ?? "");
  if (!SHELL_PROGRAMS.includes(program)) return simple;
  for (const script of shellScripts(argv.slice(1))) {
    for (const segment of shellSegments(script)) simple.push(tokenize(segment));
  }
  return simple;
}

/** The argument of each `-c`-shaped flag; a shell may take more than one. */
function shellScripts(rest: readonly string[]): readonly string[] {
  const scripts: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? "";
    const next = rest[index + 1];
    if (token === "--command" || /^-[a-z]*c$/i.test(token) || /^\/[cC]$/.test(token)) {
      if (next != null) {
        scripts.push(next);
        index += 1;
      }
    }
  }
  return scripts;
}

/**
 * Split a shell script into its simple commands, respecting quotes.
 *
 * Quote awareness is the whole value: splitting naively turns a commit message
 * mentioning `&&` into a second command, and the resulting refusal is one no
 * rule in this module explains.
 */
export function shellSegments(script: string): readonly string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote != null) {
      if (char === "\\" && quote === '"') {
        current += char + (script[index + 1] ?? "");
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\") {
      current += script[index + 1] ?? "";
      index += 1;
      continue;
    }
    // `$(` and a backtick open a command substitution: what follows is another
    // command line, so the boundary is the same boundary as `;`.
    if (char === "$" && script[index + 1] === "(") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (";|&\n()`".includes(char)) {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== "");
}

function tokenize(segment: string): readonly string[] {
  return segment.trim().split(/\s+/).filter((token) => token !== "");
}
