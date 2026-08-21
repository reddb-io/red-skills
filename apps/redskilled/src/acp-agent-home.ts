/**
 * acp-agent-home — the host-side home a child Agent runs OUT OF.
 *
 * A Worker's child Agent must not inherit the operator's interactive dotfiles:
 * the first codex Worker on this host died on the operator's own
 * `~/.codex/config.toml` naming a model the pinned adapter cannot run. So an
 * adapter child gets a daemon-owned home under the redskilled home, seeded with
 * exactly one operator fact — the credential the child cannot mint for itself.
 */
import { chmod, copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AcpAgentId } from "@reddb-io/protocol-acp";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";

/**
 * The Agents that keep their state in an `opencode.db` and must not share one.
 *
 * redcode is opencode's engine, so the failure is the same engine's: redcode#58
 * observed concurrent instances on one DB dying mid-turn on "database is
 * locked". opencode reached the same catalog with no isolation at all (#4278) —
 * the very file the bug is about, and the reason this is ONE branch rather than
 * the literal written twice.
 */
const OPENCODE_ENGINE_AGENTS = new Set<AcpAgentId>(["redcode", "opencode"]);

/**
 * The Agents whose credential the daemon seeds into a home of its own.
 *
 * An Agent that authenticates through a login file cannot use the operator's
 * home: a Worker inherits no interactive dotfiles (that is the point — the
 * operator's `~/.codex/config.toml` named a model the pinned adapter could not
 * run), and inheriting nothing means it authenticates as nobody. Observed as
 * `Authentication required` on the first live claude-code drain (#4278's
 * posture half was proven while its credential half was not). Each entry
 * states the env var the Agent reads, the operator file it logs into, and the
 * file name inside the daemon's home.
 */
const CREDENTIAL_HOMES = {
  codex: { env: "CODEX_HOME", operatorDir: ".codex", file: "auth.json", login: "codex login" },
  "claude-code": {
    env: "CLAUDE_CONFIG_DIR",
    operatorDir: ".claude",
    file: ".credentials.json",
    login: "claude login",
  },
} as const satisfies Partial<Record<AcpAgentId, {
  readonly env: string;
  readonly operatorDir: string;
  readonly file: string;
  readonly login: string;
}>>;

type CredentialAgent = keyof typeof CREDENTIAL_HOMES;

function credentialHome(agent: AcpAgentId): (typeof CREDENTIAL_HOMES)[CredentialAgent] | undefined {
  return (CREDENTIAL_HOMES as Record<string, (typeof CREDENTIAL_HOMES)[CredentialAgent] | undefined>)[agent];
}

/** The env one child Agent needs to stand apart from its siblings and the operator. PURE. */
export function childAgentWorkspaceEnv(
  agent: AcpAgentId,
  workspacePath: string,
  homeDirPath: string = homedir(),
): Record<string, string> {
  // Each Worker's child gets its own DB inside the Worker's disposable
  // workspace, named for the Agent that owns it — so the file dies with the
  // workspace and two Agents in one workspace never collide either.
  if (OPENCODE_ENGINE_AGENTS.has(agent)) return { OPENCODE_DB: join(workspacePath, `${agent}.db`) };
  const credential = credentialHome(agent);
  if (credential != null) return { [credential.env]: agentCredentialHome(agent, homeDirPath) };
  return {};
}

/** The daemon-owned home for one Agent; the operator's own is never a Worker's. */
export function agentCredentialHome(agent: AcpAgentId, homeDirPath: string = homedir()): string {
  return join(redskilledHomeDir(homeDirPath), "agent-homes", agent);
}

/** The daemon-owned codex home. Kept as the name its callers already import. */
export function codexAgentHome(homeDirPath: string = homedir()): string {
  return agentCredentialHome("codex", homeDirPath);
}

/**
 * Create the daemon-owned home and seed the operator credential into it.
 *
 * The seed re-copies when the operator's login is NEWER than the seeded copy
 * (a re-login must reach Workers), and never overwrites a seed the child has
 * since refreshed itself. A host where the operator never logged in is refused
 * loudly here, before a Worker is born to fail on it.
 */
export async function ensureChildAgentHome(agent: AcpAgentId, homeDirPath: string = homedir()): Promise<void> {
  const credential = credentialHome(agent);
  if (credential == null) return;
  const home = agentCredentialHome(agent, homeDirPath);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const seeded = join(home, credential.file);
  const operator = join(homeDirPath, credential.operatorDir, credential.file);
  const [seededAt, operatorAt] = await Promise.all([mtimeOf(seeded), mtimeOf(operator)]);
  if (operatorAt == null) {
    if (seededAt != null) return;
    throw new Error(
      `${agent} has no host login: ~/${credential.operatorDir}/${credential.file} is absent. ` +
        `Run \`${credential.login}\` as the operator first.`,
    );
  }
  if (seededAt == null || operatorAt > seededAt) {
    await copyFile(operator, seeded);
    await chmod(seeded, 0o600);
  }
}

async function mtimeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}
