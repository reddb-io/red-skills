import type { GeneratedSurfaceDeclaration } from "./config.js";

export interface MechanicalRegenerationStepResult {
  readonly ok: boolean;
  readonly evidence?: string;
}

export interface MechanicalRegenerationResult {
  readonly ok: boolean;
  readonly evidence: string;
}

export interface MechanicalRegenerationRequest {
  readonly issue: number;
  readonly branch: string;
  readonly baseRef: string;
  readonly remote: string;
  readonly paths: readonly string[];
  readonly command: string;
}

export type MechanicalRegenerator = (
  input: MechanicalRegenerationRequest,
) => Promise<MechanicalRegenerationResult>;

export interface MechanicalRegenerationSteps {
  readonly mergeBase: () => Promise<MechanicalRegenerationStepResult>;
  readonly runCommand: (command: string) => Promise<MechanicalRegenerationStepResult>;
  readonly changedFiles: () => Promise<readonly string[]>;
  readonly commitAndPublish: (paths: readonly string[]) => Promise<MechanicalRegenerationStepResult>;
}

function normalisePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegex(character: string): string {
  return /[\\^$.[\]{}()+|]/.test(character) ? `\\${character}` : character;
}

/** Convert the declaration's repository-relative glob vocabulary to a regex. */
function globRegex(glob: string): RegExp {
  const source = normalisePath(glob);
  let pattern = "^";
  for (let i = 0; i < source.length; i += 1) {
    const character = source[i]!;
    if (character === "*" && source[i + 1] === "*") {
      i += 1;
      if (source[i + 1] === "/") {
        i += 1;
        pattern += "(?:.*/)?";
      } else {
        pattern += ".*";
      }
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += escapeRegex(character);
    }
  }
  return new RegExp(`${pattern}$`);
}

export function generatedPathMatches(path: string, globs: readonly string[]): boolean {
  const candidate = normalisePath(path);
  return globs.some((glob) => globRegex(glob).test(candidate));
}

/** Empty or mixed evidence never authorises a mechanical cure. */
export function onlyGeneratedPaths(paths: readonly string[], globs: readonly string[]): boolean {
  return paths.length > 0 && globs.length > 0 && paths.every((path) => generatedPathMatches(path, globs));
}

function failed(stage: string, result: MechanicalRegenerationStepResult): MechanicalRegenerationResult {
  return {
    ok: false,
    evidence: `${stage} failed${result.evidence?.trim() ? `: ${result.evidence.trim()}` : ""}`,
  };
}

/**
 * The mechanical gate executor: merge the fresh base, run the one declared
 * command verbatim, prove its output stayed inside the declaration, then commit
 * and publish. Any failed step returns exact evidence to the agent correction.
 */
export async function healGeneratedDrift(
  steps: MechanicalRegenerationSteps,
  declaration: GeneratedSurfaceDeclaration,
): Promise<MechanicalRegenerationResult> {
  const merged = await steps.mergeBase();
  if (!merged.ok) return failed("base merge", merged);

  const generated = await steps.runCommand(declaration.command);
  if (!generated.ok) return failed("generator", generated);

  const changed = [...await steps.changedFiles()];
  const undeclared = changed.filter((path) => !generatedPathMatches(path, declaration.paths));
  if (undeclared.length > 0) {
    return { ok: false, evidence: `generator changed undeclared paths: ${undeclared.join(", ")}` };
  }

  const published = await steps.commitAndPublish(changed);
  if (!published.ok) return failed("commit/publish", published);
  return { ok: true, evidence: "merge, regeneration, commit, and publish completed" };
}
