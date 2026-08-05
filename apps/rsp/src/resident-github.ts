import { join } from "node:path";
import {
  createGithubAttributionLedger,
  createGithubClient,
  isGithubRateLimitError,
  routeGithubArgs,
  type GithubClient,
  type GithubOperation,
  type GithubRequestFetch,
} from "@reddb-io/github";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";

export interface RspResidentGithubRead {
  readonly args: readonly string[];
  readonly path: string;
  readonly params?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly actor: string;
}

export interface RspResidentGithubResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly surface: GithubOperation["surface"];
  readonly pool: GithubOperation["budget"];
  readonly quotaFree: boolean;
  readonly refused?: true;
}

export interface RspResidentGithubClient {
  read(input: RspResidentGithubRead): Promise<RspResidentGithubResult>;
}

export interface CreateRspResidentGithubClientOptions {
  readonly rootDir: string;
  readonly token: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: GithubRequestFetch;
  readonly retryCount?: number;
  readonly throttle?: boolean;
}

/**
 * The resident-lifetime GitHub read boundary.
 *
 * The Octokit client and its in-memory validator store are deliberately created
 * once here. CLI wrappers are short lived, but the resident survives across
 * them, so the second unchanged read can earn GitHub's zero-cost 304 response.
 * The attribution ledger lives below rsp's own state tier; no redskilled path or
 * process is imported by this module.
 */
export function createRspResidentGithubClient(
  options: CreateRspResidentGithubClientOptions,
): RspResidentGithubClient {
  const attribution = createGithubAttributionLedger({
    path: join(rspStateDir(options.rootDir), "github", "spend.toonl"),
  });
  const client = createGithubClient({
    token: options.token,
    attribution,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.retryCount === undefined ? {} : { retryCount: options.retryCount }),
    ...(options.throttle === undefined ? {} : { throttle: options.throttle }),
  });

  return createRspResidentGithubReader(client);
}

function createRspResidentGithubReader(client: GithubClient): RspResidentGithubClient {
  return {
    async read(input): Promise<RspResidentGithubResult> {
      const operation = routeGithubArgs(input.args);
      if (operation.kind !== "read") {
        return refusal(operation, "github-write-passthrough", "writes are executed by the original gh command unchanged");
      }
      if (input.actor.trim() === "") {
        return refusal(operation, "github-actor-missing", "retry through rsp so the caller can be attributed");
      }
      // Search has its own minute pool. It must never become the escape hatch
      // when REST or GraphQL is scarce, and rsp has no search fallback at all.
      if (operation.budget === "search") {
        return refusal(operation, "github-search-not-routable", "search reads are never a fallback; narrow the read to a classified object");
      }
      if (operation.surface !== "rest") {
        return refusal(
          operation,
          "github-graphql-read-not-realized",
          "use a classified rsp summary whose GraphQL projection is declared",
        );
      }

      try {
        const answer = await client.conditionalRest<unknown>({
          cacheKey: stableCacheKey(input.path, input.params),
          route: `GET /${input.path.replace(/^\/+/, "")}`,
          parameters: definedParams(input.params),
          operation,
          actor: input.actor,
        });
        return {
          status: 0,
          stdout: JSON.stringify(answer.data),
          stderr: "",
          surface: operation.surface,
          pool: operation.budget,
          quotaFree: answer.quotaFree,
        };
      } catch (error) {
        if (isGithubRateLimitError(error)) {
          return refusal(
            operation,
            "github-budget-refused",
            "wait for the reported GitHub rate-limit reset, then retry",
          );
        }
        return {
          status: errorStatus(error),
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
          surface: operation.surface,
          pool: operation.budget,
          quotaFree: false,
        };
      }
    },
  };
}

function refusal(operation: GithubOperation, reason: string, repair: string): RspResidentGithubResult {
  return {
    status: 75,
    stdout: "",
    stderr: JSON.stringify({
      refused: true,
      reason,
      operation: operation.key,
      pool: operation.budget,
      repair,
    }),
    surface: operation.surface,
    pool: operation.budget,
    quotaFree: false,
    refused: true,
  };
}

function stableCacheKey(
  path: string,
  params: RspResidentGithubRead["params"],
): string {
  return JSON.stringify({
    path,
    params: Object.entries(params ?? {})
      .filter((entry) => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  });
}

function definedParams(
  params: RspResidentGithubRead["params"],
): Readonly<Record<string, string | number | boolean>> {
  return Object.fromEntries(
    Object.entries(params ?? {}).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

function errorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status > 0) return status;
  }
  return 1;
}
