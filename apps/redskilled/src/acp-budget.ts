import { RequestError } from "@agentclientprotocol/sdk";
import {
  type RedskilledGithubBudgetGateway,
  type RedskilledGithubGateway,
  type RedskilledGithubGatewayRegistration,
  type RedskilledGithubHostBudgetProjection,
  type RedskilledGithubProjectBudgetProjection,
} from "./github-gateway.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";
import { RedskilledGithubCredentialProfileError } from "./github-credential-profiles.js";

export const REDSKILLED_PROJECT_BUDGET_METHOD = "_redskills/project_budget";
export const REDSKILLED_HOST_BUDGET_METHOD = "_redskills/host_budgets";

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
export function emptyBudgetParams(value: unknown): EmptyParams {
  if (value == null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
    throw RequestError.invalidParams({}, "credential-budget requests accept no caller-controlled authority fields");
  }
  return {};
}

function budgetGateway(gateway: RedskilledGithubGateway | undefined): RedskilledGithubBudgetGateway | null {
  if (gateway == null || !("projectBudget" in gateway) || !("hostBudget" in gateway)) return null;
  return gateway as RedskilledGithubBudgetGateway;
}
