import { RequestError } from "@agentclientprotocol/sdk";
import { REDSKILLS_ACP_METHODS, emptyRedskillsParams } from "@reddb-io/protocol-acp";
import {
  type RedskilledGithubBudgetGateway,
  type RedskilledGithubGateway,
  type RedskilledGithubGatewayRegistration,
  type RedskilledGithubHostBudgetProjection,
  type RedskilledGithubProjectBudgetProjection,
} from "./github-gateway.js";
import {
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import { RedskilledGithubCredentialProfileError } from "./github-credential-profiles.js";

export const REDSKILLED_PROJECT_BUDGET_METHOD = REDSKILLS_ACP_METHODS.projectBudget;
export const REDSKILLED_HOST_BUDGET_METHOD = REDSKILLS_ACP_METHODS.hostBudgets;

type EmptyParams = Record<string, never>;

/** Project authority can observe only the profile selected by daemon policy. */
export function bindAcpProjectGithubBudget(
  registration: RedskilledGithubGatewayRegistration | undefined,
  projectForConnection: () => AcpProjectWorkspace,
) {
  return async (_request: { readonly params: EmptyParams }): Promise<RedskilledGithubProjectBudgetProjection> => {
    const project = projectForConnection();
    try {
      const selection = await registration?.credentialForProject({
        projectId: project.projectId,
        projectLabel: project.projectLabel,
        workspacePath: project.workspacePath,
      });
      const budgets = budgetGateway(registration?.gateway);
      if (selection == null || budgets == null) {
        throw RequestError.authRequired(
          { version: 1, kind: "github-credential-profile", reason: "missing-credentials" },
          "this Project has no observable daemon-owned GitHub credential budget",
        );
      }
      return budgets.projectBudget({
        projectId: project.projectId,
        projectLabel: project.projectLabel,
        workspacePath: project.workspacePath,
        credentialProfile: selection.profile,
      });
    } catch (error) {
      if (error instanceof RedskilledGithubCredentialProfileError) {
        throw RequestError.authRequired(error.refusal, error.message);
      }
      throw error;
    }
  };
}

/** Host-wide facts require an endpoint explicitly started with administrative authority. */
export function bindAcpHostGithubBudget(
  registration: RedskilledGithubGatewayRegistration | undefined,
  hostAdministration: boolean,
) {
  return async (_request: { readonly params: EmptyParams }): Promise<RedskilledGithubHostBudgetProjection> => {
    if (!hostAdministration) {
      throw RequestError.invalidRequest(
        "this project-scoped ACP connection has no host-administrative authority",
      );
    }
    const budgets = budgetGateway(registration?.gateway);
    if (budgets == null) {
      throw RequestError.invalidRequest("GitHub credential-budget projection is unavailable");
    }
    return budgets.hostBudget();
  };
}

/** Both budget methods accept exactly an empty object; authority is never caller-named. */
export const emptyBudgetParams: (value: unknown) => EmptyParams = emptyRedskillsParams(
  "credential-budget requests accept no caller-controlled authority fields",
);

function budgetGateway(gateway: RedskilledGithubGateway | undefined): RedskilledGithubBudgetGateway | null {
  if (gateway == null || !("projectBudget" in gateway) || !("hostBudget" in gateway)) return null;
  return gateway as RedskilledGithubBudgetGateway;
}

export interface AcpBudgetDomainDeps {
  readonly gateway: RedskilledGithubGatewayRegistration | undefined;
  readonly scopedProject: () => AcpProjectWorkspace;
  /** Explicit endpoint authority; ordinary project ACP stays false. */
  readonly hostAdministration: boolean;
}

/**
 * The `budget` domain: what one Project may observe of its own credential
 * spend, plus the host-wide projection an administrative endpoint may read.
 *
 * The host method is advertised only where it is answerable. A connection that
 * sees `host_budgets` in the capability block and is then refused for lacking
 * authority learned nothing it could act on; one that never sees it knows the
 * endpoint it dialed is not the administrative one.
 */
export function budgetMethodDomain(deps: AcpBudgetDomainDeps): RedskillsAcpMethodDomain {
  const readProjectBudget = bindAcpProjectGithubBudget(deps.gateway, deps.scopedProject);
  const readHostBudget = bindAcpHostGithubBudget(deps.gateway, deps.hostAdministration);
  return {
    domain: "budget",
    bindings: [
      redskillsAcpMethod(REDSKILLED_PROJECT_BUDGET_METHOD, emptyBudgetParams, readProjectBudget),
      redskillsAcpMethod(REDSKILLED_HOST_BUDGET_METHOD, emptyBudgetParams, readHostBudget),
    ],
    ...(deps.gateway == null ? {} : {
      capability: {
        credentialBudgets: {
          version: 1,
          methods: [
            REDSKILLED_PROJECT_BUDGET_METHOD,
            ...(deps.hostAdministration ? [REDSKILLED_HOST_BUDGET_METHOD] : []),
          ],
        },
      },
    }),
  };
}
