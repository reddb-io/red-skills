/**
 * Language registry: maps file extensions to the language server that should
 * handle them. The defaults below cover servers commonly found on a dev box;
 * override or extend via the CODE_NAV_SERVERS env var (JSON), e.g.:
 *
 *   CODE_NAV_SERVERS='{"go":{"command":"gopls","extensions":[".go"]}}'
 */
const DEFAULT_SERVERS = {
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
export function loadServers() {
    const raw = process.env.CODE_NAV_SERVERS;
    if (!raw)
        return DEFAULT_SERVERS;
    try {
        const overrides = JSON.parse(raw);
        const merged = { ...DEFAULT_SERVERS };
        for (const [name, spec] of Object.entries(overrides)) {
            merged[name] = { ...(merged[name] ?? {}), ...spec };
        }
        return merged;
    }
    catch (err) {
        process.stderr.write(`code-nav: failed to parse CODE_NAV_SERVERS, using defaults: ${String(err)}\n`);
        return DEFAULT_SERVERS;
    }
}
/** Build an extension -> server-name lookup from a server registry. */
export function buildExtensionIndex(servers) {
    const index = new Map();
    for (const [name, spec] of Object.entries(servers)) {
        for (const ext of spec.extensions)
            index.set(ext, name);
    }
    return index;
}
