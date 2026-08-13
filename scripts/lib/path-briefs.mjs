/** Error raised when a SKILL.md declares an invalid `paths:` field. */
export class SkillPathsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkillPathsError";
  }
}

function frontmatterLines(source) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return [];
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new SkillPathsError("frontmatter has no closing --- delimiter");
  return lines.slice(1, end);
}

function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function parseInlineList(value) {
  const body = value.slice(1, -1);
  const items = [];
  let item = "";
  let quote = "";
  let braceDepth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      item += character;
      if (character === quote && body[index - 1] !== "\\") quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
      item += character;
    } else if (character === "{") {
      braceDepth += 1;
      item += character;
    } else if (character === "}") {
      braceDepth -= 1;
      item += character;
    } else if (character === "," && braceDepth === 0) {
      items.push(unquote(item.trim()));
      item = "";
    } else {
      item += character;
    }
  }
  items.push(unquote(item.trim()));
  return items;
}

function invalidGlob(glob, reason) {
  throw new SkillPathsError(`invalid paths glob ${JSON.stringify(glob)}: ${reason}`);
}

/** Reject glob spellings that are ambiguous, malformed, or leave the repo. */
export function validatePathGlob(glob) {
  if (typeof glob !== "string" || glob.length === 0) invalidGlob(glob, "expected a non-empty string");
  if (glob !== glob.trim()) invalidGlob(glob, "leading or trailing whitespace is not allowed");
  if (glob.includes("\\")) invalidGlob(glob, "use repository-relative / separators");
  if (glob.startsWith("/") || /^[A-Za-z]:\//.test(glob)) invalidGlob(glob, "absolute paths are not allowed");
  const segments = glob.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    invalidGlob(glob, "empty, . and .. path segments are not allowed");
  }
  if (segments.some((segment) => segment.includes("**") && segment !== "**")) {
    invalidGlob(glob, "** must occupy a complete path segment");
  }

  let bracket = false;
  let bracketStart = -1;
  let brace = false;
  let braceStart = -1;
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "[") {
      if (bracket) invalidGlob(glob, "nested character classes are not supported");
      bracket = true;
      bracketStart = index;
    } else if (character === "]") {
      if (!bracket) invalidGlob(glob, "unmatched ]");
      const body = glob.slice(bracketStart + 1, index).replace(/^!/, "");
      if (body.length === 0) invalidGlob(glob, "empty character class");
      bracket = false;
    } else if (!bracket && character === "{") {
      if (brace) invalidGlob(glob, "nested brace alternatives are not supported");
      brace = true;
      braceStart = index;
    } else if (!bracket && character === "}") {
      if (!brace) invalidGlob(glob, "unmatched }");
      const alternatives = glob.slice(braceStart + 1, index).split(",");
      if (alternatives.length < 2 || alternatives.some((alternative) => alternative.length === 0)) {
        invalidGlob(glob, "brace alternatives require two or more non-empty values");
      }
      brace = false;
    }
  }
  if (bracket) invalidGlob(glob, "unclosed character class");
  if (brace) invalidGlob(glob, "unclosed brace alternative");
  return glob;
}

function validated(paths) {
  for (const path of paths) validatePathGlob(path);
  return paths;
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function globSource(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        source += "(?:[^/]+/)*";
      } else {
        source += ".*";
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else if (character === "[") {
      const end = glob.indexOf("]", index + 1);
      let body = glob.slice(index + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      source += `[${body}]`;
      index = end;
    } else if (character === "{") {
      const end = glob.indexOf("}", index + 1);
      const alternatives = glob.slice(index + 1, end).split(",");
      source += `(?:${alternatives.map(escapeRegex).join("|")})`;
      index = end;
    } else {
      source += escapeRegex(character);
    }
  }
  return source;
}

/** True when one validated repository-relative glob matches a file path. */
export function pathMatchesGlob(filePath, glob) {
  validatePathGlob(glob);
  const candidate = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return new RegExp(`^${globSource(glob)}$`).test(candidate);
}

/** Return declared briefs matching `filePath`, preserving declaration order. */
export function matchPathBriefs(briefs, filePath) {
  return briefs.filter((brief) => brief.paths.some((glob) => pathMatchesGlob(filePath, glob)));
}

/** Parse the optional `paths:` frontmatter field into its ordered glob list. */
export function parseSkillPaths(source) {
  const lines = frontmatterLines(source);
  const declarations = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^paths:/.test(line));
  if (declarations.length === 0) return [];
  if (declarations.length > 1) throw new SkillPathsError("paths must be declared only once");
  const pathsLine = declarations[0].index;

  const inline = lines[pathsLine].match(/^paths:\s*(\[.*\])\s*$/);
  if (inline) {
    const paths = parseInlineList(inline[1]);
    if (paths.length === 0 || paths.some((path) => path === "")) {
      throw new SkillPathsError("paths must be a non-empty glob list");
    }
    return validated(paths);
  }
  if (!/^paths:\s*$/.test(lines[pathsLine])) {
    throw new SkillPathsError("paths must be a non-empty glob list");
  }

  const paths = [];
  for (let index = pathsLine + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s+-\s+(.+?)\s*$/);
    if (!match) break;
    paths.push(unquote(match[1]));
  }
  if (paths.length === 0) throw new SkillPathsError("paths must be a non-empty glob list");
  return validated(paths);
}
