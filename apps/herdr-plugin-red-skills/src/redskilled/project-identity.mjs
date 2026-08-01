/**
 * project-identity — which project label this directory belongs to.
 *
 * ADR 0130 rule 11: a declared `project.name` wins, else the git remote's
 * `owner/repo`, else the checkout basename. The label is the one string that
 * makes a read local instead of host-wide, so resolving it wrong shows an
 * operator somebody else's machine.
 *
 * A miss is not an error. The dashboard defaults to the host-wide view and only
 * uses this to answer "which of these rows is mine", so a directory that is no
 * checkout at all resolves to `null` and every row stays unmarked.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `project.name` from a `.red/config.yaml`, without taking on a YAML parser. */
async function declaredProjectName(dir) {
  let raw;
  try {
    raw = await readFile(join(dir, ".red", "config.yaml"), "utf8");
  } catch {
    return null;
  }
  // Deliberately narrow: a two-line `project:` / `  name: x` block and nothing
  // else. A regex that matched a `name:` at any depth would happily return a
  // plugin's or a hook's name and call it the project.
  const match = /^project:[^\S\n]*\n(?:[^\S\n]+[^\n]*\n)*?[^\S\n]+name:[^\S\n]*(?:"([^"]*)"|'([^']*)'|([^\s#][^\n#]*?))[^\S\n]*(?:#[^\n]*)?$/m
    .exec(raw);
  if (!match) return null;
  const name = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  return name === "" ? null : name;
}

/** `owner/repo` from the origin remote, whatever URL form it takes. */
export function repositoryFromRemote(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim().replace(/\.git$/, "");
  const match = /(?:[:/])([^/:]+)\/([^/]+)$/.exec(trimmed);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function remoteProjectName(dir) {
  try {
    const { stdout } = await run("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 2_000 });
    return repositoryFromRemote(stdout);
  } catch {
    return null;
  }
}

/** The project label for `dir`, or `null` when nothing identifies one. */
export async function resolveProjectLabel(dir = process.cwd()) {
  const root = resolve(dir);
  const declared = await declaredProjectName(root);
  if (declared) return declared;
  const remote = await remoteProjectName(root);
  if (remote) return remote;
  const name = basename(root);
  return name === "" || name === "/" ? null : name;
}
