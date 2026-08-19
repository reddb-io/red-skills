import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MemoryStore } from "./graph-store.js";
import type { MemoryConfig } from "./config.js";
import type { AiProviderConfig } from "./extract-conversation.js";
import { recall } from "./engine.js";
import {
  buildMemoryOperationalDashboard,
  buildMemoryOperationalDashboardArtifact,
} from "./operational-dashboard.js";
import { runAutoCure, readAutoCureRunLog } from "./auto-curation.js";
import {
  buildMemoryWorkbench,
  buildMemoryWorkbenchArtifact,
} from "./workbench.js";
import {
  SUPPORTED_ROUTING_AGENTS,
} from "./routing-guide.js";
import {
  listReadOnlyMemoryOperations,
  type ReadOnlyMemoryOperation,
} from "./operations.js";
import {
  executeMemoryOperationFromTransport,
  listMemoryOperationsForTransport,
  MemoryOperationTransportError,
  queryObjectFromSearchParams,
  viewerHtml,
} from "./operation-transport-adapter.js";

export interface MemoryHttpServerOptions {
  rootDir: string;
  store: MemoryStore;
  token?: string;
  now?: number;
  memoryConfig?: MemoryConfig;
  providerConfig?: AiProviderConfig;
}

export interface MemoryHttpHealth {
  schema_version: "memory.http.health.v1";
  read_only: true;
  root: string;
  auth: "none" | "bearer";
  endpoints: string[];
}

export interface MemoryOpenApiDocument {
  openapi: "3.1.0";
  info: {
    title: "RedSkills Memory local HTTP API";
    version: "memory.http.v1";
    description: string;
  };
  servers: Array<{ url: string }>;
  security: Array<Record<string, string[]>>;
  paths: Record<string, unknown>;
  components: {
    securitySchemes: {
      bearerAuth: {
        type: "http";
        scheme: "bearer";
      };
    };
  };
}

const LEGACY_ENDPOINTS = [
  "GET /",
  "GET /workbench",
  "GET /assets?kind=<kind>",
  "GET /search?query=<text>",
  "GET /smart-search?query=<text>",
  "GET /context-pack?goal=<text>",
  "GET /dashboard",
  "GET /communities",
  "GET /docs/backlinks?query=<text>|label=<label>|rid=<rid>",
  "GET /docs/brief?query=<text>",
  "GET /docs/bundle?query=<text>",
  "GET /docs/evidence-pack?path=<path>|rid=<rid>",
  "GET /docs/reference-graph",
  "GET /docs/related?path=<path>|rid=<rid>",
  "GET /docs/search?query=<text>",
  "GET /extraction/status",
  "GET /governance",
  "GET /handoff?focus=<text>",
  "GET /frontier?focus=<text>",
  "GET /decay",
  "GET /routing-guide?agent=<agent>",
  "GET /integration-status?agent=<agent>",
  "GET /hooks/coverage",
  "GET /layers",
  "GET /learning-debt",
  "GET /map-contract",
  "GET /memory/health",
  "GET /onboarding-map",
  "GET /openapi.json",
  "GET /vector/status",
  "GET /api/health",
  "GET /api/memory/health",
  "GET /api/openapi.json",
  "GET /api/assets?kind=<kind>",
  "GET /api/workbench",
  "GET /api/dashboard",
  "GET /api/references-radar",
  "GET /api/communities",
  "GET /api/context-pack?goal=<text>",
  "GET /api/extraction/status",
  "GET /api/governance",
  "GET /api/handoff?focus=<text>",
  "GET /api/frontier?focus=<text>",
  "GET /api/decay",
  "GET /api/routing-guide?agent=<agent>",
  "GET /api/integration-status?agent=<agent>",
  "GET /api/layers",
  "GET /api/learning-debt",
  "GET /api/map-contract",
  "GET /api/map/freshness",
  "GET /api/onboarding-map",
  "GET /api/hooks/coverage",
  "GET /api/session/timeline?session=<id>",
  "GET /api/docs/brief?query=<text>",
  "GET /api/docs/bundle?query=<text>",
  "GET /api/docs/coverage",
  "GET /api/docs/backlinks?query=<text>|label=<label>|rid=<rid>",
  "GET /api/docs/evidence-pack?path=<path>|rid=<rid>",
  "GET /api/docs/reference-graph",
  "GET /api/docs/related?path=<path>|rid=<rid>",
  "GET /api/docs/search?query=<text>",
  "GET /api/docs/read?path=<path>|rid=<rid>",
  "GET /api/confidence?node=<rid>",
  "GET /api/path-explain?from=<label>&to=<label>",
  "GET /api/vector/status",
  "GET /api/vector/search?query=<text>",
  "GET /api/search?query=<text>",
  "GET /api/smart-search?query=<text>",
  "GET /api/recall?query=<text>",
  "GET /api/reasoning-replay?task=<text>",
  "GET /api/whatif?change=<descriptor>[&change=<descriptor>...] | POST /api/whatif",
  "GET /api/federate?query=<text>",
  "GET /api/autocure (dry-run) | POST /api/autocure (apply)",
];

const REGISTRY_HTTP_ROUTES = buildRegistryHttpRoutes();
const ENDPOINTS = [
  ...new Set([
    ...LEGACY_ENDPOINTS,
    ...[...REGISTRY_HTTP_ROUTES.entries()].flatMap(([route, operation]) =>
      (operation.renderer.http?.methods ?? ["GET"]).map((method) => `${method} ${route}`),
    ),
  ]),
].sort();

export function listMemoryHttpRegistryRoutes(
  operations?: readonly ReadOnlyMemoryOperation[],
): Array<{ route: string; operationId: string }> {
  const routes = operations ? buildRegistryHttpRoutes(operations) : REGISTRY_HTTP_ROUTES;
  return [...routes.entries()]
    .map(([route, operation]) => ({ route, operationId: operation.id }))
    .sort((a, b) => a.route.localeCompare(b.route));
}

export function memoryOpenApiPathsForOperations(
  operations: readonly ReadOnlyMemoryOperation[],
): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  for (const operation of listMemoryOperationsForTransport(operations, "http")) {
    const contentType = operation.outputKind.kind === "viewer" ? "text/html" : "application/json";
    const parameters = operation.inputBinding.fields
      .filter((field) => field.sources.includes("query"))
      .map((field) => ({
        name: field.field,
        in: "query",
        required: field.required === true,
        schema: openApiSchemaForInputField(field.type),
      }));
    const methods = operation.renderer.http?.methods ?? ["GET"];
    for (const route of httpRoutesForOperation(operation)) {
      paths[route] = Object.fromEntries(
        methods.map((method) => [
          method.toLowerCase(),
          {
          summary: operation.description,
          ...(method === "GET" ? { parameters } : {}),
          ...(method === "POST"
            ? {
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: openApiInputSchema(operation) } },
                },
              }
            : {}),
          responses: {
            "200": {
              description: operation.description,
              content: { [contentType]: { schema: { type: operation.outputKind.kind === "viewer" ? "string" : "object" } } },
            },
          },
          },
        ]),
      );
    }
  }
  return paths;
}

function openApiInputSchema(operation: ReadOnlyMemoryOperation): Record<string, unknown> {
  const properties = Object.fromEntries(
    operation.inputBinding.fields.map((field) => [
      field.field,
      openApiSchemaForInputField(field.type),
    ]),
  );
  const required = operation.inputBinding.fields
    .filter((field) => field.required === true)
    .map((field) => field.field);
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function openApiSchemaForInputField(
  type: ReadOnlyMemoryOperation["inputBinding"]["fields"][number]["type"],
): Record<string, unknown> {
  if (type === "number") return { type: "number" };
  if (type === "boolean") return { type: "boolean" };
  if (type === "string-array" || type === "object-array") {
    return { type: "array", items: { type: type === "string-array" ? "string" : "object" } };
  }
  return { type: "string" };
}

export function createMemoryHttpServer(opts: MemoryHttpServerOptions): Server {
  return createServer(async (req, res) => {
    try {
      await handleRequest(req, res, opts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MemoryHttpServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const isAutocurePost = req.method === "POST" && url.pathname === "/api/autocure";
  const registryOperation = REGISTRY_HTTP_ROUTES.get(url.pathname);
  if (registryOperation && !memoryHttpMethodAllowed(registryOperation, req.method)) {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  if (!registryOperation && req.method !== "GET" && req.method !== "HEAD" && !isAutocurePost) {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }

  if (!publicEndpoint(url.pathname) && !authorized(req, opts.token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  if (url.pathname === "/api/autocure") {
    const apply = isAutocurePost || url.searchParams.get("apply") === "true";
    const report = await runAutoCure(opts.store, {
      apply,
      staleDays: numberParam(url.searchParams.get("stale_days")),
      now: opts.now,
    });
    sendJson(res, 200, report);
    return;
  }

  if (url.pathname === "/api/autocure/runs") {
    const log = await readAutoCureRunLog(opts.store);
    sendJson(res, 200, log);
    return;
  }

  if (url.pathname === "/openapi.json" || url.pathname === "/api/openapi.json") {
    sendJson(res, 200, openApiDocument(opts));
    return;
  }

  if (url.pathname === "/api/health") {
    sendJson(res, 200, health(opts));
    return;
  }

  if (registryOperation) {
    await handleRegistryHttpOperation(registryOperation, req, url, res, opts);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/workbench") {
    const workbench = await buildMemoryWorkbench(opts.store, opts.rootDir, { now: opts.now });
    sendHtml(res, buildMemoryWorkbenchArtifact(workbench).html);
    return;
  }

  if (url.pathname === "/api/workbench") {
    sendJson(res, 200, await buildMemoryWorkbench(opts.store, opts.rootDir, { now: opts.now }));
    return;
  }

  if (url.pathname === "/api/dashboard") {
    sendJson(
      res,
      200,
      await buildMemoryOperationalDashboard(opts.store, opts.rootDir, { now: opts.now }),
    );
    return;
  }

  if (url.pathname === "/api/recall") {
    const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }
    const limit = numberParam(url.searchParams.get("limit"));
    sendJson(res, 200, await recall(opts.store, query, { k: limit }));
    return;
  }

  sendJson(res, 404, { error: "not found", endpoints: ENDPOINTS });
}

/** HEAD is transport-mechanical shorthand for a declared GET, never an implicit operation method. */
export function memoryHttpMethodAllowed(
  operation: ReadOnlyMemoryOperation,
  method: string | undefined,
): boolean {
  const declared = operation.renderer.http?.methods ?? ["GET"];
  return method === "HEAD" ? declared.includes("GET") : declared.includes(method as "GET" | "POST");
}

async function handleRegistryHttpOperation(
  operation: ReadOnlyMemoryOperation,
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
  opts: MemoryHttpServerOptions,
): Promise<void> {
  try {
    const body = req.method === "POST" ? await readJsonBody(req) : undefined;
    const output = await executeMemoryOperationFromTransport(
      operation,
      {
        store: opts.store,
        rootDir: opts.rootDir,
        now: opts.now,
        memoryConfig: opts.memoryConfig,
        providerConfig: opts.providerConfig,
        transportSurface: "http",
      },
      {
        positional: [],
        flags: {},
        query: queryObjectFromSearchParams(url.searchParams),
        body,
        rootDir: opts.rootDir,
      },
    );
    if (operation.outputKind.kind === "viewer") {
      sendHtml(res, viewerHtml(output));
      return;
    }
    if (operation.outputKind.format === "markdown") {
      sendMarkdown(res, markdownReport(output));
      return;
    }
    sendJson(res, 200, output);
  } catch (err) {
    if (err instanceof MemoryOperationTransportError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    throw err;
  }
}

function buildRegistryHttpRoutes(
  operations: readonly ReadOnlyMemoryOperation[] = listReadOnlyMemoryOperations(),
): Map<string, ReadOnlyMemoryOperation> {
  const routes = new Map<string, ReadOnlyMemoryOperation>();
  for (const operation of listMemoryOperationsForTransport(operations, "http")) {
    for (const route of httpRoutesForOperation(operation)) {
      const existing = routes.get(route);
      if (existing && existing.id !== operation.id) {
        throw new Error(
          `duplicate Memory HTTP operation route ${route}: ${existing.id} and ${operation.id}`,
        );
      }
      routes.set(route, operation);
    }
  }
  return routes;
}

function httpRoutesForOperation(operation: ReadOnlyMemoryOperation): string[] {
  return [
    operation.renderer.http?.route ?? defaultHttpRouteForOperation(operation),
    ...(operation.renderer.http?.aliases ?? []),
  ];
}

function defaultHttpRouteForOperation(operation: ReadOnlyMemoryOperation): string {
  const parts = operation.renderer.cli.command.split(" ");
  if (operation.outputKind.kind === "viewer") {
    const routeParts = [...parts];
    routeParts[routeParts.length - 1] = routeParts[routeParts.length - 1]!.replace(
      /-viewer$/,
      "",
    );
    return `/${routeParts.join("/")}`;
  }
  const route = `/api/${parts.join("/")}`;
  return route === "/api/health" ? `/api/memory/${parts.join("/")}` : route;
}

function health(opts: MemoryHttpServerOptions): MemoryHttpHealth {
  return {
    schema_version: "memory.http.health.v1",
    read_only: true,
    root: opts.rootDir,
    auth: opts.token ? "bearer" : "none",
    endpoints: ENDPOINTS,
  };
}

function openApiDocument(opts: MemoryHttpServerOptions): MemoryOpenApiDocument {
  const security = opts.token ? [{ bearerAuth: [] }] : [{}];
  const jsonResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: { type: "object" } } },
  });
  const htmlResponse = (description: string) => ({
    description,
    content: { "text/html": { schema: { type: "string" } } },
  });
  const queryParam = {
    name: "query",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const optionalQueryParam = {
    name: "query",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const goalParam = {
    name: "goal",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const limitParam = {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100 },
  };
  const pathParam = {
    name: "path",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const ridParam = {
    name: "rid",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1 },
  };
  const maxBytesParam = {
    name: "max_bytes",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 200000 },
  };
  const fromParam = {
    name: "from",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const toParam = {
    name: "to",
    in: "query",
    required: true,
    schema: { type: "string", minLength: 1 },
  };
  const maxDepthParam = {
    name: "max_depth",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 20 },
  };
  const sessionParam = {
    name: "session",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const kindParam = {
    name: "kind",
    in: "query",
    required: false,
    schema: { type: "string", minLength: 1 },
  };
  const staleDaysParam = {
    name: "stale_days",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100 },
  };
  const staleProgressDaysParam = {
    name: "stale_progress_days",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1 },
  };
  const deprecateDaysParam = {
    name: "deprecate_days",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1 },
  };
  const agentParam = {
    name: "agent",
    in: "query",
    required: false,
    schema: { type: "string", enum: SUPPORTED_ROUTING_AGENTS },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "RedSkills Memory local HTTP API",
      version: "memory.http.v1",
      description:
        "Optional loopback-only read-only API over the project-local RedDB Memory store.",
    },
    servers: [{ url: "/" }],
    security,
    paths: {
      "/api/health": {
        get: { summary: "Health and endpoint discovery", responses: { "200": jsonResponse("Health") } },
      },
      "/api/memory/health": {
        get: {
          summary: "Memory operational health",
          parameters: [staleDaysParam],
          responses: { "200": jsonResponse("Memory health report") },
        },
      },
      "/memory/health": {
        get: {
          summary: "Memory operational health HTML",
          parameters: [staleDaysParam],
          responses: { "200": htmlResponse("Memory health viewer HTML") },
        },
      },
      "/openapi.json": {
        get: { summary: "OpenAPI contract", responses: { "200": jsonResponse("OpenAPI document") } },
      },
      "/api/openapi.json": {
        get: { summary: "OpenAPI contract", responses: { "200": jsonResponse("OpenAPI document") } },
      },
      "/": {
        get: { summary: "Memory Workbench HTML", responses: { "200": htmlResponse("Workbench HTML") } },
      },
      "/workbench": {
        get: { summary: "Memory Workbench HTML", responses: { "200": htmlResponse("Workbench HTML") } },
      },
      "/dashboard": {
        get: { summary: "Memory operational dashboard HTML", responses: { "200": htmlResponse("Dashboard HTML") } },
      },
      "/assets": {
        get: {
          summary: "Asset inventory HTML",
          parameters: [kindParam, optionalQueryParam],
          responses: { "200": htmlResponse("Asset inventory viewer HTML") },
        },
      },
      "/search": {
        get: {
          summary: "Smart search HTML",
          parameters: [queryParam, limitParam],
          responses: { "200": htmlResponse("Smart search viewer HTML") },
        },
      },
      "/smart-search": {
        get: {
          summary: "Smart search HTML",
          parameters: [queryParam, limitParam],
          responses: { "200": htmlResponse("Smart search viewer HTML") },
        },
      },
      "/docs/backlinks": {
        get: {
          summary: "Document backlinks HTML",
          parameters: [queryParam, ridParam],
          responses: { "200": htmlResponse("Doc backlinks viewer HTML") },
        },
      },
      "/docs/brief": {
        get: {
          summary: "Document brief HTML",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": htmlResponse("Doc brief viewer HTML") },
        },
      },
      "/docs/bundle": {
        get: {
          summary: "Document bundle HTML",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": htmlResponse("Doc bundle viewer HTML") },
        },
      },
      "/docs/evidence-pack": {
        get: {
          summary: "Document evidence pack HTML",
          parameters: [pathParam, ridParam, maxBytesParam],
          responses: { "200": htmlResponse("Doc evidence pack viewer HTML") },
        },
      },
      "/docs/reference-graph": {
        get: {
          summary: "Document reference graph HTML",
          responses: { "200": htmlResponse("Doc reference graph viewer HTML") },
        },
      },
      "/docs/related": {
        get: {
          summary: "Document related-docs HTML",
          parameters: [pathParam, ridParam],
          responses: { "200": htmlResponse("Doc related viewer HTML") },
        },
      },
      "/docs/search": {
        get: {
          summary: "Document search HTML",
          parameters: [queryParam, limitParam],
          responses: { "200": htmlResponse("Doc search viewer HTML") },
        },
      },
      "/hooks/coverage": {
        get: {
          summary: "Hook coverage HTML",
          responses: { "200": htmlResponse("Hook coverage viewer HTML") },
        },
      },
      "/extraction/status": {
        get: {
          summary: "Extraction status HTML",
          responses: { "200": htmlResponse("Extraction status viewer HTML") },
        },
      },
      "/api/workbench": {
        get: { summary: "Memory Workbench JSON", responses: { "200": jsonResponse("Workbench JSON") } },
      },
      "/api/dashboard": {
        get: { summary: "Memory operational dashboard JSON", responses: { "200": jsonResponse("Dashboard JSON") } },
      },
      "/api/references-radar": {
        get: { summary: "Memory references radar JSON", responses: { "200": jsonResponse("References radar JSON") } },
      },
      "/api/communities": {
        get: {
          summary: "Memory graph community analytics",
          responses: { "200": jsonResponse("Communities report") },
        },
      },
      "/communities": {
        get: {
          summary: "Memory graph communities HTML",
          responses: { "200": htmlResponse("Communities viewer HTML") },
        },
      },
      "/api/context-pack": {
        get: {
          summary: "Memory context pack JSON",
          parameters: [goalParam, optionalQueryParam, limitParam],
          responses: { "200": jsonResponse("Context pack") },
        },
      },
      "/context-pack": {
        get: {
          summary: "Memory context pack HTML",
          parameters: [goalParam, optionalQueryParam, limitParam],
          responses: { "200": htmlResponse("Context pack viewer HTML") },
        },
      },
      "/api/extraction/status": {
        get: { summary: "Memory extraction status", responses: { "200": jsonResponse("Extraction status report") } },
      },
      "/api/governance": {
        get: {
          summary: "Memory governance report",
          parameters: [staleProgressDaysParam],
          responses: { "200": jsonResponse("Governance report") },
        },
      },
      "/governance": {
        get: {
          summary: "Memory governance HTML",
          parameters: [staleProgressDaysParam],
          responses: { "200": htmlResponse("Governance viewer HTML") },
        },
      },
      "/api/handoff": {
        get: {
          summary: "Memory handoff report",
          parameters: [optionalQueryParam],
          responses: { "200": jsonResponse("Handoff report") },
        },
      },
      "/handoff": {
        get: {
          summary: "Memory handoff HTML",
          parameters: [optionalQueryParam],
          responses: { "200": htmlResponse("Handoff viewer HTML") },
        },
      },
      "/api/frontier": {
        get: {
          summary: "Memory work frontier report",
          parameters: [optionalQueryParam, limitParam],
          responses: { "200": jsonResponse("Work frontier report") },
        },
      },
      "/frontier": {
        get: {
          summary: "Memory work frontier HTML",
          parameters: [optionalQueryParam, limitParam],
          responses: { "200": htmlResponse("Work frontier viewer HTML") },
        },
      },
      "/api/decay": {
        get: {
          summary: "Memory decay plan",
          parameters: [staleDaysParam, deprecateDaysParam, limitParam],
          responses: { "200": jsonResponse("Memory decay plan") },
        },
      },
      "/decay": {
        get: {
          summary: "Memory decay plan HTML",
          parameters: [staleDaysParam, deprecateDaysParam, limitParam],
          responses: { "200": htmlResponse("Memory decay viewer HTML") },
        },
      },
      "/api/routing-guide": {
        get: {
          summary: "Memory routing guide",
          parameters: [agentParam],
          responses: { "200": jsonResponse("Memory routing guide") },
        },
      },
      "/routing-guide": {
        get: {
          summary: "Memory routing guide HTML",
          parameters: [agentParam],
          responses: { "200": htmlResponse("Memory routing guide viewer HTML") },
        },
      },
      "/api/integration-status": {
        get: {
          summary: "Memory agent integration status",
          parameters: [agentParam],
          responses: { "200": jsonResponse("Memory agent integration status") },
        },
      },
      "/integration-status": {
        get: {
          summary: "Memory agent integration status HTML",
          parameters: [agentParam],
          responses: { "200": htmlResponse("Memory agent integration status viewer HTML") },
        },
      },
      "/api/layers": {
        get: { summary: "Memory layers report", responses: { "200": jsonResponse("Memory layers report") } },
      },
      "/layers": {
        get: {
          summary: "Memory layers HTML",
          responses: { "200": htmlResponse("Memory layers viewer HTML") },
        },
      },
      "/api/learning-debt": {
        get: {
          summary: "Memory learning debt",
          responses: { "200": jsonResponse("Learning debt report") },
        },
      },
      "/api/map/freshness": {
        get: {
          summary: "Memory map freshness report",
          responses: { "200": jsonResponse("Memory map freshness report") },
        },
      },
      "/learning-debt": {
        get: {
          summary: "Memory learning debt HTML",
          responses: { "200": htmlResponse("Learning debt viewer HTML") },
        },
      },
      "/api/onboarding-map": {
        get: {
          summary: "Memory onboarding map",
          parameters: [staleDaysParam],
          responses: { "200": jsonResponse("Onboarding map report") },
        },
      },
      "/onboarding-map": {
        get: {
          summary: "Memory onboarding map HTML",
          parameters: [staleDaysParam],
          responses: { "200": htmlResponse("Onboarding map viewer HTML") },
        },
      },
      "/api/hooks/coverage": {
        get: { summary: "Hook coverage report", responses: { "200": jsonResponse("Hook coverage report") } },
      },
      "/api/session/timeline": {
        get: {
          summary: "Session timeline report",
          parameters: [sessionParam, limitParam],
          responses: { "200": jsonResponse("Session timeline report") },
        },
      },
      "/api/assets": {
        get: {
          summary: "Binary document/media asset inventory",
          parameters: [kindParam, optionalQueryParam],
          responses: { "200": jsonResponse("Asset inventory report") },
        },
      },
      "/api/docs/coverage": {
        get: {
          summary: "Document graph and vector coverage",
          responses: { "200": jsonResponse("Doc coverage report") },
        },
      },
      "/api/docs/brief": {
        get: {
          summary: "Citation-first document evidence brief",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc brief") },
        },
      },
      "/api/docs/bundle": {
        get: {
          summary: "Agent-ready document bundle for a query",
          parameters: [queryParam, limitParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc bundle") },
        },
      },
      "/api/docs/backlinks": {
        get: {
          summary: "Find indexed docs that reference a Memory node",
          parameters: [queryParam, ridParam],
          responses: { "200": jsonResponse("Doc backlinks report") },
        },
      },
      "/api/docs/evidence-pack": {
        get: {
          summary: "Agent-ready document evidence pack",
          parameters: [pathParam, ridParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc evidence pack") },
        },
      },
      "/api/docs/reference-graph": {
        get: {
          summary: "Document reference graph",
          responses: { "200": jsonResponse("Doc reference graph report") },
        },
      },
      "/api/docs/related": {
        get: {
          summary: "Find references and related docs for an ingested Memory doc",
          parameters: [pathParam, ridParam],
          responses: { "200": jsonResponse("Doc related report") },
        },
      },
      "/api/docs/search": {
        get: {
          summary: "Search ingested Memory docs",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Doc search result") },
        },
      },
      "/api/docs/read": {
        get: {
          summary: "Read an ingested Memory doc by path or rid",
          parameters: [pathParam, ridParam, maxBytesParam],
          responses: { "200": jsonResponse("Doc read result") },
        },
      },
      "/api/confidence": {
        get: {
          summary: "Composed confidence breakdown for a Memory node (issue #167)",
          parameters: [
            {
              name: "node",
              in: "query",
              required: true,
              description: "Numeric rid of the Memory node",
              schema: { type: "string" },
            },
          ],
          responses: { "200": jsonResponse("Confidence breakdown") },
        },
      },
      "/api/path-explain": {
        get: {
          summary: "Explain a directed Memory graph path",
          parameters: [fromParam, toParam, maxDepthParam],
          responses: { "200": jsonResponse("Path explanation result") },
        },
      },
      "/api/vector/status": {
        get: {
          summary: "Read vector projection status",
          responses: { "200": jsonResponse("Vector status report") },
        },
      },
      "/vector/status": {
        get: {
          summary: "Vector projection status HTML",
          responses: { "200": htmlResponse("Vector status viewer HTML") },
        },
      },
      "/api/vector/search": {
        get: {
          summary: "Diagnostic vector search",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Vector search report") },
        },
      },
      "/api/recall": {
        get: {
          summary: "Governed Memory recall",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Recall result") },
        },
      },
      "/api/search": {
        get: {
          summary: "Memory smart search",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Smart search result") },
        },
      },
      "/api/smart-search": {
        get: {
          summary: "Memory smart search",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Smart search result") },
        },
      },
      "/api/federate": {
        get: {
          summary: "Federation cross-root read",
          parameters: [queryParam, limitParam],
          responses: { "200": jsonResponse("Federation result") },
        },
      },
      "/api/whatif": {
        get: {
          summary: "What-if blast radius (repeatable ?change=<descriptor>)",
          parameters: [
            {
              name: "change",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            limitParam,
          ],
          responses: { "200": jsonResponse("What-if report") },
        },
        post: {
          summary: "What-if blast radius (JSON body {changes:[...]} )",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": jsonResponse("What-if report") },
        },
      },
      "/api/reasoning-replay": {
        get: {
          summary: "Reasoning replay (similarity-ranked attempts)",
          parameters: [
            {
              name: "task",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            limitParam,
          ],
          responses: { "200": jsonResponse("Reasoning replay result") },
        },
      },
      ...memoryOpenApiPathsForOperations(listReadOnlyMemoryOperations()),
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  };
}

function authorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function publicEndpoint(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname === "/openapi.json" ||
    pathname === "/api/openapi.json"
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body.trim()) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    throw new MemoryOperationTransportError("invalid JSON body");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function numberParam(value: string | null): number | undefined {
  return boundedIntParam(value, 100);
}

function boundedIntParam(value: string | null, max: number): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.min(max, Math.floor(parsed));
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  res.end(html);
}

function sendMarkdown(res: ServerResponse, markdown: string): void {
  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function markdownReport(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "markdown" in output) {
    const markdown = (output as { markdown?: unknown }).markdown;
    if (typeof markdown === "string") return markdown;
  }
  return `${JSON.stringify(output, null, 2)}\n`;
}
