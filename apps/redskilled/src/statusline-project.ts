import {
  readDeclaredProjectName,
  resolveProjectLabelForDir,
} from "@reddb-io/shared/project-identity-resolve.js";

/**
 * The calling directory's project label, and the config that carries its taste.
 *
 * Resolved through the same authority that labels a Worker at birth. A directory
 * outside a RedSkills project has neither config nor project identity, even when
 * it happens to sit below a git checkout.
 */
export function readStatuslineProject(cwd: string): { configText?: string; label: string | null } {
  const declared = readDeclaredProjectName(cwd);
  if (declared.configText == null) return { label: null };
  return { configText: declared.configText, label: resolveProjectLabelForDir(cwd) };
}
