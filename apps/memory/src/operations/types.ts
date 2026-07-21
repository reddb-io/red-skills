import type { z } from "zod";
import type { MemoryConfig } from "../config.js";
import type { AiProviderConfig } from "../extract-conversation.js";
import type { MemoryStore } from "../graph-store.js";

export type MemoryOperationSafetyClass = "read-only" | "mutating";
export type MemoryOperationSideEffectClass = "none" | "cache-write" | "writes-memory";
export type MemoryOperationCapability = "graph-store";
export type MemoryOperationTransport = "cli" | "mcp" | "http";
export type MemoryOperationInputSource = "positional" | "flag" | "query";
export type MemoryOperationInputType =
  | "string"
  | "number"
  | "boolean"
  | "string-array"
  | "object-array"
  | "path";
export type MemoryOperationReportFormat = "json" | "markdown";

export interface MemoryOperationTransportInput {
  positional: readonly string[];
  flags: Readonly<Record<string, unknown>>;
  query: Readonly<Record<string, unknown>>;
  body?: unknown;
  rootDir?: string;
}

export interface MemoryOperationInputFieldBinding {
  field: string;
  sources: readonly MemoryOperationInputSource[];
  type: MemoryOperationInputType;
  required?: boolean;
  position?: number;
  variadic?: boolean;
}

export interface MemoryOperationCustomInputBind {
  id: string;
  description: string;
  bind: (input: MemoryOperationTransportInput) => Record<string, unknown>;
}

export interface MemoryOperationInputBinding {
  fields: readonly MemoryOperationInputFieldBinding[];
  customBind?: MemoryOperationCustomInputBind;
}

export interface MemoryOperationFileSinkBinding {
  field: string;
  sources: readonly ("flag" | "query")[];
  type: "path";
  required?: boolean;
  customBind?: {
    id: string;
    description: string;
    bind: (input: MemoryOperationTransportInput) => string | undefined;
  };
}

export type MemoryOperationOutputKind =
  | {
      kind: "report";
      format: MemoryOperationReportFormat;
    }
  | {
      kind: "viewer";
      artifact: "self-contained-html";
      fileSink?: MemoryOperationFileSinkBinding;
    };

export interface MemoryOperationFacets {
  inputBinding: MemoryOperationInputBinding;
  outputKind: MemoryOperationOutputKind;
}

export interface MemoryOperationRendererMetadata {
  cli: {
    command: string;
    supportsJson: boolean;
    defaultFormat?: "json" | "toon";
    reservedSubcommands?: readonly string[];
    presentation?: {
      render: (output: unknown, input: MemoryOperationTransportInput) => string;
      jsonOutput?: (output: unknown) => unknown;
      viewerSink?: "default" | "explicit";
    };
  };
  mcp: {
    toolName: string;
    /** @deprecated Use the operation-owned description. */
    description?: string;
  };
  http?: {
    route?: string;
    aliases?: readonly string[];
    methods?: readonly ("GET" | "POST")[];
  };
}

export interface MemoryOperationContext {
  store: MemoryStore;
  rootDir?: string;
  now?: number;
  memoryConfig?: MemoryConfig;
  providerConfig?: AiProviderConfig;
  transportSurface?: string;
}

export interface MemoryOperationDefinition<Input, Output> extends Partial<MemoryOperationFacets> {
  id: string;
  title: string;
  description: string;
  inputSchema: z.ZodType<Input, z.ZodTypeDef, unknown>;
  outputSchema: z.ZodType<Output, z.ZodTypeDef, unknown>;
  safetyClass: MemoryOperationSafetyClass;
  sideEffectClass: MemoryOperationSideEffectClass;
  capabilities: readonly MemoryOperationCapability[];
  transports?: readonly MemoryOperationTransport[];
  renderer: MemoryOperationRendererMetadata;
  execute: (ctx: MemoryOperationContext, input: Input) => Promise<Output>;
}

export type MemoryOperation<Input, Output> = Omit<
  MemoryOperationDefinition<Input, Output>,
  "transports" | "inputBinding" | "outputKind"
> &
  MemoryOperationFacets & {
    transports: readonly MemoryOperationTransport[];
  };

export type ReadOnlyMemoryOperation<Input = unknown, Output = unknown> = MemoryOperation<
  Input,
  Output
> & {
  safetyClass: "read-only";
  sideEffectClass: "none" | "cache-write";
};

export interface ReadOnlyMemoryOperationRegistry {
  list(): ReadOnlyMemoryOperation[];
  get(id: string): ReadOnlyMemoryOperation;
  execute(id: string, ctx: MemoryOperationContext, input: unknown): Promise<unknown>;
}
