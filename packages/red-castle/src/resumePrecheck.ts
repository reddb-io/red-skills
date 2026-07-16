import type { AgentProvider } from "./AgentProvider.js";
import type { SandboxProvider } from "./SandboxProvider.js";

/**
 * Fail-fast validation that a resumable agent session exists on the host before
 * launching the agent. Throws a descriptive error when the session is missing.
 *
 * The lookup strategy depends on the sandbox:
 *
 * - **No-sandbox**: the agent runs directly on the host and writes its session
 *   in place under a cwd-derived directory; Sandcastle never moves it. The
 *   agent's own path encoding (realpath canonicalisation plus
 *   non-alphanumeric → hyphen) is fragile and platform-specific to reconstruct,
 *   so we locate the file by its globally-unique session id instead.
 * - **Sandboxed (bind-mount)**: Sandcastle's capture transfers the session into
 *   the host store keyed on the host repo dir, so for a resumable run the file
 *   lives at that exact encoded location — check it directly rather than
 *   scanning. (Isolated sandboxes fall here too, but neither capture nor resume
 *   transfer is wired for them today, so this is the host-repo-dir check by
 *   default.)
 */
export const assertResumeSessionExists = async (params: {
  readonly provider: AgentProvider;
  readonly sandboxTag: SandboxProvider["tag"];
  readonly hostRepoDir: string;
  readonly resumeSession: string;
}): Promise<void> => {
  const { provider, sandboxTag, hostRepoDir, resumeSession } = params;

  if (!provider.sessionStorage) {
    throw new Error(`${provider.name} does not support resumeSession`);
  }

  if (sandboxTag === "none") {
    const found = await provider.sessionStorage.findByIdOnHost(resumeSession);
    if (!found.path) {
      throw new Error(
        `resumeSession "${resumeSession}" not found under ${found.searchedRoot}`,
      );
    }
    return;
  }

  const exists = await provider.sessionStorage.existsOnHost(
    hostRepoDir,
    resumeSession,
  );
  if (!exists) {
    const sessionPath = provider.sessionStorage.hostSessionFilePath(
      hostRepoDir,
      resumeSession,
    );
    throw new Error(
      sessionPath
        ? `resumeSession "${resumeSession}" not found: expected session file at ${sessionPath}`
        : `resumeSession "${resumeSession}" not found`,
    );
  }
};
