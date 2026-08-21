// The harvest deadline over ACP (#4170, Spec #4164).
//
// Black-box, at the two seams a client actually reaches: what the daemon
// ANSWERS about a drain on `_redskills/project_status`, and what the landing
// lane does while that answer says the drain has stopped admitting. Nothing
// here reaches inside the daemon — the registration arrives over the socket as
// a client states it, the admission plan is the daemon's own planner, and the
// landing is the daemon's own `_redskills/land` body.
//
// The clock is injected, so "past 70% of the budget" costs no wall time: a
// suite that slept through a real budget would be pinning the machine's
// patience rather than the policy.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type ClientConnection } from "@agentclientprotocol/sdk";
import { socketStream } from "@reddb-io/protocol-acp";
import { afterEach, describe, expect, it } from "vitest";

import type { RedskillsProjectStatusSnapshot } from "../src/acp-client.js";
import { startRedskillsAcpControlPlane } from "../src/acp-control-plane.js";
import { bindAcpWorkerLand, landParams } from "../src/acp-publication.js";
import {
  createRedskilledGithubGateway,
  type RedskilledGithubGatewayRegistration,
} from "../src/github-gateway.js";
import { planHostDemand } from "../src/demand-loop.js";
import { foldProjectHarvest, harvestPlanFields, type RedskilledHarvestTally } from "../src/harvest-deadline.js";
import { buildHostState, type RedskilledHostState } from "../src/host-state.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { buildProjectRegistration, type RedskilledProjectRegistration } from "../src/project-registration.js";
import { resolveAcpProjectIdentity } from "../src/project-workspace.js";

const REGISTERED_AT = "2026-08-21T22:00:00.000Z";
const BUDGET_MS = 3_600_000;
/** 0.7 of the budget, to the millisecond: admission stops here. */
const HARVEST_AT = new Date(Date.parse(REGISTERED_AT) + BUDGET_MS * 0.7).toISOString();
const BEFORE_HARVEST = new Date(Date.parse(HARVEST_AT) - 60_000).toISOString();

const roots: string[] = [];
const gateways: { close?(): void }[] = [];

/**
 * A checkout the daemon can name `owner/name`.
 *
 * The landing lane refuses a Project without a canonical repository identity,
 * and rightly so — a credential is scoped to a repository. The fixture is a git
 * checkout with a remote, so the drain and the landing are the SAME project
 * rather than two labels that happen to be tested together.
 */
async function fixtureCheckout(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", "--initial-branch", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "remote", "add", "origin", "https://github.com/acme/widgets.git"], {
    stdio: "ignore",
  });
  return root;
}

afterEach(async () => {
  for (const gateway of gateways.splice(0)) gateway.close?.();
  // Retried: the custodian's record lands asynchronously after a handoff
  // returns, so a removal racing that write sees ENOTEMPTY once and succeeds
  // on the next pass — a fixture that failed there would fail the assertions
  // it already passed.
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  ));
});

describe("a budgeted drain over ACP", () => {
  it("refuses a new claim past the harvest fraction while a landing in flight completes", async () => {
    const root = await fixtureCheckout("redskilled-harvest-");
    const identity = await resolveAcpProjectIdentity(root, { env: {} });
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });

    let now = REGISTERED_AT;
    const registrations = new Map<string, RedskilledProjectRegistration>();
    const tallies: Record<string, RedskilledHarvestTally> = {};
    const control = await startRedskillsAcpControlPlane({
      paths,
      clock: () => now,
      startWorker: () => {
        throw new Error("a harvesting drain must birth no Worker");
      },
      // The daemon's own registration path, exactly as the lifecycle hands it in.
      registerProject: (request) => {
        const held = buildProjectRegistration(request, { now });
        registrations.set(held.project_label, held);
        return held;
      },
      hostState: () => hostState(identity.projectLabel, registrations, tallies, now),
    });

    let connection: ClientConnection | undefined;
    try {
      const connected = await connectProject(control.socketPath, root);
      connection = connected.connection;

      // The operator declares the budget on the drain registration, and on
      // nothing else: the daemon arms the deadline off this number alone.
      await connection.agent.request("_redskills/project_drain", {
        registration: {
          selector: `repo:${identity.projectLabel} label:ready-for-agent`,
          argv: ["redskilled", "acp-worker"],
          workspace_path: root,
          target: 2,
          budget_ms: BUDGET_MS,
        },
      });
      expect(registrations.get(identity.projectLabel)?.budget_ms).toBe(BUDGET_MS);

      now = BEFORE_HARVEST;
      const admitting = await connection.agent.request<RedskillsProjectStatusSnapshot>(
        "_redskills/project_status",
        {},
      );
      expect(admitting.context.harvest.state).toBe("admitting");
      expect(admitting.context.queue.posture).toBe("asking");
      expect(admitting.context.queue.wanted).toBe(1);

      // One Worker of the pair has ended, reporting a terminal outcome on its
      // work — the drain's yield so far.
      foldProjectHarvest(tallies, identity.projectLabel, "work-reported");

      now = HARVEST_AT;
      const harvesting = await connection.agent.request<RedskillsProjectStatusSnapshot>(
        "_redskills/project_status",
        {},
      );

      // No new claim: the planner admits nothing and says why.
      expect(harvesting.context.queue.posture).toBe("harvest-deadline");
      expect(harvesting.context.queue.wanted).toBe(0);
      expect(harvesting.context.queue.detail).toContain("no new claim is admitted");
      // The drain summary names both sides of the ledger: one unit brought back,
      // and the one live Worker plus the four queued items the budget leaves.
      expect(harvesting.context.harvest).toMatchObject({
        state: "harvesting",
        budget_ms: BUDGET_MS,
        harvest_fraction: 0.7,
        harvest_at: HARVEST_AT,
        harvested: 1,
        stranded: 5,
      });
      // The Worker in flight is untouched — it is what the harvest is for.
      expect(harvesting.context.workers.total).toBe(1);

      // …and its landing still completes, on the same daemon, at the same
      // instant the admission is refusing.
      const land = bindAcpWorkerLand({
        gateway: landingGateway(root),
        held: () => ({
          workerId: "0000000Worker",
          worktreePath: join(root, "worktree"),
          project: {
            projectId: identity.projectId,
            projectLabel: identity.projectLabel,
            checkoutRoot: root,
            workspacePath: root,
          },
        }),
      });
      const landed = await land({
        params: landParams({
          idempotency_key: "worker-land:harvest:1",
          branch: "afk/4170-harvest",
          commit: "1a23b45c".repeat(5),
          base: "main",
          title: "The harvest lands what is in flight",
          body: "Refs #4170",
          owner_ticket: 4170,
        }),
      });

      expect(landed.pull_request).toBe(73);
      expect(landed.custody_state).toBe("active");
    } finally {
      connection?.close();
      await control.close();
    }
  }, 30_000);

  it("arms nothing at all for a drain that declared no budget", async () => {
    const root = await fixtureCheckout("redskilled-harvest-inert-");
    const identity = await resolveAcpProjectIdentity(root, { env: {} });
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });

    let now = REGISTERED_AT;
    const registrations = new Map<string, RedskilledProjectRegistration>();
    const control = await startRedskillsAcpControlPlane({
      paths,
      clock: () => now,
      startWorker: () => {
        throw new Error("this test births no Worker");
      },
      registerProject: (request) => {
        const held = buildProjectRegistration(request, { now });
        registrations.set(held.project_label, held);
        return held;
      },
      hostState: () => hostState(identity.projectLabel, registrations, {}, now),
    });

    let connection: ClientConnection | undefined;
    try {
      const connected = await connectProject(control.socketPath, root);
      connection = connected.connection;
      await connection.agent.request("_redskills/project_drain", {
        registration: {
          selector: `repo:${identity.projectLabel} label:ready-for-agent`,
          argv: ["redskilled", "acp-worker"],
          workspace_path: root,
          target: 2,
        },
      });

      // A whole budget's worth of time later, and then some: with nothing
      // declared there is no deadline to pass.
      now = new Date(Date.parse(REGISTERED_AT) + BUDGET_MS * 10).toISOString();
      const status = await connection.agent.request<RedskillsProjectStatusSnapshot>(
        "_redskills/project_status",
        {},
      );

      expect(status.context.harvest).toMatchObject({
        state: "inert",
        budget_ms: null,
        harvest_at: null,
        deadline_at: null,
      });
      expect(status.context.queue.posture).toBe("asking");
      expect(status.context.queue.wanted).toBe(1);
    } finally {
      connection?.close();
      await control.close();
    }
  }, 30_000);
});

/**
 * The host document, composed the way the daemon composes it: the held
 * registration, one live Worker, the last poll, and the planner's own answer.
 */
function hostState(
  projectLabel: string,
  registrations: ReadonlyMap<string, RedskilledProjectRegistration>,
  harvest: Readonly<Record<string, RedskilledHarvestTally>>,
  now: string,
): RedskilledHostState {
  const held = [...registrations.values()];
  const live = { [projectLabel]: 1 };
  const queue = {
    version: 1 as const,
    fetched_at: now,
    request_count: 1,
    project_count: held.length,
    batch_size: 1,
    rate_limit: { remaining: 4_000, reset_at: null, exhausted: false },
    projects: held.map((registration) => ({
      project_label: registration.project_label,
      outcome: "counted" as const,
      depth: 4,
      detail: "four eligible Tickets",
    })),
  };
  const plan = planHostDemand({
    projects: held.map((registration) => ({
      project_label: registration.project_label,
      selector: registration.selector,
      argv: registration.argv,
      workspace_path: registration.workspace_path,
      target: registration.target,
      ...harvestPlanFields(registration),
    })),
    queue: Object.fromEntries(held.map((registration) => [registration.project_label, 4])),
    live,
    nowMs: Date.parse(now),
  });
  return buildHostState({
    daemonVersion: "0.0.0-test",
    machineIdHash: "machine",
    sessionKeyHash: "session",
    pid: process.pid,
    startedAt: REGISTERED_AT,
    workers: [{
      worker_id: "0000000Worker",
      project_label: projectLabel,
      pid: process.pid,
      started_at: REGISTERED_AT,
      workspace_path: "[DAEMON_WORKSPACE]",
      isolated: true,
      warnings: [],
    }],
    registrations: held,
    queue,
    harvest,
    demand: {
      version: 1,
      at: now,
      requested: plan.births.length,
      granted: [],
      shortfall: 0,
      refusal: null,
      retry_after: null,
      projects: plan.intents,
    },
    now,
  });
}

/** A gateway that opens the pull request without a network and without a credential. */
function landingGateway(root: string): RedskilledGithubGatewayRegistration {
  const gateway = createRedskilledGithubGateway({
    upstream: async () => ({ value: {}, budget: null }),
    outboxPath: join(root, "github-outbox.toon"),
    custodyPath: join(root, "github-custody.toon"),
    // Long enough that a landing which awaited the merge would time this out.
    custodyTickMs: 3_600_000,
    writeUpstream: async ({ write }) => write.kind === "pull-request" ? { number: 73 } : {},
    custodyUpstream: {
      observe: async () => ({ forge_state: "open-clean", native_intent: false }),
      arm: async () => ({ forge_state: "open-pending", native_intent: true }),
    },
  });
  gateways.push(gateway);
  return {
    gateway,
    credentialForProject: () => ({ profile: "engineering", credential: { secret: "fixture-secret" } }),
  };
}

async function connectProject(
  socketPath: string,
  cwd: string,
): Promise<{ readonly connection: ClientConnection; readonly sessionId: string }> {
  const socket = connect(socketPath);
  await once(socket, "connect");
  const connection = client({ name: "Harvest deadline contract" }).connect(socketStream(socket));
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "Harvest deadline contract", version: "1" },
  });
  const session = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] });
  return { connection, sessionId: session.sessionId };
}
