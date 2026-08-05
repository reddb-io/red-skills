import tokenDocumentJson from "./tokens.json" with { type: "json" };

export type BrandTokenErrorCode =
  | "TOKEN_NOT_FOUND"
  | "TOKEN_MALFORMED"
  | "TOKEN_ALIAS_CYCLE";

export class BrandTokenError extends Error {
  override readonly name = "BrandTokenError";

  constructor(
    readonly code: BrandTokenErrorCode,
    readonly tokenName: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolvedColorToken {
  readonly name: string;
  readonly hex: `#${string}`;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTokenDocument(value: unknown): JsonObject {
  if (!isObject(value) || !isObject(value.color)) {
    throw new BrandTokenError(
      "TOKEN_MALFORMED",
      "color",
      "The vendored DTCG document has no color token group.",
    );
  }
  return value;
}

// Importing and validating here makes the vendored DTCG document the
// module-load source of truth. Helpers never carry a copied fallback palette.
const tokenDocument = parseTokenDocument(tokenDocumentJson);

function qualifyColorTokenName(name: string): string {
  return name.startsWith("color.") ? name : `color.${name}`;
}

function publicColorTokenName(name: string): string {
  return name.startsWith("color.") ? name.slice("color.".length) : name;
}

function getTokenNode(path: string): unknown {
  let node: unknown = tokenDocument;
  for (const segment of path.split(".")) {
    if (!isObject(node) || !(segment in node)) return undefined;
    node = node[segment];
  }
  return node;
}

function malformed(requestedName: string, detail: string): BrandTokenError {
  return new BrandTokenError(
    "TOKEN_MALFORMED",
    requestedName,
    `Brand color token "${requestedName}" is malformed: ${detail}`,
  );
}

function resolveColorTokenPath(
  path: string,
  requestedName: string,
  visited: ReadonlySet<string>,
): ResolvedColorToken {
  if (visited.has(path)) {
    throw new BrandTokenError(
      "TOKEN_ALIAS_CYCLE",
      requestedName,
      `Brand color token "${requestedName}" contains an alias cycle at "${path}".`,
    );
  }

  const node = getTokenNode(path);
  if (node === undefined) {
    throw new BrandTokenError(
      "TOKEN_NOT_FOUND",
      requestedName,
      `Brand color token "${requestedName}" was not found (resolved path "${path}").`,
    );
  }
  if (!isObject(node) || !("$value" in node)) {
    throw malformed(requestedName, `"${path}" is not a token with a $value`);
  }

  const value = node.$value;
  if (typeof value === "string") {
    const alias = /^\{([^{}]+)\}$/.exec(value);
    if (alias?.[1] === undefined) {
      throw malformed(requestedName, `"${path}" has an invalid alias`);
    }
    return resolveColorTokenPath(alias[1], requestedName, new Set([...visited, path]));
  }

  if (!isObject(value) || typeof value.hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.hex)) {
    throw malformed(requestedName, `"${path}" has no six-digit hex color value`);
  }

  return {
    name: publicColorTokenName(path),
    hex: value.hex.toLowerCase() as `#${string}`,
  };
}

export function resolveColorToken(name: string): ResolvedColorToken {
  return resolveColorTokenPath(qualifyColorTokenName(name), name, new Set());
}

export function tokenToCssHex(name: string): `#${string}` {
  return resolveColorToken(name).hex;
}

function tokenToAnsi(name: string, layer: 38 | 48): string {
  const hex = tokenToCssHex(name);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001B[${layer};2;${red};${green};${blue}m`;
}

export function tokenToAnsiForeground(name: string): string {
  return tokenToAnsi(name, 38);
}

export function tokenToAnsiBackground(name: string): string {
  return tokenToAnsi(name, 48);
}
