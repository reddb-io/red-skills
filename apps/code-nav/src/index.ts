#!/usr/bin/env node
/**
 * code-nav — LSP-backed code navigation exposed as an MCP server.
 *
 * Arguments are routed and parsed by the shared contract (ADR 0114); the
 * accepted surface is declared in `cli-args.ts`. Nothing here reads the
 * language-server registry or spawns a session until `serve` actually runs, so
 * `--version` and `--help` answer on a box where no language server exists.
 *
 * Exit codes:
 *   0  — served until the transport closed, or printed the version/help.
 *   1  — fatal error while serving.
 *   2  — usage error.
 */
import { extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import {
  CodeNavUsageError,
  isVersionRequest,
  parseCodeNavArgs,
  renderHelp,
} from "./cli-args.js";
import {
  loadServers,
  buildExtensionIndex,
  type ServerSpec,
} from "./config.js";
import { LspSession, uriToRelative } from "./lsp.js";
import { resolveWorkspaceRoot } from "./workspace-root.js";

const posShape = {
  file: z.string().describe("Workspace-relative path to the source file."),
  line: z.number().int().describe("Zero-based line number."),
  character: z.number().int().describe("Zero-based character offset on the line."),
};

interface Navigator {
  server: McpServer;
  root: string;
  /** Where the root came from; `cwd` means nothing announced a project. */
  rootSource: string;
  /** Set when the root fell back to a plugin installation directory. */
  rootWarning?: string;
  languages: string[];
  dispose: () => void;
}

/**
 * Build the navigator: read the language registry, register the MCP tools, and
 * hand back a disposer for the sessions they open. Called only on the `serve`
 * path — the registry is the first thing a version answer must not depend on.
 */
function createNavigator(): Navigator {
  // The opened project, not the plugin the launcher happens to live in.
  const resolution = resolveWorkspaceRoot();
  const root = resolution.root;
  const servers = loadServers();
  const extIndex = buildExtensionIndex(servers);

  // One language-server session per language, reused across requests.
  const sessions = new Map<string, LspSession>();

  function sessionForFile(filePath: string): LspSession {
    const ext = extname(filePath);
    const name = extIndex.get(ext);
    if (!name) {
      throw new Error(
        `no language server configured for '${ext}'. ` +
          `Configured extensions: ${[...extIndex.keys()].join(", ") || "(none)"}.`,
      );
    }
    let session = sessions.get(name);
    if (!session) {
      session = new LspSession(servers[name] as ServerSpec, root);
      sessions.set(name, session);
    }
    return session;
  }

  // workspace/symbol is not file-scoped; query every distinct configured server.
  function allSessions(): LspSession[] {
    for (const name of Object.keys(servers)) {
      if (!sessions.has(name)) {
        sessions.set(name, new LspSession(servers[name] as ServerSpec, root));
      }
    }
    return [...sessions.values()];
  }

  function loc(uri: string, range: { start: { line: number; character: number } }) {
    return `${uriToRelative(uri, root)}:${range.start.line + 1}:${
      range.start.character + 1
    }`;
  }

  const buildInfo = readBuildInfo("navigator");
  const server = new McpServer({ name: "navigator", version: buildInfo.version });

  server.registerTool(
    "goto_definition",
    {
      title: "Go to definition",
      description:
        "Resolve the symbol at a file position to its definition(s). Returns " +
        "file:line:column locations. Use this instead of grepping for a name.",
      inputSchema: posShape,
    },
    async ({ file, line, character }) => {
      const locs = await sessionForFile(file).definition(file, line, character);
      if (locs.length === 0) return text("No definition found.");
      return text(locs.map((l) => loc(l.uri, l.range)).join("\n"));
    },
  );

  server.registerTool(
    "find_references",
    {
      title: "Find references",
      description:
        "Find every reference to the symbol at a file position across the " +
        "workspace. Semantic — matches the actual symbol, not text.",
      inputSchema: {
        ...posShape,
        includeDeclaration: z
          .boolean()
          .optional()
          .describe("Include the declaration itself (default true)."),
      },
    },
    async ({ file, line, character, includeDeclaration }) => {
      const locs = await sessionForFile(file).references(
        file,
        line,
        character,
        includeDeclaration ?? true,
      );
      if (locs.length === 0) return text("No references found.");
      return text(
        `${locs.length} reference(s):\n` +
          locs.map((l) => loc(l.uri, l.range)).join("\n"),
      );
    },
  );

  server.registerTool(
    "document_symbols",
    {
      title: "Document symbols",
      description:
        "List the symbols (functions, types, methods, …) defined in a file, " +
        "with their positions. A semantic outline of the file.",
      inputSchema: { file: posShape.file },
    },
    async ({ file }) => {
      const syms = await sessionForFile(file).documentSymbols(file);
      if (syms.length === 0) return text("No symbols found.");
      return text(renderSymbols(syms));
    },
  );

  server.registerTool(
    "hover",
    {
      title: "Hover (type / docs)",
      description:
        "Get the type signature and documentation for the symbol at a file " +
        "position, as the IDE hover card would show.",
      inputSchema: posShape,
    },
    async ({ file, line, character }) => {
      const h = await sessionForFile(file).hover(file, line, character);
      if (!h || !h.contents) return text("No hover information.");
      const c = h.contents;
      const body =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c.map((x) => (typeof x === "string" ? x : x.value)).join("\n")
            : c.value;
      return text(body);
    },
  );

  server.registerTool(
    "workspace_symbols",
    {
      title: "Search symbols by name",
      description:
        "Find symbols by name across the whole workspace. Start here when you " +
        "know a name but not where it lives, then use goto_definition / " +
        "find_references from the returned position.",
      inputSchema: {
        query: z.string().describe("Symbol name or fragment to search for."),
      },
    },
    async ({ query }) => {
      const results = await Promise.all(
        allSessions().map((s) =>
          s.workspaceSymbols(query).catch(() => []),
        ),
      );
      const flat = results.flat();
      if (flat.length === 0) return text(`No symbols matching '${query}'.`);
      const lines = flat.slice(0, 100).map((s) => {
        const l = (s as { location?: { uri: string; range?: any } }).location;
        const where = l?.range ? loc(l.uri, l.range) : uriToRelative(l?.uri ?? "", root);
        return `${s.name}\t${where}`;
      });
      return text(lines.join("\n"));
    },
  );

  return {
    server,
    root,
    rootSource: resolution.source,
    ...(resolution.warning === undefined ? {} : { rootWarning: resolution.warning }),
    languages: Object.keys(servers),
    dispose: () => {
      for (const s of sessions.values()) s.dispose();
    },
  };
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function renderSymbols(syms: any[], depth = 0): string {
  const pad = "  ".repeat(depth);
  return syms
    .map((s) => {
      const range = s.selectionRange ?? s.range ?? s.location?.range;
      const pos = range ? `:${range.start.line + 1}` : "";
      const line = `${pad}${s.name}${pos}`;
      const children = s.children?.length
        ? "\n" + renderSymbols(s.children, depth + 1)
        : "";
      return line + children;
    })
    .join("\n");
}

/** Print the build version — the answer this binary owes before anything else. */
function writeVersion(asJson: boolean): void {
  const info = readBuildInfo("navigator");
  process.stdout.write(asJson ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
}

async function serve(): Promise<void> {
  const navigator = createNavigator();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      navigator.dispose();
      process.exit(0);
    });
  }
  const transport = new StdioServerTransport();
  await navigator.server.connect(transport);
  if (navigator.rootWarning !== undefined) {
    process.stderr.write(`navigator: ${navigator.rootWarning}\n`);
  }
  process.stderr.write(
    `navigator MCP ready (root=${navigator.root}, root-source=${navigator.rootSource}, languages=${navigator.languages.join(",")})\n`,
  );
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  // Answered before the language registry, a session, or the stdio transport:
  // "which build is this?" must stay answerable in exactly the situation you
  // need to ask it — a box with no language server, an unparseable override.
  if (isVersionRequest(argv)) {
    writeVersion(argv.includes("--json"));
    return;
  }

  let args;
  try {
    args = parseCodeNavArgs(argv);
  } catch (err) {
    if (err instanceof CodeNavUsageError) {
      process.stderr.write(`code-nav: ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  if (args.showVersion) {
    writeVersion(args.versionJson);
    return;
  }
  if (args.showHelp) {
    process.stdout.write(renderHelp());
    return;
  }

  await serve();
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`navigator fatal: ${String(err)}\n`);
  process.exit(1);
});
