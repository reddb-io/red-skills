/**
 * Language registry: maps file extensions to the language server that should
 * handle them. The defaults below cover servers commonly found on a dev box;
 * override or extend via the CODE_NAV_SERVERS env var (JSON), e.g.:
 *
 *   CODE_NAV_SERVERS='{"go":{"command":"gopls","extensions":[".go"]}}'
 */

export interface ServerSpec {
  /** Executable to spawn (must be on PATH or an absolute path). */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** File extensions (with leading dot) this server handles. */
  extensions: string[];
  /** LSP languageId reported on textDocument/didOpen. */
  languageId: string;
}

const DEFAULT_SERVERS: Record<string, ServerSpec> = {
  typescript: {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    languageId: "typescript",
  },
  go: {
    command: "gopls",
    args: [],
    extensions: [".go"],
    languageId: "go",
  },
  rust: {
    command: "rust-analyzer",
    args: [],
    extensions: [".rs"],
    languageId: "rust",
  },
  python: {
    command: "pyright-langserver",
    args: ["--stdio"],
    extensions: [".py", ".pyi"],
    languageId: "python",
  },
};

export function loadServers(): Record<string, ServerSpec> {
  const raw = process.env.CODE_NAV_SERVERS;
  if (!raw) return DEFAULT_SERVERS;
  try {
    const overrides = JSON.parse(raw) as Record<string, Partial<ServerSpec>>;
    const merged: Record<string, ServerSpec> = { ...DEFAULT_SERVERS };
    for (const [name, spec] of Object.entries(overrides)) {
      merged[name] = { ...(merged[name] ?? {}), ...spec } as ServerSpec;
    }
    return merged;
  } catch (err) {
    process.stderr.write(
      `navigator: failed to parse CODE_NAV_SERVERS, using defaults: ${String(err)}\n`,
    );
    return DEFAULT_SERVERS;
  }
}

/** Build an extension -> server-name lookup from a server registry. */
export function buildExtensionIndex(
  servers: Record<string, ServerSpec>,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const [name, spec] of Object.entries(servers)) {
    for (const ext of spec.extensions) index.set(ext, name);
  }
  return index;
}
