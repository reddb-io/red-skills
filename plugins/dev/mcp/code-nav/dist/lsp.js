import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createProtocolConnection, StreamMessageReader, StreamMessageWriter, } from "vscode-languageserver-protocol/node.js";
import { InitializeRequest, InitializedNotification, DidOpenTextDocumentNotification, DefinitionRequest, ReferencesRequest, DocumentSymbolRequest, HoverRequest, WorkspaceSymbolRequest, } from "vscode-languageserver-protocol";
/**
 * A live connection to a single language server, scoped to one workspace root.
 * Lazily spawned on first use; tracks which documents have been opened so each
 * file is announced to the server exactly once before it is queried.
 */
export class LspSession {
    spec;
    rootPath;
    proc;
    conn;
    ready;
    openDocs = new Set();
    constructor(spec, rootPath) {
        this.spec = spec;
        this.rootPath = rootPath;
    }
    async ensureStarted() {
        if (this.ready)
            return this.ready;
        this.ready = this.start();
        return this.ready;
    }
    async start() {
        const proc = spawn(this.spec.command, this.spec.args, {
            cwd: this.rootPath,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc = proc;
        proc.on("error", (err) => {
            process.stderr.write(`code-nav: failed to spawn '${this.spec.command}': ${String(err)}\n`);
        });
        // Surface server logs without polluting the MCP stdio channel.
        proc.stderr.on("data", (chunk) => {
            process.stderr.write(`[${this.spec.command}] ${chunk.toString()}`);
        });
        const conn = createProtocolConnection(new StreamMessageReader(proc.stdout), new StreamMessageWriter(proc.stdin));
        this.conn = conn;
        conn.listen();
        const rootUri = pathToFileURL(this.rootPath).toString();
        const params = {
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
    async ensureOpen(filePath) {
        const abs = resolve(this.rootPath, filePath);
        const uri = pathToFileURL(abs).toString();
        if (this.openDocs.has(uri))
            return uri;
        const text = await readFile(abs, "utf8");
        await this.conn.sendNotification(DidOpenTextDocumentNotification.type, {
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
    async definition(filePath, line, character) {
        await this.ensureStarted();
        const uri = await this.ensureOpen(filePath);
        const result = await this.conn.sendRequest(DefinitionRequest.type, {
            textDocument: { uri },
            position: { line, character },
        });
        return normalizeLocations(result);
    }
    async references(filePath, line, character, includeDeclaration) {
        await this.ensureStarted();
        const uri = await this.ensureOpen(filePath);
        const result = await this.conn.sendRequest(ReferencesRequest.type, {
            textDocument: { uri },
            position: { line, character },
            context: { includeDeclaration },
        });
        return result ?? [];
    }
    async documentSymbols(filePath) {
        await this.ensureStarted();
        const uri = await this.ensureOpen(filePath);
        const result = await this.conn.sendRequest(DocumentSymbolRequest.type, {
            textDocument: { uri },
        });
        return result ?? [];
    }
    async hover(filePath, line, character) {
        await this.ensureStarted();
        const uri = await this.ensureOpen(filePath);
        return this.conn.sendRequest(HoverRequest.type, {
            textDocument: { uri },
            position: { line, character },
        });
    }
    async workspaceSymbols(query) {
        await this.ensureStarted();
        const result = await this.conn.sendRequest(WorkspaceSymbolRequest.type, {
            query,
        });
        return result ?? [];
    }
    dispose() {
        try {
            this.conn?.dispose();
        }
        catch {
            /* ignore */
        }
        this.proc?.kill();
    }
}
/** Definition responses may be a Location, Location[], or LocationLink[]. */
function normalizeLocations(result) {
    if (!result)
        return [];
    const arr = Array.isArray(result) ? result : [result];
    return arr.map((item) => "targetUri" in item
        ? { uri: item.targetUri, range: item.targetSelectionRange }
        : item);
}
/** Convert a file:// URI back to a workspace-relative path for display. */
export function uriToRelative(uri, rootPath) {
    try {
        const abs = fileURLToPath(uri);
        const rel = abs.startsWith(rootPath)
            ? abs.slice(rootPath.length).replace(/^[/\\]/, "")
            : abs;
        return rel || abs;
    }
    catch {
        return uri;
    }
}
