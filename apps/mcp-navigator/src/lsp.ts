import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type ProtocolConnection,
} from "vscode-languageserver-protocol/node";
import {
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DefinitionRequest,
  ReferencesRequest,
  DocumentSymbolRequest,
  HoverRequest,
  WorkspaceSymbolRequest,
  type InitializeParams,
  type Location,
  type LocationLink,
  type DocumentSymbol,
  type SymbolInformation,
  type Hover,
  type WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import type { ServerSpec } from "./config.js";

/**
 * A live connection to a single language server, scoped to one workspace root.
 * Lazily spawned on first use; tracks which documents have been opened so each
 * file is announced to the server exactly once before it is queried.
 */
export class LspSession {
  private proc?: ChildProcessWithoutNullStreams;
  private conn?: ProtocolConnection;
  private ready?: Promise<void>;
  private readonly openDocs = new Set<string>();

  constructor(
    private readonly spec: ServerSpec,
    private readonly rootPath: string,
  ) {}

  private async ensureStarted(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.start();
    return this.ready;
  }

  private async start(): Promise<void> {
    const proc = spawn(this.spec.command, this.spec.args, {
      cwd: this.rootPath,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.proc = proc;

    // Wait until the process is actually running before we write to its stdin.
    // A missing binary emits 'error' (ENOENT); rejecting here lets callers
    // (e.g. workspace_symbols fanning out to every server) skip it cleanly
    // instead of crashing on a write to a destroyed stream.
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      proc.once("spawn", () => resolveSpawn());
      proc.once("error", (err) =>
        rejectSpawn(
          new Error(`failed to spawn '${this.spec.command}': ${err.message}`),
        ),
      );
    });

    // Surface server logs without polluting the MCP stdio channel.
    proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[${this.spec.command}] ${chunk.toString()}`);
    });
    proc.once("exit", () => {
      try {
        this.conn?.dispose();
      } catch {
        /* ignore */
      }
    });

    const conn = createProtocolConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    );
    this.conn = conn;
    conn.listen();

    const rootUri = pathToFileURL(this.rootPath).toString();
    const params: InitializeParams = {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: "workspace" }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
        },
        workspace: { symbol: {} },
      },
    };

    await conn.sendRequest(InitializeRequest.type, params);
    await conn.sendNotification(InitializedNotification.type, {});
  }

  /** Ensure a file's contents have been announced to the server via didOpen. */
  private async ensureOpen(filePath: string): Promise<string> {
    const abs = resolve(this.rootPath, filePath);
    const uri = pathToFileURL(abs).toString();
    if (this.openDocs.has(uri)) return uri;

    const text = await readFile(abs, "utf8");
    await this.conn!.sendNotification(DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri,
        languageId: this.spec.languageId,
        version: 1,
        text,
      },
    });
    this.openDocs.add(uri);
    return uri;
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Location[]> {
    await this.ensureStarted();
    const uri = await this.ensureOpen(filePath);
    const result = await this.conn!.sendRequest(DefinitionRequest.type, {
      textDocument: { uri },
      position: { line, character },
    });
    return normalizeLocations(result);
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration: boolean,
  ): Promise<Location[]> {
    await this.ensureStarted();
    const uri = await this.ensureOpen(filePath);
    const result = await this.conn!.sendRequest(ReferencesRequest.type, {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration },
    });
    return result ?? [];
  }

  async documentSymbols(
    filePath: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[]> {
    await this.ensureStarted();
    const uri = await this.ensureOpen(filePath);
    const result = await this.conn!.sendRequest(DocumentSymbolRequest.type, {
      textDocument: { uri },
    });
    return result ?? [];
  }

  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Hover | null> {
    await this.ensureStarted();
    const uri = await this.ensureOpen(filePath);
    return this.conn!.sendRequest(HoverRequest.type, {
      textDocument: { uri },
      position: { line, character },
    });
  }

  async workspaceSymbols(
    query: string,
  ): Promise<(SymbolInformation | WorkspaceSymbol)[]> {
    await this.ensureStarted();
    const result = await this.conn!.sendRequest(WorkspaceSymbolRequest.type, {
      query,
    });
    return result ?? [];
  }

  dispose(): void {
    try {
      this.conn?.dispose();
    } catch {
      /* ignore */
    }
    this.proc?.kill();
  }
}

/** Definition responses may be a Location, Location[], or LocationLink[]. */
function normalizeLocations(
  result: Location | Location[] | LocationLink[] | null,
): Location[] {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((item) =>
    "targetUri" in item
      ? { uri: item.targetUri, range: item.targetSelectionRange }
      : item,
  );
}

/** Convert a file:// URI back to a workspace-relative path for display. */
export function uriToRelative(uri: string, rootPath: string): string {
  try {
    const abs = fileURLToPath(uri);
    const rel = abs.startsWith(rootPath)
      ? abs.slice(rootPath.length).replace(/^[/\\]/, "")
      : abs;
    return rel || abs;
  } catch {
    return uri;
  }
}
