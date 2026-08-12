import { encode, type JsonValue } from "@reddb-io/toon";
import { readGhConditionalJson } from "./gh-conditional.js";
import type { GhRenderResult } from "./gh-wrapper.js";
import { classifyWrappedFailure, renderStructuredError } from "./structured-error.js";

export interface GhApiReadRequest {
  path: string;
  params: Record<string, string | number | boolean | undefined>;
}

/** Parse the safe GET-only subset that rsp can route through the resident. */
export function parseGhApiRead(argv: readonly string[]): GhApiReadRequest | null {
  if (argv[0] !== "gh" || argv[1] !== "api") return null;
  let path = "";
  let method = "GET";
  const params: Record<string, string | number | boolean | undefined> = {};
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--method" || arg === "-X") method = (argv[++index] ?? "").toUpperCase();
    else if (arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") {
      const raw = argv[++index] ?? "";
      const equals = raw.indexOf("=");
      if (equals <= 0) return null;
      params[raw.slice(0, equals)] = arg === "-F" || arg === "--field" ? typedApiField(raw.slice(equals + 1)) : raw.slice(equals + 1);
    } else if (["--jq", "-q", "--template", "-t", "--paginate", "--slurp", "--input"].includes(arg)) return null;
    else if (!arg.startsWith("-") && !path) path = arg.replace(/^https:\/\/api\.github\.com\//, "");
    else return null;
  }
  return method === "GET" && path !== "" && path !== "graphql" ? { path, params } : null;
}

export async function runGhApiRead(
  argv: readonly string[],
  read: typeof readGhConditionalJson = readGhConditionalJson,
): Promise<GhRenderResult> {
  const request = parseGhApiRead(argv);
  if (!request) {
    const error = classifyWrappedFailure(argv.join(" "), "", "rsp gh api accepts GET reads without --jq, --template, --paginate, or --input");
    return { stdout: renderStructuredError(error), stderr: Buffer.alloc(0), status: 2, signal: null };
  }
  const response = await read({ ...request, args: ["api", request.path], command: argv.join(" ") });
  if (response.status !== 0) {
    const error = classifyWrappedFailure(argv.join(" "), response.stdout, response.stderr);
    return { stdout: renderStructuredError(error), stderr: Buffer.from(response.stderr), status: error.exitCode ?? response.status, signal: null };
  }
  return {
    stdout: Buffer.from(encode(JSON.parse(response.stdout) as JsonValue)),
    stderr: Buffer.from(response.stderr),
    status: 0,
    signal: null,
  };
}

function typedApiField(value: string): string | number | boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return undefined;
  return /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value) ? Number(value) : value;
}
