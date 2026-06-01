#!/usr/bin/env node
import { extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import {
  loadServers,
  buildExtensionIndex,
  type ServerSpec,
} from "./config.js";
import { LspSession, uriToRelative } from "./lsp.js";

const ROOT = process.env.CODE_NAV_ROOT ?? process.cwd();
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
    session = new LspSession(servers[name] as ServerSpec, ROOT);
    sessions.set(name, session);
  }
  return session;
}

// workspace/symbol is not file-scoped; query every distinct configured server.
function allSessions(): LspSession[] {
  for (const name of Object.keys(servers)) {
    if (!sessions.has(name)) {
      sessions.set(name, new LspSession(servers[name] as ServerSpec, ROOT));
    }
  }
  return [...sessions.values()];
}

function loc(uri: string, range: { start: { line: number; character: number } }) {
  return `${uriToRelative(uri, ROOT)}:${range.start.line + 1}:${
    range.start.character + 1
  }`;
}

const buildInfo = readBuildInfo("code-nav");
const server = new McpServer({ name: "code-nav", version: buildInfo.version });

const posShape = {
  file: z.string().describe("Workspace-relative path to the source file."),
  line: z.number().int().describe("Zero-based line number."),
  character: z.number().int().describe("Zero-based character offset on the line."),
};

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
      const where = l?.range ? loc(l.uri, l.range) : uriToRelative(l?.uri ?? "", ROOT);
      return `${s.name}\t${where}`;
    });
    return text(lines.join("\n"));
  },
);

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `code-nav MCP ready (root=${ROOT}, languages=${Object.keys(servers).join(",")})\n`,
  );
}

if (process.argv[2] === "--version" || process.argv[2] === "-v" || process.argv[2] === "version") {
  process.stdout.write(process.argv.includes("--json") ? `${JSON.stringify(buildInfo)}\n` : `${renderVersion(buildInfo)}\n`);
} else {
  main().catch((err) => {
    process.stderr.write(`code-nav fatal: ${String(err)}\n`);
    process.exit(1);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    for (const s of sessions.values()) s.dispose();
    process.exit(0);
  });
}
