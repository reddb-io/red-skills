import tokenDocumentJson from "./tokens.json" with { type: "json" };

export class BrandTokenError extends Error {
  name = "BrandTokenError";

  constructor(code, tokenName, message) {
    super(message);
    this.code = code;
    this.tokenName = tokenName;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (!isObject(tokenDocumentJson) || !isObject(tokenDocumentJson.color)) {
  throw new BrandTokenError("TOKEN_MALFORMED", "color", "The vendored DTCG document has no color token group.");
}

const tokenDocument = tokenDocumentJson;

function getTokenNode(path) {
  let node = tokenDocument;
  for (const segment of path.split(".")) {
    if (!isObject(node) || !(segment in node)) return undefined;
    node = node[segment];
  }
  return node;
}

function malformed(requestedName, detail) {
  return new BrandTokenError(
    "TOKEN_MALFORMED",
    requestedName,
    `Brand color token "${requestedName}" is malformed: ${detail}`,
  );
}

function resolveColorTokenPath(path, requestedName, visited) {
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
    if (alias?.[1] === undefined) throw malformed(requestedName, `"${path}" has an invalid alias`);
    return resolveColorTokenPath(alias[1], requestedName, new Set([...visited, path]));
  }

  if (!isObject(value) || typeof value.hex !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value.hex)) {
    throw malformed(requestedName, `"${path}" has no six-digit hex color value`);
  }

  return {
    name: path.startsWith("color.") ? path.slice("color.".length) : path,
    hex: value.hex.toLowerCase(),
  };
}

export function resolveColorToken(name) {
  const path = name.startsWith("color.") ? name : `color.${name}`;
  return resolveColorTokenPath(path, name, new Set());
}

export function tokenToCssHex(name) {
  return resolveColorToken(name).hex;
}

function tokenToAnsi(name, layer) {
  const hex = tokenToCssHex(name);
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `\u001B[${layer};2;${red};${green};${blue}m`;
}

export function tokenToAnsiForeground(name) {
  return tokenToAnsi(name, 38);
}

export function tokenToAnsiBackground(name) {
  return tokenToAnsi(name, 48);
}
