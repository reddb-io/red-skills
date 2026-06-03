#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli.ts
import { readFile as readFile2 } from "node:fs/promises";

// src/hook-runtime.ts
import { mkdir as mkdir2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/config.ts
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
var DEFAULT_CONNECTION_STRING = "file://./.red/brain/brain.rdb";
async function findBrainRoot(startDir = process.cwd()) {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".red"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}
function brainConfigPath(rootDir) {
  return join(resolve(rootDir), ".red", "brain", "config.yaml");
}
function rootEnvPath(rootDir) {
  return join(resolve(rootDir), ".env");
}
async function ensureBrainConfig(rootDir) {
  const path = brainConfigPath(rootDir);
  if (existsSync(path)) return path;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `connection_string: ${DEFAULT_CONNECTION_STRING}
`, "utf8");
  return path;
}
async function readBrainConfig(rootDir) {
  const path = brainConfigPath(rootDir);
  try {
    const text = await readFile(path, "utf8");
    return parseBrainConfig(text);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}
function parseBrainConfig(text) {
  const line = text.split(/\r?\n/).map((candidate) => candidate.trim()).find((candidate) => candidate.startsWith("connection_string:"));
  if (!line) return { connection_string: DEFAULT_CONNECTION_STRING };
  const raw = line.slice("connection_string:".length).trim();
  return { connection_string: unquote(raw) || DEFAULT_CONNECTION_STRING };
}
function unquote(value) {
  if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}
async function resolveBrainConfig(startDir = process.cwd()) {
  const rootDir = await findBrainRoot(startDir);
  const configPath = await ensureBrainConfig(rootDir);
  const config = await readBrainConfig(rootDir) ?? {
    connection_string: DEFAULT_CONNECTION_STRING
  };
  const env = await readRootEnv(rootDir);
  const rawConnectionString = config.connection_string;
  const interpolated = interpolateEnv(rawConnectionString, env);
  return {
    rootDir,
    configPath,
    rawConnectionString,
    connectionString: resolveConnectionString(rootDir, interpolated)
  };
}
async function readRootEnv(rootDir) {
  const out = { ...process.env };
  try {
    const text = await readFile(rootEnvPath(rootDir), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = unquote(trimmed.slice(idx + 1).trim());
      if (out[key] == null) out[key] = value;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return out;
}
function interpolateEnv(value, env) {
  return value.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_match, bare, braced) => {
    const name = String(bare ?? braced);
    const resolved = env[name];
    if (resolved == null || resolved === "") {
      throw new Error(`Brain connection_string references missing environment variable ${name}`);
    }
    return resolved;
  });
}
function resolveConnectionString(rootDir, connectionString) {
  if (!connectionString.startsWith("file://")) return connectionString;
  const path = connectionString.slice("file://".length);
  if (isAbsolute(path)) return connectionString;
  return `file://${resolve(rootDir, path)}`;
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/spawn.js
var isBun = typeof globalThis.Bun !== "undefined" && typeof globalThis.Bun.spawn === "function";
var isDeno = typeof globalThis.Deno !== "undefined" && typeof globalThis.Deno.Command === "function";
async function spawnRed(binary, args) {
  if (isBun) return spawnBun(binary, args);
  if (isDeno) return spawnDeno(binary, args);
  return spawnNode(binary, args);
}
async function spawnNode(binary, args) {
  const { spawn } = await import("node:child_process");
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
  return {
    runtime: "node",
    stdin: {
      write(buf) {
        return new Promise((resolve3, reject) => {
          child.stdin.write(buf, (err) => err ? reject(err) : resolve3());
        });
      },
      end() {
        child.stdin.end();
      }
    },
    stdout: child.stdout,
    // already AsyncIterable<Buffer>
    kill() {
      child.kill("SIGTERM");
    },
    wait() {
      return new Promise((resolve3) => {
        child.on("exit", (code) => resolve3(code ?? 0));
      });
    }
  };
}
function spawnBun(binary, args) {
  const child = globalThis.Bun.spawn({
    cmd: [binary, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit"
  });
  const writer = child.stdin.getWriter ? child.stdin.getWriter() : null;
  return {
    runtime: "bun",
    stdin: {
      async write(buf) {
        if (writer) {
          await writer.write(buf);
        } else {
          child.stdin.write(buf);
          await child.stdin.flush();
        }
      },
      end() {
        if (writer) {
          writer.close();
        } else {
          child.stdin.end();
        }
      }
    },
    stdout: bunStdoutToAsyncIterable(child.stdout),
    kill() {
      child.kill();
    },
    wait() {
      return child.exited;
    }
  };
}
async function* bunStdoutToAsyncIterable(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
async function spawnDeno(binary, args) {
  const cmd = new globalThis.Deno.Command(binary, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit"
  });
  const child = cmd.spawn();
  const writer = child.stdin.getWriter();
  return {
    runtime: "deno",
    stdin: {
      async write(buf) {
        await writer.write(buf);
      },
      end() {
        try {
          writer.close();
        } catch {
        }
      }
    },
    stdout: denoStdoutToAsyncIterable(child.stdout),
    kill() {
      try {
        child.kill("SIGTERM");
      } catch {
      }
    },
    async wait() {
      const status = await child.status;
      return status.code ?? 0;
    }
  };
}
async function* denoStdoutToAsyncIterable(stream) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/binary.js
import { fileURLToPath } from "node:url";
import { dirname as dirname2, resolve as resolve2, join as join3 } from "node:path";

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/internal/bin-resolver/index.js
import { existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
function resolveBin(opts) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("resolveBin: options object required");
  }
  const { name, packageRoot, envVar } = opts;
  if (typeof name !== "string" || name === "") {
    throw new TypeError("resolveBin: `name` must be a non-empty string");
  }
  if (typeof packageRoot !== "string" || packageRoot === "") {
    throw new TypeError("resolveBin: `packageRoot` must be a non-empty string");
  }
  if (typeof envVar !== "string" || envVar === "") {
    throw new TypeError("resolveBin: `envVar` must be a non-empty string");
  }
  const override = process.env?.[envVar];
  if (typeof override === "string" && override !== "") {
    return override;
  }
  const local = join2(packageRoot, "bin", name);
  if (existsSync2(local)) {
    return local;
  }
  throw new Error(
    `reddb: binary "${name}" not found.
  expected at: ${local}
  override:    set ${envVar}=/path/to/${name}
  fix:         re-run \`pnpm install\` (the postinstall script downloads it),
               or check the postinstall log for a download error.`
  );
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/binary.js
var HERE = dirname2(fileURLToPath(import.meta.url));
var PACKAGE_ROOT = resolve2(HERE, "..");
function defaultBinaryName() {
  if (typeof process !== "undefined" && process.platform === "win32") {
    return "red.exe";
  }
  return "red";
}
function resolveSdkBinary() {
  const legacy = process.env?.REDDB_BINARY_PATH;
  if (typeof legacy === "string" && legacy !== "" && !process.env?.REDDB_BIN) {
    return legacy;
  }
  return resolveBin({
    name: defaultBinaryName(),
    packageRoot: PACKAGE_ROOT,
    envVar: "REDDB_BIN"
  });
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/protocol.js
var NEWLINE = 10;
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8");
var RedDBError = class extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RedDBError";
    this.code = code;
    this.data = data ?? null;
  }
};
var RpcClient = class {
  /** @param {import('./spawn.js').RedProcess} child */
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = /* @__PURE__ */ new Map();
    this.closed = false;
    this.closeReason = null;
    this.readerPromise = this.#readLoop();
  }
  /**
   * Send a JSON-RPC 2.0 request and resolve with the result, or reject
   * with a `RedDBError` if the server returned an error envelope.
   */
  call(method, params = {}) {
    if (this.closed) {
      return Promise.reject(
        new RedDBError("CLIENT_CLOSED", `client is closed: ${this.closeReason ?? "unknown"}`)
      );
    }
    const id = this.nextId++;
    const envelope = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve3, reject) => {
      this.pending.set(id, { resolve: resolve3, reject });
      this.child.stdin.write(encoder.encode(envelope + "\n")).catch((err) => {
        this.pending.delete(id);
        reject(err);
      });
    });
  }
  /** Drain pending requests, send `close`, wait for the binary to exit. */
  async close() {
    if (this.closed) return;
    try {
      await this.call("close", {});
    } catch {
    }
    this.#shutdown("close requested");
    try {
      this.child.stdin.end();
    } catch {
    }
    await this.child.wait();
  }
  // -------------------------------------------------------------------------
  // Internal: stdout reader loop
  // -------------------------------------------------------------------------
  async #readLoop() {
    let buffer = new Uint8Array(0);
    try {
      for await (const chunk of this.child.stdout) {
        const merged = new Uint8Array(buffer.length + chunk.length);
        merged.set(buffer, 0);
        merged.set(chunk, buffer.length);
        buffer = merged;
        let start = 0;
        for (let i = 0; i < buffer.length; i++) {
          if (buffer[i] === NEWLINE) {
            const lineBytes = buffer.subarray(start, i);
            this.#dispatchLine(decoder.decode(lineBytes));
            start = i + 1;
          }
        }
        if (start > 0) {
          buffer = buffer.subarray(start);
        }
      }
    } catch (err) {
      this.#shutdown(`stdout reader error: ${err.message}`);
      return;
    }
    this.#shutdown("server stdout closed");
  }
  #dispatchLine(line) {
    if (!line.trim()) return;
    let envelope;
    try {
      envelope = JSON.parse(line);
    } catch (err) {
      this.#shutdown(`malformed server response: ${err.message}`);
      return;
    }
    const id = envelope.id;
    if (id === null || id === void 0) {
      return;
    }
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (envelope.error) {
      pending.reject(
        new RedDBError(
          envelope.error.code ?? "UNKNOWN",
          envelope.error.message ?? "unknown error",
          envelope.error.data
        )
      );
    } else {
      pending.resolve(envelope.result);
    }
  }
  #shutdown(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const err = new RedDBError("CLIENT_CLOSED", reason);
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
  }
};

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/url.js
function parseUri(uri) {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new TypeError(
      "connect() requires a URI string (e.g. 'red://localhost:5050' or 'red:///data.rdb')"
    );
  }
  if (uri.startsWith("red://") || uri === "red:" || uri === "red:/") {
    return parseRedUrl(uri);
  }
  return parseLegacyUrl(uri);
}
function parseRedUrl(uri) {
  let normalised = uri;
  if (uri === "red:" || uri === "red:/" || uri === "red://") {
    normalised = "red://embedded.local";
  } else if (uri.startsWith("red:///")) {
    normalised = `red://embedded.local${uri.slice("red://".length)}`;
  } else if (uri === "red://memory" || uri === "red://memory/" || uri === "red://:memory" || uri === "red://:memory:") {
    normalised = "red://embedded.local";
  }
  let parsed;
  try {
    parsed = new URL(normalised);
  } catch (err) {
    throw new RedDBError("UNPARSEABLE_URI", `failed to parse '${uri}': ${err.message}`);
  }
  const params = parsed.searchParams;
  const proto = (params.get("proto") || "").toLowerCase();
  const path = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "";
  if (parsed.hostname === "embedded.local") {
    if (path) {
      return {
        kind: "embedded",
        path,
        params,
        originalUri: uri
      };
    }
    return {
      kind: "embedded",
      params,
      originalUri: uri
    };
  }
  const kind = resolveKind(proto);
  const port = parsed.port ? Number(parsed.port) : defaultPortFor(kind);
  const username = parsed.username ? decodeURIComponent(parsed.username) : void 0;
  const password = parsed.password ? decodeURIComponent(parsed.password) : void 0;
  return {
    kind,
    host: parsed.hostname,
    port,
    path: path || void 0,
    username,
    password,
    token: params.get("token") ?? void 0,
    apiKey: params.get("apiKey") ?? params.get("api_key") ?? void 0,
    loginUrl: params.get("loginUrl") ?? params.get("login_url") ?? void 0,
    params,
    originalUri: uri
  };
}
function parseLegacyUrl(uri) {
  if (uri === "memory://" || uri === "memory:") {
    return { kind: "embedded", originalUri: uri };
  }
  if (uri.startsWith("file://")) {
    const path = uri.slice("file://".length);
    if (!path) {
      throw new TypeError(`invalid file:// URI: missing path in '${uri}'`);
    }
    return { kind: "embedded", path, originalUri: uri };
  }
  if (uri.startsWith("grpc://") || uri.startsWith("grpcs://") || uri.startsWith("reds://")) {
    const scheme = uri.split("://", 1)[0];
    const stripped = uri.slice(`${scheme}://`.length);
    const [hostPort] = stripped.split(/[/?]/, 1);
    const [host, portStr] = hostPort.split(":");
    if (!host) {
      throw new TypeError(`invalid ${scheme}:// URI: missing host in '${uri}'`);
    }
    const legacyKind = scheme === "reds" ? "reds" : scheme === "grpcs" ? "grpcs" : scheme === "grpc" ? "grpc" : "red";
    return {
      kind: legacyKind,
      host,
      port: portStr ? Number(portStr) : defaultPortFor(legacyKind),
      originalUri: uri
    };
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch (err) {
      throw new RedDBError("UNPARSEABLE_URI", `failed to parse '${uri}': ${err.message}`);
    }
    return {
      kind: parsed.protocol === "https:" ? "https" : "http",
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : defaultPortFor(parsed.protocol === "https:" ? "https" : "http"),
      path: parsed.pathname !== "/" ? parsed.pathname : void 0,
      username: parsed.username ? decodeURIComponent(parsed.username) : void 0,
      password: parsed.password ? decodeURIComponent(parsed.password) : void 0,
      token: parsed.searchParams.get("token") ?? void 0,
      apiKey: parsed.searchParams.get("apiKey") ?? void 0,
      params: parsed.searchParams,
      originalUri: uri
    };
  }
  throw new RedDBError(
    "UNSUPPORTED_SCHEME",
    `unsupported URI: '${uri}'. Use 'red://...' or one of memory://, file://, grpc://, http(s)://`
  );
}
function resolveKind(protoQueryParam) {
  switch (protoQueryParam) {
    case "":
    case "red":
      return "red";
    case "reds":
      return "reds";
    case "grpc":
      return "grpc";
    case "grpcs":
      return "grpcs";
    case "http":
      return "http";
    case "https":
      return "https";
    case "pg":
    case "postgres":
    case "postgresql":
      return "pg";
    default:
      throw new RedDBError(
        "UNSUPPORTED_PROTO",
        `unknown proto='${protoQueryParam}'. Supported: red | reds | grpc | grpcs | http | https | pg`
      );
  }
}
function defaultPortFor(kind) {
  switch (kind) {
    case "http":
      return 8080;
    case "https":
      return 8443;
    case "red":
    case "reds":
    case "redwire":
      return 5050;
    case "grpc":
      return 5055;
    case "grpcs":
      return 5056;
    case "pg":
    case "postgres":
    case "postgresql":
      return 5432;
    default:
      return void 0;
  }
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/cache.js
var UNSUPPORTED_TRANSPORTS = /* @__PURE__ */ new Set(["embedded"]);
var CacheClient = class {
  /**
   * @param {{ call: Function }} client
   * @param {string} [transport] Underlying transport label (e.g. 'http',
   *   'grpc', 'embedded'). When the transport doesn't serve `cache.*`,
   *   every method throws `UNSUPPORTED_TRANSPORT` before any RPC call.
   */
  constructor(client, transport) {
    this._client = client;
    this._transport = transport ?? null;
  }
  _guard(method) {
    if (this._transport && UNSUPPORTED_TRANSPORTS.has(this._transport)) {
      throw new RedDBError(
        "UNSUPPORTED_TRANSPORT",
        `cache.${method} is not available on '${this._transport}' transport; use @reddb-io/client for remote cache endpoints.`
      );
    }
  }
  /**
   * Fetch a cached value. Returns a Uint8Array on hit, null on miss.
   * @param {string} namespace
   * @param {string} key
   * @returns {Promise<Uint8Array | null>}
   */
  async get(namespace, key) {
    this._guard("get");
    const result = await this._client.call("cache.get", { namespace, key });
    if (result == null || result.value == null) return null;
    return base64ToBytes(result.value);
  }
  /**
   * Store a value in the cache.
   * @param {string} namespace
   * @param {string} key
   * @param {Uint8Array | Buffer | string} value  String is UTF-8 encoded.
   * @param {object} [opts]
   * @param {number} [opts.ttl_ms]
   * @param {string[]} [opts.tags]
   * @param {object} [opts.policy]
   * @returns {Promise<void>}
   */
  async put(namespace, key, value, opts = {}) {
    this._guard("put");
    const encoded = bytesToBase64(value);
    await this._client.call("cache.put", {
      namespace,
      key,
      value: encoded,
      ...opts
    });
  }
  /**
   * Check whether a key is present.
   * @param {string} namespace
   * @param {string} key
   * @returns {Promise<'present' | 'absent' | 'maybe'>}
   */
  async exists(namespace, key) {
    this._guard("exists");
    const result = await this._client.call("cache.exists", { namespace, key });
    return result?.status ?? "maybe";
  }
  /**
   * Remove a single entry.
   * @param {string} namespace
   * @param {string} key
   * @returns {Promise<void>}
   */
  async invalidate(namespace, key) {
    this._guard("invalidate");
    await this._client.call("cache.invalidate", { namespace, key });
  }
  /**
   * Remove all entries whose key starts with `prefix`.
   * @param {string} namespace
   * @param {string} prefix
   * @returns {Promise<number>} Number of entries removed.
   */
  async invalidatePrefix(namespace, prefix) {
    this._guard("invalidatePrefix");
    const result = await this._client.call("cache.invalidate_prefix", { namespace, prefix });
    return result?.removed ?? 0;
  }
  /**
   * Remove all entries tagged with any of the given tags.
   * @param {string} namespace
   * @param {string[]} tags
   * @returns {Promise<number>} Number of entries removed.
   */
  async invalidateTags(namespace, tags) {
    this._guard("invalidateTags");
    const result = await this._client.call("cache.invalidate_tags", { namespace, tags });
    return result?.removed ?? 0;
  }
  /**
   * Remove all entries in a namespace.
   * Routes to POST /admin/blob_cache/flush_namespace (live endpoint).
   * @param {string} namespace
   * @returns {Promise<void>}
   */
  async flushNamespace(namespace) {
    this._guard("flushNamespace");
    await this._client.call("cache.flush_namespace", { namespace });
  }
};
function bytesToBase64(value) {
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return bufToBase64(bytes);
  }
  if (value instanceof Uint8Array || typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return bufToBase64(value);
  }
  throw new TypeError("cache value must be a string, Uint8Array, or Buffer");
}
function bufToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function base64ToBytes(b64) {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/kv.js
var KvClient = class {
  constructor(client, collection = "kv_default") {
    this.client = client;
    this.collection = collection;
  }
  put(key, value, options = {}) {
    const collection = options.collection ?? this.collection;
    const tags = Array.isArray(options.tags) && options.tags.length > 0 ? ` TAGS [${options.tags.map(kvTagLiteral).join(", ")}]` : "";
    const expire = options.expireMs != null ? ` EXPIRE ${Number(options.expireMs)} ms` : "";
    return this.client.call("query", {
      sql: `KV PUT ${kvPath(collection, key)} = ${kvValueLiteral(value)}${expire}${tags}`
    });
  }
  // Spec-canonical alias for `put` (SDK Helper Spec §5.1 `kv.set`).
  set(key, value, options = {}) {
    return this.put(key, value, options);
  }
  async get(key, options = {}) {
    const collection = options.collection ?? this.collection;
    const result = await this.client.call("query", {
      sql: `KV GET ${kvPath(collection, key)}`
    });
    return result?.rows?.[0]?.value ?? null;
  }
  async getMany(keys, options = {}) {
    const values = [];
    for (const key of keys) values.push(await this.get(key, options));
    return values;
  }
  async exists(key, options = {}) {
    return { exists: await this.get(key, options) !== null };
  }
  async delete(key, options = {}) {
    const collection = options.collection ?? this.collection;
    const result = await this.client.call("query", {
      sql: `KV DELETE ${kvPath(collection, key)}`
    });
    const affected = result.affected ?? result.affected_rows ?? 0;
    return { affected, deleted: affected > 0 };
  }
  async list(options = {}) {
    const collection = options.collection ?? this.collection;
    const limit = options.limit == null ? 100 : Number(options.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RedDBError("INVALID_ARGUMENT", "kv.list limit must be a positive integer");
    }
    const prefix = options.prefix == null ? "" : String(options.prefix);
    const result = await this.client.call("query", {
      sql: `SELECT key, value FROM ${kvIdentifier(collection)} ORDER BY key ASC LIMIT ${limit}`
    });
    const rows = result.rows ?? [];
    const items = prefix.length > 0 ? rows.filter((row) => String(row.key).startsWith(prefix)) : rows;
    return { items };
  }
  async invalidateTags(tags, options = {}) {
    const collection = options.collection ?? this.collection;
    const result = await this.client.call("query", {
      sql: `INVALIDATE TAGS [${tags.map(kvTagLiteral).join(", ")}] FROM ${kvIdentifier(collection)}`
    });
    return result.affected ?? result.affected_rows ?? result.rows?.[0]?.invalidated ?? 0;
  }
  async *watch(key, options = {}) {
    if (!this.client.baseUrl) {
      throw new RedDBError("UNSUPPORTED_TRANSPORT", "kv.watch requires the HTTP transport");
    }
    const collection = options.collection ?? this.collection;
    const params = new URLSearchParams();
    if (options.sinceLsn != null) params.set("since_lsn", String(options.sinceLsn));
    if (options.limit != null) params.set("limit", String(options.limit));
    const suffix = params.toString() ? `?${params}` : "";
    const url = `${this.client.baseUrl}/collections/${encodeURIComponent(collection)}/kv/${encodeURIComponent(String(key))}/watch${suffix}`;
    const response = await fetch(url, this.client.attachAuth({ method: "GET" }));
    if (!response.ok) {
      throw new RedDBError("HTTP_ERROR", `kv.watch failed with HTTP ${response.status}`);
    }
    const text = await response.text();
    for (const block of text.split("\n\n")) {
      const line = block.split("\n").find((entry) => entry.startsWith("data: "));
      if (line) yield JSON.parse(line.slice(6));
    }
  }
  watchPrefix(prefix, options = {}) {
    return this.watch(`${prefix}.*`, options);
  }
};
function kvPath(collection, key) {
  return `${kvIdentifier(collection)}.${kvKeySegment(key)}`;
}
function kvIdentifier(value) {
  const ident = String(value);
  const invalid = ident.match(/[^A-Za-z0-9_]/);
  if (invalid) {
    throw new RedDBError(
      "INVALID_KV_KEY",
      `invalid KV key "${ident}": character "${invalid[0]}" is not supported`
    );
  }
  return ident;
}
function kvKeySegment(value) {
  const key = String(value);
  if (/^[A-Za-z0-9_]+$/.test(key)) return key;
  return `'${key.replace(/'/g, "''")}'`;
}
function kvValueLiteral(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "NULL";
  if (typeof value === "object") return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  return `'${String(value).replace(/'/g, "''")}'`;
}
function kvTagLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/queue.js
var QueueClient = class {
  constructor(client) {
    this.client = client;
  }
  // Spec §6.1 `queues.create`: idempotent (CREATE QUEUE IF NOT EXISTS) so
  // conformance fixtures can prime a queue the same way the Rust/Go harnesses do.
  create(queue) {
    return this.client.call("query", {
      sql: `CREATE QUEUE IF NOT EXISTS ${queueIdentifier(queue)}`
    });
  }
  push(queue, value, options = {}) {
    const priority = options.priority != null ? ` PRIORITY ${queuePriority(options.priority)}` : "";
    return this.client.call("query", {
      sql: `QUEUE PUSH ${queueIdentifier(queue)} ${queueValueLiteral(value)}${priority}`
    });
  }
  async pop(queue, count) {
    const result = await this.client.call("query", {
      sql: `QUEUE POP ${queueIdentifier(queue)}${queueCount(count)}`
    });
    return queuePayloads(result);
  }
  async peek(queue, count) {
    const result = await this.client.call("query", {
      sql: `QUEUE PEEK ${queueIdentifier(queue)}${queueCount(count)}`
    });
    return queuePayloads(result);
  }
  async len(queue) {
    const result = await this.client.call("query", {
      sql: `QUEUE LEN ${queueIdentifier(queue)}`
    });
    return Number(result?.rows?.[0]?.len ?? 0);
  }
  purge(queue) {
    return this.client.call("query", {
      sql: `QUEUE PURGE ${queueIdentifier(queue)}`
    });
  }
};
function queueIdentifier(value) {
  const ident = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new RedDBError(
      "INVALID_QUEUE_NAME",
      `invalid queue name "${ident}": expected an SQL identifier`
    );
  }
  return ident;
}
function queueCount(count) {
  if (count == null) return "";
  if (!Number.isInteger(count) || count < 0) {
    throw new RedDBError("INVALID_QUEUE_COUNT", "queue count must be a non-negative integer");
  }
  return ` COUNT ${count}`;
}
function queuePriority(priority) {
  if (!Number.isInteger(priority)) {
    throw new RedDBError("INVALID_QUEUE_PRIORITY", "queue priority must be an integer");
  }
  return String(priority);
}
function queueValueLiteral(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "NULL";
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  return JSON.stringify(value);
}
function queuePayloads(result) {
  return Array.isArray(result?.rows) ? result.rows.map((row) => row.payload) : [];
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/documents.js
var DocumentClient = class {
  constructor(db) {
    this.db = db;
  }
  async insert(collection, document) {
    validateObject(document, "documents.insert document");
    await this.ensureCollection(collection);
    const result = await this.db.query(
      `INSERT INTO ${sqlIdentifierPath(collection)} DOCUMENT (body) VALUES (${sqlJsonLiteral(document)}) RETURNING *`
    );
    const item = result.rows?.[0];
    if (!item || item.rid == null) {
      throw new RedDBError("INVALID_RESPONSE", "documents.insert expected one returned item with rid");
    }
    return { affected: result.affected ?? 1, rid: item.rid, item };
  }
  async get(collection, rid) {
    const result = await this.db.get(collection, rid);
    if (!result.entity) {
      throw new RedDBError("NOT_FOUND", `document ${String(rid)} was not found`);
    }
    return result.entity;
  }
  async list(collection, options = {}) {
    const limit = normalizeLimit(options.limit);
    const orderBy = options.orderBy ?? options.order_by ?? "rid ASC";
    const where = options.filter ? ` WHERE ${String(options.filter)}` : "";
    const result = await this.db.query(
      `SELECT * FROM ${sqlIdentifierPath(collection)}${where} ORDER BY ${orderBy} LIMIT ${limit}`
    );
    return { items: result.rows ?? [] };
  }
  async patch(collection, rid, patch) {
    validateObject(patch, "documents.patch patch");
    const entries = Object.entries(patch);
    if (entries.length === 0) {
      throw new RedDBError(
        "INVALID_ARGUMENT",
        "documents.patch patch must be a non-empty object"
      );
    }
    for (const [field] of entries) {
      if (field.includes("/")) {
        throw new RedDBError(
          "INVALID_ARGUMENT",
          "documents.patch currently accepts top-level document fields"
        );
      }
    }
    const assignments = entries.map(([field, value]) => `${sqlIdentifier(field)} = ${sqlValueLiteral(value)}`).join(", ");
    const result = await this.db.query(
      `UPDATE ${sqlIdentifierPath(collection)} DOCUMENTS SET ${assignments} WHERE rid = $1 RETURNING *`,
      rid
    );
    const item = result.rows?.[0];
    if (!item) {
      throw new RedDBError("NOT_FOUND", `document ${String(rid)} was not found`);
    }
    return item;
  }
  async delete(collection, rid) {
    const result = await this.db.delete(collection, rid);
    const affected = result.affected ?? 0;
    return { affected, deleted: affected > 0 };
  }
  async ensureCollection(collection) {
    try {
      await this.db.query(`CREATE DOCUMENT ${sqlIdentifierPath(collection)}`);
    } catch (err) {
      const message = String(err?.message ?? "");
      if (!message.includes("already exists")) throw err;
    }
  }
};
function validateObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RedDBError("INVALID_ARGUMENT", `${label} must be an object`);
  }
}
function normalizeLimit(value) {
  if (value == null) return 100;
  if (!Number.isInteger(value) || value <= 0) {
    throw new RedDBError("INVALID_ARGUMENT", "limit must be a positive integer");
  }
  return value;
}
function sqlIdentifierPath(value) {
  return String(value).split(".").map(sqlIdentifier).join(".");
}
function sqlIdentifier(value) {
  const ident = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new RedDBError("INVALID_ARGUMENT", `invalid SQL identifier "${ident}"`);
  }
  return ident;
}
function sqlJsonLiteral(value) {
  return sqlString(JSON.stringify(value));
}
function sqlValueLiteral(value) {
  if (value == null) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") return sqlJsonLiteral(value);
  return sqlString(value);
}
function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/config.js
var ConfigClient = class {
  constructor(client, collection = "red.config") {
    this.client = client;
    this.collection = collection;
  }
  put(key, value, options = {}) {
    rejectVolatileOptions(options, "config");
    const collection = options.collection ?? this.collection;
    const tags = Array.isArray(options.tags) && options.tags.length > 0 ? ` TAGS [${options.tags.map(keyedStringLiteral).join(", ")}]` : "";
    return this.client.call("query", {
      sql: `PUT CONFIG ${keyedIdentifier(collection)} ${keyedIdentifier(key)} = ${configValueLiteral(value, options)}${tags}`
    });
  }
  get(key, options = {}) {
    const collection = options.collection ?? this.collection;
    return this.client.call("query", {
      sql: `GET CONFIG ${keyedIdentifier(collection)} ${keyedIdentifier(key)}`
    });
  }
  resolve(key, options = {}) {
    const collection = options.collection ?? this.collection;
    return this.client.call("query", {
      sql: `RESOLVE CONFIG ${keyedIdentifier(collection)} ${keyedIdentifier(key)}`
    });
  }
};
function configValueLiteral(value, options) {
  if (options.secretRef) {
    const { collection, key } = options.secretRef;
    return `SECRET_REF(vault, ${keyedIdentifier(collection)}.${keyedIdentifier(key)})`;
  }
  return keyedValueLiteral(value);
}
function rejectVolatileOptions(options, domain) {
  for (const field of ["ttl", "ttlMs", "ttl_ms", "expireMs", "expire_ms", "expiresAt"]) {
    if (options[field] != null) {
      throw new TypeError(`${domain} does not support TTL or expiration options`);
    }
  }
}
function keyedIdentifier(value) {
  const out = String(value);
  if (!/^[A-Za-z0-9_.]+$/.test(out)) {
    throw new TypeError("keyed collection and key names must use letters, numbers, underscores, or dots");
  }
  return out;
}
function keyedValueLiteral(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "NULL";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return keyedStringLiteral(value);
}
function keyedStringLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/vault.js
var VaultClient = class {
  constructor(client, collection = "red.vault") {
    this.client = client;
    this.collection = collection;
  }
  put(key, value, options = {}) {
    rejectVolatileOptions2(options, "vault");
    const collection = options.collection ?? this.collection;
    const tags = Array.isArray(options.tags) && options.tags.length > 0 ? ` TAGS [${options.tags.map(keyedStringLiteral2).join(", ")}]` : "";
    return this.client.call("query", {
      sql: `VAULT PUT ${keyedIdentifier2(collection)}.${keyedIdentifier2(key)} = ${keyedValueLiteral2(value)}${tags}`
    });
  }
  get(key, options = {}) {
    const collection = options.collection ?? this.collection;
    return this.client.call("query", {
      sql: `VAULT GET ${keyedIdentifier2(collection)}.${keyedIdentifier2(key)}`
    });
  }
  unseal(key, options = {}) {
    const collection = options.collection ?? this.collection;
    return this.client.call("query", {
      sql: `UNSEAL VAULT ${keyedIdentifier2(collection)}.${keyedIdentifier2(key)}`
    });
  }
};
function rejectVolatileOptions2(options, domain) {
  for (const field of ["ttl", "ttlMs", "ttl_ms", "expireMs", "expire_ms", "expiresAt"]) {
    if (options[field] != null) {
      throw new TypeError(`${domain} does not support TTL or expiration options`);
    }
  }
}
function keyedIdentifier2(value) {
  const out = String(value);
  if (!/^[A-Za-z0-9_.]+$/.test(out)) {
    throw new TypeError("keyed collection and key names must use letters, numbers, underscores, or dots");
  }
  return out;
}
function keyedValueLiteral2(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "NULL";
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return keyedStringLiteral2(value);
}
function keyedStringLiteral2(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/db-helpers.js
async function listCollections(db) {
  const result = await db.query("SHOW COLLECTIONS");
  return (result.rows ?? []).map(collectionMeta);
}
async function collectionExists(db, collection) {
  const result = await db.query(`SHOW COLLECTIONS WHERE name = ${sqlString2(collection)}`);
  return (result.rows ?? []).some((row) => row.name === String(collection));
}
var TypedQueryBuilder = class _TypedQueryBuilder {
  constructor(db, collection, columns = null, whereClauses = [], params = []) {
    this.db = db;
    this.collection = collection;
    this.columns = columns;
    this.whereClauses = whereClauses;
    this.params = params;
  }
  select(...columns) {
    const selected = columns.length === 1 && Array.isArray(columns[0]) ? columns[0] : columns;
    const projection = selected.length === 1 && selected[0] === "*" ? null : selected;
    return new _TypedQueryBuilder(
      this.db,
      this.collection,
      projection != null && projection.length > 0 ? projection : null,
      this.whereClauses,
      this.params
    );
  }
  where(condition, ...params) {
    if (typeof condition !== "string" || condition.trim().length === 0) {
      throw new RedDBError("INVALID_QUERY_BUILDER", "where() requires a non-empty SQL condition");
    }
    const nextParams = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return new _TypedQueryBuilder(
      this.db,
      this.collection,
      this.columns,
      [...this.whereClauses, condition.trim()],
      [...this.params, ...nextParams]
    );
  }
  async run() {
    const projection = this.columns == null ? "*" : this.columns.map(sqlIdentifierPath2).join(", ");
    const where = this.whereClauses.length > 0 ? ` WHERE ${this.whereClauses.map((clause) => `(${clause})`).join(" AND ")}` : "";
    const sql = `SELECT ${projection} FROM ${sqlIdentifierPath2(this.collection)}${where}`;
    const result = this.params.length > 0 ? await this.db.query(sql, this.params) : await this.db.query(sql);
    const rows = result.rows ?? [];
    if (this.columns == null) return rows;
    return rows.map((row) => {
      const selected = {};
      for (const column of this.columns) selected[column] = row[column];
      return selected;
    });
  }
};
function collectionMeta(row) {
  return {
    ...row,
    name: String(row.name),
    model: String(row.model),
    capabilities: Array.isArray(row.capabilities) ? row.capabilities : []
  };
}
function sqlIdentifierPath2(value) {
  return String(value).split(".").map(sqlIdentifier2).join(".");
}
function sqlIdentifier2(value) {
  const ident = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) {
    throw new RedDBError(
      "INVALID_IDENTIFIER",
      `invalid SQL identifier "${ident}"`
    );
  }
  return ident;
}
function sqlString2(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// ../../../node_modules/.pnpm/@reddb-io+sdk@1.7.0/node_modules/@reddb-io/sdk/src/index.js
var EMBEDDED_ONLY_MESSAGE = "remote URIs are not supported in @reddb-io/sdk; install @reddb-io/client for grpc/http/red transports";
var HELPER_SPEC_VERSION = "1.0";
var MIN_INSERT_ID_ENGINE_VERSION = "1.0.9";
var NESTED_TX_NOT_SUPPORTED = "NESTED_TX_NOT_SUPPORTED";
async function connect(uri, options = {}) {
  const parsed = parseUri(uri);
  rejectRemoteUri(parsed);
  if (parsed.kind === "embedded") {
    const merged = mergeAuthFromUri(parsed, options.auth);
    if (merged.token || merged.username) {
      throw new RedDBError(
        "AUTH_NOT_APPLICABLE",
        "auth is only meaningful for remote connections; embedded modes inherit caller privileges."
      );
    }
    const args = embeddedArgs(parsed);
    const binary = options.binary ?? resolveSdkBinary();
    const child = await spawnRed(binary, args);
    const client = new RpcClient(child);
    await client.call("version", {});
    return new RedDB(client, { transport: "embedded" });
  }
}
function serializeParam(value) {
  assertSupportedParam(value);
  if (value instanceof Float32Array || value instanceof Float64Array) {
    return Array.from(value);
  }
  if (value instanceof Date) {
    return { $ts: String(BigInt(value.getTime()) * 1000000n) };
  }
  if (value instanceof Uint8Array || typeof Buffer !== "undefined" && value instanceof Buffer) {
    return { $bytes: bytesToBase642(value) };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    if (Number.isNaN(value)) return { $float: "NaN" };
    return { $float: value > 0 ? "Infinity" : "-Infinity" };
  }
  if (typeof value === "string" && isUuidString(value)) {
    return { $uuid: value };
  }
  return value;
}
function assertSupportedParam(value) {
  if (value == null) return;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new RedDBError("UNSUPPORTED_PARAM", "cannot encode invalid Date query parameter");
    }
    return;
  }
  if (value instanceof Uint8Array || value instanceof Float32Array || value instanceof Float64Array || typeof Buffer !== "undefined" && value instanceof Buffer) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "number")) return;
    throw new RedDBError(
      "UNSUPPORTED_PARAM",
      "array query parameters must contain only numbers"
    );
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return;
  }
  throw new RedDBError(
    "UNSUPPORTED_PARAM",
    `cannot encode query parameter of type ${typeof value}`
  );
}
function normalizeQueryParams(args) {
  if (args.length === 0) return null;
  if (args.length === 1 && Array.isArray(args[0])) return args[0].map(serializeParam);
  return args.map(serializeParam);
}
function bytesToBase642(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function base64ToBytes2(value) {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(value, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
function isUuidString(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function normalizeResult(value) {
  if (Array.isArray(value)) return value.map(normalizeResult);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      if (typeof value.$bytes === "string") return base64ToBytes2(value.$bytes);
      if (typeof value.$uuid === "string") return value.$uuid;
      if (typeof value.$float === "string") {
        if (value.$float === "NaN") return Number.NaN;
        if (value.$float === "Infinity" || value.$float === "+Infinity") return Infinity;
        if (value.$float === "-Infinity") return -Infinity;
      }
      if (typeof value.$ts === "string" || typeof value.$ts === "number") {
        const raw = typeof value.$ts === "string" ? BigInt(value.$ts) : BigInt(Math.trunc(value.$ts));
        return new Date(Number(raw / 1000000n));
      }
    }
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeResult(item);
    return out;
  }
  return value;
}
function embeddedArgs(parsed) {
  if (parsed.path) return ["rpc", "--stdio", "--path", parsed.path];
  return ["rpc", "--stdio"];
}
function mergeAuthFromUri(parsed, optionAuth) {
  const out = {
    token: parsed.token ?? parsed.apiKey ?? null,
    username: parsed.username ?? null,
    password: parsed.password ?? null,
    loginUrl: parsed.loginUrl ?? null
  };
  if (optionAuth == null) return out;
  if (typeof optionAuth !== "object") {
    throw new TypeError("options.auth must be an object");
  }
  if (optionAuth.token != null) {
    if (typeof optionAuth.token !== "string" || optionAuth.token.length === 0) {
      throw new TypeError("options.auth.token must be a non-empty string");
    }
    out.token = optionAuth.token;
  }
  if (optionAuth.apiKey != null) {
    if (typeof optionAuth.apiKey !== "string" || optionAuth.apiKey.length === 0) {
      throw new TypeError("options.auth.apiKey must be a non-empty string");
    }
    out.token = optionAuth.apiKey;
  }
  if (optionAuth.username != null) {
    if (typeof optionAuth.username !== "string" || optionAuth.username.length === 0) {
      throw new TypeError("options.auth.username must be a non-empty string");
    }
    out.username = optionAuth.username;
  }
  if (optionAuth.password != null) {
    if (typeof optionAuth.password !== "string" || optionAuth.password.length === 0) {
      throw new TypeError("options.auth.password must be a non-empty string");
    }
    out.password = optionAuth.password;
  }
  if (optionAuth.loginUrl != null) {
    out.loginUrl = optionAuth.loginUrl;
  }
  return out;
}
function rejectRemoteUri(parsed) {
  if (parsed.kind === "embedded") return;
  throw new RedDBError("EMBEDDED_ONLY", EMBEDDED_ONLY_MESSAGE);
}
var TransactionHandle = class {
  constructor(db) {
    this.db = db;
  }
  query(sql, ...params) {
    return this.db.query(sql, ...params);
  }
  execute(sql, ...params) {
    return this.db.execute(sql, ...params);
  }
  insert(collection, payload) {
    return this.db.insert(collection, payload);
  }
  bulkInsert(collection, payloads) {
    return this.db.bulkInsert(collection, payloads);
  }
  async transaction() {
    throw nestedTransactionError();
  }
};
var TxClient = class {
  constructor(db) {
    this.db = db;
    this.active = false;
  }
  async begin() {
    if (this.db.inTransaction) {
      throw nestedTransactionError();
    }
    this.db.inTransaction = true;
    this.active = true;
    try {
      return await this.db.query("BEGIN");
    } catch (err) {
      this.db.inTransaction = false;
      this.active = false;
      throw err;
    }
  }
  async commit() {
    if (!this.active) {
      throw new RedDBError("INVALID_ARGUMENT", "tx.commit() called without an open transaction");
    }
    try {
      return await this.db.query("COMMIT");
    } finally {
      this.active = false;
      this.db.inTransaction = false;
    }
  }
  async rollback() {
    if (!this.active) {
      throw new RedDBError("INVALID_ARGUMENT", "tx.rollback() called without an open transaction");
    }
    try {
      return await this.db.query("ROLLBACK");
    } finally {
      this.active = false;
      this.db.inTransaction = false;
    }
  }
  /**
   * Callback form: commit on success, roll back and re-throw on failure.
   * Nested `tx.run` rejects with `INVALID_ARGUMENT` — callers wanting
   * savepoints issue them directly via `tx.query()` (spec §7.2; the README
   * records this choice).
   */
  async run(callback) {
    if (typeof callback !== "function") {
      throw new TypeError("tx.run(callback) requires a function");
    }
    if (this.db.inTransaction) {
      throw new RedDBError(
        "INVALID_ARGUMENT",
        "nested tx.run() is not supported; issue savepoints via tx.query() instead"
      );
    }
    await this.begin();
    try {
      const result = await callback(new TransactionHandle(this.db));
      await this.commit();
      return result;
    } catch (err) {
      if (this.active) {
        try {
          await this.rollback();
        } catch (rollbackErr) {
          attachRollbackError(err, rollbackErr);
        }
      }
      throw err;
    }
  }
};
var RedDB = class {
  /**
   * @param {RpcClient} client
   * @param {object} [opts]
   * @param {string} [opts.transport] Underlying transport label
   *   (normally 'embedded'). Used to gate calls that the embedded
   *   stdio bridge does not serve, like `cache.*`.
   */
  constructor(client, opts = {}) {
    this.client = client;
    this.transport = opts.transport ?? null;
    this.helperSpecVersion = HELPER_SPEC_VERSION;
    this.cache = new CacheClient(client, this.transport);
    this.queue = new QueueClient(client);
    this.queues = this.queue;
    this.documents = new DocumentClient(this);
    const defaultKv = new KvClient(client);
    this.kv = Object.assign((collection = "kv_default") => new KvClient(client, collection), {
      put: defaultKv.put.bind(defaultKv),
      invalidateTags: defaultKv.invalidateTags.bind(defaultKv),
      watch: defaultKv.watch.bind(defaultKv),
      watchPrefix: defaultKv.watchPrefix.bind(defaultKv)
    });
    this.config = (collection = "red.config") => new ConfigClient(client, collection);
    this.vault = (collection = "red.vault") => new VaultClient(client, collection);
    this.inTransaction = false;
  }
  /**
   * Execute a SQL query.
   *
   * Two signatures:
   *   - `query(sql)` — legacy single-arg form.
   *   - `query(sql, ...params)` — positional `$N` bind values.
   *   - `query(sql, paramsArray)` — legacy array form.
   *
   * Returns `{ statement, affected, columns, rows }`.
   */
  query(sql, ...params) {
    if (typeof sql !== "string" || sql.trim().length === 0) {
      return Promise.reject(
        new RedDBError("INVALID_ARGUMENT", "query() requires a non-empty SQL string")
      );
    }
    const wireParams = normalizeQueryParams(params);
    if (wireParams == null) {
      return this.client.call("query", { sql }).then(normalizeResult);
    }
    return this.client.call("query", { sql, params: wireParams }).then(normalizeResult);
  }
  /** Execute a SQL statement. Alias for `query`, including parameter binding. */
  execute(sql, ...params) {
    return this.query(sql, ...params);
  }
  /** Insert one row. Returns `{ affected, rid, id }`; `id` is a legacy alias. */
  async insert(collection, payload) {
    const result = await this.client.call("insert", { collection, payload });
    return requireInsertId(result, "insert");
  }
  /** Insert many rows in one call. Returns `{ affected, rids, ids }`; `ids` is a legacy alias. */
  async bulkInsert(collection, payloads) {
    if (Array.isArray(payloads) && payloads.length === 0) {
      return { affected: 0, rids: [], ids: [] };
    }
    const result = await this.client.call("bulk_insert", { collection, payloads });
    return requireInsertIds(result, payloads.length);
  }
  /**
   * Spec §7 transaction handle. `db.tx()` returns a {@link TxClient} exposing
   * imperative `begin` / `commit` / `rollback` plus a `run(callback)` form.
   * `db.transaction(callback)` remains as the original callback-only shortcut.
   */
  tx() {
    return new TxClient(this);
  }
  async transaction(callback) {
    if (this.inTransaction) {
      throw nestedTransactionError();
    }
    if (typeof callback !== "function") {
      throw new TypeError("transaction(callback) requires a function");
    }
    this.inTransaction = true;
    let began = false;
    try {
      await this.query("BEGIN");
      began = true;
      const result = await callback(new TransactionHandle(this));
      await this.query("COMMIT");
      return result;
    } catch (err) {
      if (began) {
        try {
          await this.query("ROLLBACK");
        } catch (rollbackErr) {
          attachRollbackError(err, rollbackErr);
        }
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }
  /** Return true when a collection is visible in the catalog. */
  exists(collection) {
    return collectionExists(this, collection);
  }
  /** List visible collections using SHOW COLLECTIONS. */
  list() {
    return listCollections(this);
  }
  /** Return a caller-typed query builder for a collection. */
  from(collection) {
    return new TypedQueryBuilder(this, collection);
  }
  /** Get an entity by id. Returns `{ entity }` (entity is `null` if not found). */
  get(collection, id) {
    return this.client.call("get", { collection, id: String(id) });
  }
  /** Delete an entity by id. Returns `{ affected }`. */
  delete(collection, id) {
    return this.client.call("delete", { collection, id: String(id) });
  }
  /** Probe the server. Returns `{ ok: true, version }`. */
  health() {
    return this.client.call("health", {});
  }
  /** Server version + protocol version. */
  version() {
    return this.client.call("version", {});
  }
  // ---------------------------------------------------------------
  // Auth surface — these are not available in embedded mode because the
  // bridge layer doesn't expose `auth.*` JSON-RPC methods locally.
  // Use @reddb-io/client for remote authenticated servers.
  // ---------------------------------------------------------------
  /**
   * Exchange username + password for a bearer token when the underlying
   * client supports auth RPCs. Embedded SDK connections do not.
   */
  login(username, password) {
    return this.client.call("auth.login", { username, password });
  }
  /** Identify the current caller. Returns `{ username, role }`. */
  whoami() {
    return this.client.call("auth.whoami", {});
  }
  /** Change the current caller's password. */
  changePassword(currentPassword, newPassword) {
    return this.client.call("auth.change_password", {
      current_password: currentPassword,
      new_password: newPassword
    });
  }
  /**
   * Mint a long-lived API key for the caller (or a sub-user, when
   * the caller has `Admin` role). Returns `{ key, role, created_at }`.
   * Pass the returned `key` back via `auth: { apiKey: key }` on
   * future `connect()` calls.
   */
  createApiKey({ username, role } = {}) {
    return this.client.call("auth.create_api_key", { username, role });
  }
  /** Revoke an API key by its public id. */
  revokeApiKey(key) {
    return this.client.call("auth.revoke_api_key", { key });
  }
  /** Close the connection and wait for the binary to exit. */
  close() {
    return this.client.close();
  }
};
function nestedTransactionError() {
  return new RedDBError(
    NESTED_TX_NOT_SUPPORTED,
    `${NESTED_TX_NOT_SUPPORTED}: nested transactions are not supported on one connection`
  );
}
function attachRollbackError(err, rollbackErr) {
  if (err && typeof err === "object") {
    try {
      err.rollbackError = rollbackErr;
    } catch {
    }
  }
}
function requireInsertId(result, method) {
  if (!result || typeof result !== "object" || result.rid == null && result.id == null) {
    throw new RedDBError(
      "ENGINE_TOO_OLD",
      `${method}() requires RedDB engine >= ${MIN_INSERT_ID_ENGINE_VERSION} with insert id support`
    );
  }
  if (result.rid == null) result.rid = result.id;
  if (result.id == null) result.id = result.rid;
  return result;
}
function requireInsertIds(result, expected) {
  if (!result || typeof result !== "object" || !Array.isArray(result.rids) && !Array.isArray(result.ids)) {
    throw new RedDBError(
      "ENGINE_TOO_OLD",
      `bulkInsert() requires RedDB engine >= ${MIN_INSERT_ID_ENGINE_VERSION} with bulk insert id support`
    );
  }
  if (!Array.isArray(result.rids)) result.rids = result.ids;
  if (!Array.isArray(result.ids)) result.ids = result.rids;
  if (result.rids.length !== expected) {
    throw new RedDBError(
      "INVALID_RESPONSE",
      `bulkInsert() expected ${expected} rids, got ${result.rids.length}`
    );
  }
  return result;
}

// src/hash.ts
import { createHash } from "node:crypto";
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}
function contentHash(parts) {
  return sha256(JSON.stringify(parts));
}
function slugify(value) {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
  return slug || "artifact";
}

// src/schema.ts
var ARTIFACT_KINDS = [
  "pillar",
  "decision",
  "concept",
  "question",
  "playbook",
  "task",
  "event",
  "pattern",
  "hypothesis",
  "fact",
  "source",
  "bookmark",
  "note",
  "reference",
  "custom",
  "project",
  "idea",
  "meeting",
  "claim",
  "organization",
  "person"
];
var INGESTION_KIND_ALIASES = {
  contact: "person"
};
var CONNECTION_KINDS = [
  "supports",
  "contradicts",
  "depends_on",
  "derived_from",
  "related_to",
  "part_of",
  "preceded_by",
  "followed_by",
  "authored",
  "tagged"
];
var COLLECTIONS = {
  artifacts: "brain_artifacts",
  connections: "brain_connections",
  kv: "brain_kv"
};

// src/store.ts
var BrainStore = class _BrainStore {
  constructor(opts) {
    this.opts = opts;
  }
  db;
  artifactCache = null;
  connectionCache = null;
  static async open(opts) {
    const store = new _BrainStore(opts);
    store.db = await connect(opts.uri);
    await store.bootstrap();
    return store;
  }
  get raw() {
    return this.db;
  }
  async close() {
    await this.db.close();
  }
  async bootstrap() {
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.artifacts}`);
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.connections}`);
  }
  kv() {
    return this.db.kv(COLLECTIONS.kv);
  }
  async capture(input) {
    const kind = normalizeArtifactKind(input.kind ?? "note");
    const now = Date.now();
    const tags = normalizeTags(input.tags ?? []);
    const hash = contentHash([
      kind,
      input.title,
      input.content,
      tags,
      input.sourcePath,
      input.sourceSession
    ]);
    const existingRid = await this.findArtifactByHash(hash);
    if (existingRid != null) {
      const existing = await this.getArtifact(existingRid);
      if (existing) return existing;
    }
    const id = `${slugify(input.title)}-${hash.slice(0, 8)}`;
    const properties = {
      id,
      title: input.title,
      content: input.content,
      tags,
      source_agent: input.sourceAgent,
      source_runner: input.sourceRunner,
      source_session: input.sourceSession,
      source_path: input.sourcePath,
      created_at: now,
      updated_at: now,
      hash,
      metadata: input.metadata
    };
    const artifact = {
      label: id,
      kind,
      properties
    };
    const row = await this.db.query(
      `INSERT INTO ${COLLECTIONS.artifacts} NODE (label, node_type, hash, properties) VALUES ($1, $2, $3, $4) RETURNING *`,
      artifact.label,
      artifact.kind,
      hash,
      properties
    );
    const inserted = row.rows[0];
    if (!inserted) throw new Error("INSERT artifact returned no row");
    const rid = Number(inserted.red_entity_id ?? inserted.rid);
    await this.kv().put(artifactHashKey(hash), rid);
    this.artifactCache = null;
    const stored = { ...artifact, rid };
    await this.materializeTagConnections(stored);
    return stored;
  }
  async getArtifact(ridOrId) {
    const artifacts = await this.listArtifacts();
    if (typeof ridOrId === "number") {
      return artifacts.find((artifact) => artifact.rid === ridOrId) ?? null;
    }
    return artifacts.find((artifact) => artifact.properties.id === ridOrId || artifact.label === ridOrId) ?? null;
  }
  async listArtifacts() {
    if (this.artifactCache == null) {
      const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.artifacts}`);
      this.artifactCache = result.rows.map(rowToArtifact).filter(notNull);
    }
    return this.artifactCache;
  }
  async search(query, limit = 10) {
    const terms = tokenize(query);
    const artifacts = await this.listArtifacts();
    const hits = artifacts.map((artifact) => {
      const haystack = [
        artifact.properties.title,
        artifact.properties.content,
        artifact.kind,
        ...artifact.properties.tags ?? []
      ].join(" ").toLowerCase();
      const score = terms.reduce((sum, term) => sum + occurrences(haystack, term), 0);
      return { artifact, score, excerpt: excerpt(artifact.properties.content, terms) };
    }).filter((hit) => hit.score > 0).sort((a, b) => b.score - a.score || b.artifact.properties.updated_at - a.artifact.properties.updated_at);
    return hits.slice(0, limit);
  }
  async link(input) {
    const from = await this.getArtifact(input.from);
    const to = await this.getArtifact(input.to);
    if (!from) throw new Error(`Brain artifact not found: ${input.from}`);
    if (!to) throw new Error(`Brain artifact not found: ${input.to}`);
    const kind = normalizeConnectionKind(input.kind ?? "related_to");
    const existing = await this.findConnection(from.rid, to.rid, kind);
    if (existing != null) {
      const found = (await this.listConnections()).find((connection) => connection.rid === existing);
      if (found) return found;
    }
    const properties = {
      reason: input.reason,
      confidence: input.confidence ?? "explicit",
      created_at: Date.now(),
      metadata: input.metadata
    };
    const result = await this.db.query(
      `INSERT INTO ${COLLECTIONS.connections} EDGE (label, from, to, weight, properties) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      kind,
      from.rid,
      to.rid,
      1,
      properties
    );
    const row = result.rows[0];
    if (!row) throw new Error("INSERT connection returned no row");
    const rid = Number(row.red_entity_id ?? row.rid);
    await this.kv().put(connectionKey(from.rid, to.rid, kind), rid);
    this.connectionCache = null;
    return { rid, kind, from_rid: from.rid, to_rid: to.rid, weight: 1, properties };
  }
  async backlinks(target) {
    const artifact = await this.getArtifact(target);
    if (!artifact) throw new Error(`Brain artifact not found: ${target}`);
    return (await this.listConnections()).filter((connection) => connection.to_rid === artifact.rid);
  }
  async listConnections() {
    if (this.connectionCache == null) {
      const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.connections}`);
      this.connectionCache = result.rows.map(rowToConnection).filter(notNull);
    }
    return this.connectionCache;
  }
  async status() {
    const artifacts = await this.listArtifacts();
    const connections = await this.listConnections();
    return {
      uri: this.opts.uri,
      artifacts: artifacts.length,
      connections: connections.length,
      kinds: countBy(artifacts.map((artifact) => artifact.kind))
    };
  }
  async think(query, limit = 8) {
    const hits = await this.search(query, limit);
    const lines = hits.map((hit, index) => {
      const artifact = hit.artifact;
      return `[${index + 1}] ${artifact.properties.title} (${artifact.kind}, rid ${artifact.rid}): ${hit.excerpt}`;
    });
    return {
      hits,
      answer: lines.length > 0 ? `Deterministic Brain synthesis for "${query}":

${lines.join("\n")}` : `No Brain artifacts matched "${query}".`
    };
  }
  async findArtifactByHash(hash) {
    const rid = await this.kv().get(artifactHashKey(hash));
    return rid != null ? Number(rid) : null;
  }
  async findConnection(from, to, kind) {
    const rid = await this.kv().get(connectionKey(from, to, kind));
    return rid != null ? Number(rid) : null;
  }
  async materializeTagConnections(artifact) {
    if (artifact.properties.metadata?.derived_kind === "tag") return;
    for (const tag of artifact.properties.tags) {
      const tagArtifact = await this.capture({
        title: tag,
        content: `Tag: ${tag}`,
        kind: "custom",
        tags: ["tag"],
        metadata: { derived: true, derived_kind: "tag" }
      });
      await this.link({
        from: artifact.rid,
        to: tagArtifact.rid,
        kind: "tagged",
        confidence: "derived"
      });
    }
  }
};
function normalizeArtifactKind(value) {
  const mapped = INGESTION_KIND_ALIASES[value];
  const candidate = mapped ?? value;
  if (ARTIFACT_KINDS.includes(candidate)) return candidate;
  throw new Error(`invalid Brain artifact kind: ${value}`);
}
function normalizeConnectionKind(value) {
  if (CONNECTION_KINDS.includes(value)) return value;
  throw new Error(`invalid Brain connection kind: ${value}`);
}
function rowToArtifact(row) {
  const rid = Number(row.red_entity_id ?? row.rid);
  const properties = parseProperties(row.properties ?? row.PROPERTIES);
  const kind = String(row.node_type ?? row.NODE_TYPE ?? properties.kind ?? "note");
  if (!Number.isFinite(rid)) return null;
  const id = String(properties.id ?? row.label ?? row.LABEL ?? rid);
  const title = String(properties.title ?? row.label ?? row.LABEL ?? id);
  const content = String(properties.content ?? "");
  const tags = Array.isArray(properties.tags) ? properties.tags.map(String) : [];
  const now = Date.now();
  return {
    rid,
    label: String(row.label ?? row.LABEL ?? id),
    kind: normalizeArtifactKind(kind),
    properties: {
      ...properties,
      id,
      title,
      content,
      tags,
      created_at: Number(properties.created_at ?? now),
      updated_at: Number(properties.updated_at ?? properties.created_at ?? now),
      hash: String(properties.hash ?? "")
    }
  };
}
function rowToConnection(row) {
  const rid = Number(row.red_entity_id ?? row.rid);
  const from = Number(row.from ?? row.FROM ?? row.from_rid ?? row.source);
  const to = Number(row.to ?? row.TO ?? row.to_rid ?? row.target);
  const kind = String(row.label ?? row.LABEL ?? "related_to");
  if (!Number.isFinite(rid) || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    rid,
    kind: normalizeConnectionKind(kind),
    from_rid: from,
    to_rid: to,
    weight: Number(row.weight ?? 1),
    properties: parseProperties(row.properties ?? row.PROPERTIES)
  };
}
function parseProperties(value) {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value);
  return value;
}
function notNull(value) {
  return value != null;
}
function normalizeTags(tags) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort();
}
function tokenize(query) {
  return query.toLowerCase().split(/[^a-z0-9_]+/).map((term) => term.trim()).filter((term) => term.length > 1);
}
function occurrences(haystack, needle) {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}
function excerpt(content, terms) {
  if (content.length <= 220) return content;
  const lower = content.toLowerCase();
  const first = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 80);
  return `${start > 0 ? "..." : ""}${content.slice(start, start + 220)}${start + 220 < content.length ? "..." : ""}`;
}
function artifactHashKey(hash) {
  return `artifact.hash.${hash}`;
}
function connectionKey(from, to, kind) {
  return `connection.${from}.${kind}.${to}`;
}
function countBy(values) {
  const out = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

// src/hook-runtime.ts
async function handleHook(lifecycle, runner) {
  if (lifecycle !== "SessionStart") return {};
  const config = await resolveBrainConfig(process.cwd());
  const store = await BrainStore.open({ uri: config.connectionString });
  try {
    await store.status();
  } finally {
    await store.close();
  }
  const stateDir = join4(config.rootDir, ".red", "brain", "sessions");
  await mkdir2(stateDir, { recursive: true });
  await writeFile2(
    join4(stateDir, "last-session.json"),
    JSON.stringify(
      {
        runner,
        lifecycle,
        rootDir: config.rootDir,
        connectionString: config.connectionString,
        startedAt: (/* @__PURE__ */ new Date()).toISOString()
      },
      null,
      2
    ),
    "utf8"
  );
  return {};
}

// src/runtime.ts
import { basename } from "node:path";
async function openBrainRuntime(startDir = process.cwd()) {
  const config = await resolveBrainConfig(startDir);
  const store = await BrainStore.open({ uri: config.connectionString });
  return {
    config,
    store,
    project: basename(config.rootDir)
  };
}
async function withBrainRuntime(fn, startDir = process.cwd()) {
  const runtime = await openBrainRuntime(startDir);
  try {
    return await fn(runtime);
  } finally {
    await runtime.store.close();
  }
}

// src/cli.ts
async function main() {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "init":
      await withBrainRuntime(async ({ config, store }) => {
        const status = await store.status();
        printJson({ rootDir: config.rootDir, configPath: config.configPath, ...status });
      });
      return;
    case "status":
      await withBrainRuntime(async ({ config, store }) => {
        printJson({ rootDir: config.rootDir, configPath: config.configPath, ...await store.status() });
      });
      return;
    case "capture":
      await capture(args);
      return;
    case "search":
      await search(args);
      return;
    case "think":
    case "query":
      await think(args);
      return;
    case "get":
      await get(args);
      return;
    case "link":
      await link(args);
      return;
    case "backlinks":
      await backlinks(args);
      return;
    case "hook":
      await hook(args);
      return;
    default:
      throw new Error(`unknown brain command: ${command}`);
  }
}
async function capture(args) {
  const flags = parseFlags(args);
  const title = (stringFlag(flags, "title") ?? flags._.join(" ").slice(0, 80)) || "Untitled artifact";
  const content = stringFlag(flags, "content") ?? (stringFlag(flags, "file") ? await readFile2(String(stringFlag(flags, "file")), "utf8") : flags._.join(" "));
  if (!content.trim()) throw new Error("brain capture requires content, --content, or --file");
  await withBrainRuntime(async ({ store }) => {
    const artifact = await store.capture({
      title,
      content,
      kind: stringFlag(flags, "kind") ?? "note",
      tags: listFlag(flags, "tag"),
      sourceAgent: stringFlag(flags, "agent"),
      sourceRunner: stringFlag(flags, "runner"),
      sourceSession: stringFlag(flags, "session"),
      sourcePath: process.cwd()
    });
    printJson(artifact);
  });
}
async function search(args) {
  const flags = parseFlags(args);
  const query = stringFlag(flags, "query") ?? flags._.join(" ");
  if (!query) throw new Error("brain search requires a query");
  const limit = numberFlag(flags, "limit") ?? 10;
  await withBrainRuntime(async ({ store }) => printJson(await store.search(query, limit)));
}
async function think(args) {
  const flags = parseFlags(args);
  const query = stringFlag(flags, "query") ?? flags._.join(" ");
  if (!query) throw new Error("brain think requires a query");
  const limit = numberFlag(flags, "limit") ?? 8;
  await withBrainRuntime(async ({ store }) => {
    const result = await store.think(query, limit);
    if (flags.json === true) printJson(result);
    else console.log(result.answer);
  });
}
async function get(args) {
  const id = args[0];
  if (!id) throw new Error("brain get requires a rid or artifact id");
  await withBrainRuntime(async ({ store }) => {
    const artifact = await store.getArtifact(parseRidOrId(id));
    if (!artifact) throw new Error(`Brain artifact not found: ${id}`);
    printJson(artifact);
  });
}
async function link(args) {
  const flags = parseFlags(args);
  const from = stringFlag(flags, "from");
  const to = stringFlag(flags, "to");
  if (!from || !to) throw new Error("brain link requires --from and --to");
  await withBrainRuntime(async ({ store }) => {
    printJson(
      await store.link({
        from: parseRidOrId(from),
        to: parseRidOrId(to),
        kind: stringFlag(flags, "kind") ?? "related_to",
        reason: stringFlag(flags, "reason")
      })
    );
  });
}
async function backlinks(args) {
  const target = args[0];
  if (!target) throw new Error("brain backlinks requires a rid or artifact id");
  await withBrainRuntime(async ({ store }) => printJson(await store.backlinks(parseRidOrId(target))));
}
async function hook(args) {
  const [lifecycle = "SessionStart", ...rest] = args;
  const flags = parseFlags(rest);
  const runner = stringFlag(flags, "runner") ?? "unknown";
  printJson(await handleHook(lifecycle, runner));
}
function parseRidOrId(value) {
  return /^\d+$/.test(value) ? Number(value) : value;
}
function parseFlags(args) {
  const flags = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    const value = next && !next.startsWith("--") ? args[++i] : true;
    const prev = flags[key];
    if (prev == null || prev === false) flags[key] = value;
    else if (Array.isArray(prev)) prev.push(String(value));
    else flags[key] = [String(prev), String(value)];
  }
  return flags;
}
function stringFlag(flags, key) {
  const value = flags[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[value.length - 1];
  return void 0;
}
function listFlag(flags, key) {
  const value = flags[key];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value;
  return [];
}
function numberFlag(flags, key) {
  const value = stringFlag(flags, key);
  if (value == null) return void 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}
function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}
function printHelp() {
  console.log(`brain commands:
  init
  status
  capture [text] --title <title> --kind <${ARTIFACT_KINDS.join("|")}> --tag <tag>
  search <query> [--limit N]
  think <query> [--limit N] [--json]
  get <rid|id>
  link --from <rid|id> --to <rid|id> --kind <${CONNECTION_KINDS.join("|")}>
  backlinks <rid|id>
`);
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
