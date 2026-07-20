#!/usr/bin/env node

/** PROTOTYPE terminal shell. The state machine lives in manager-portfolio-machine.ts. */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  applyManagerAction,
  createPrototypePortfolio,
  exportCheckpoint,
  importCheckpoint,
  type ManagerActor,
  type ManagerCheckpoint,
  type ManagerPortfolio,
} from "./manager-portfolio-machine.js";

const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

let state = createPrototypePortfolio();
let actor: ManagerActor = { hostId: "host-a", sessionId: "session-a" };
let checkpoint: ManagerCheckpoint | null = null;

function focusedEffort() {
  return state.efforts[state.focusEffortId]!;
}

function generation(): number {
  return focusedEffort().generation;
}

function projectionLine(repository: string): string {
  const item = focusedEffort().projections[repository]!;
  const ref = item.mapRef ?? "-";
  const failure = item.lastFailure ? ` failure=${item.lastFailure}` : "";
  return `  ${repository}: ${item.status} attempts=${item.attempts} map=${ref} owner-work=${item.ownerWork}${failure}`;
}

function render(): void {
  stdout.write("\x1b[2J\x1b[H");
  const effort = focusedEffort();
  const otherEfforts = Object.values(state.efforts)
    .filter((item) => item.id !== effort.id)
    .map(
      (item) =>
        `${item.id}:${item.lifecycle}@g${item.generation} lease=${item.lease?.sessionId ?? "-"}`,
    )
    .join(", ");

  console.log(`${bold}Manager portfolio transition explorer${reset} ${dim}(PROTOTYPE — in memory)${reset}`);
  console.log(`${bold}authority${reset}: ${state.authority.hostId}@epoch-${state.authority.epoch}`);
  console.log(`${bold}portfolio generation${reset}: ${state.portfolioGeneration}`);
  console.log(`${bold}current actor${reset}: ${actor.hostId}/${actor.sessionId}`);
  console.log(`${bold}sessions${reset}: ${JSON.stringify(state.sessions)}`);
  console.log(`${bold}checkpoint slot${reset}: ${checkpoint ? `exported@g${checkpoint.portfolioGeneration}` : "empty"}`);
  console.log(`${bold}other efforts${reset}: ${otherEfforts || "none"}`);
  console.log();
  console.log(`${bold}focused effort${reset}: ${effort.id} — ${effort.name}`);
  console.log(`${bold}destination${reset}: ${effort.destination}`);
  console.log(`${bold}lifecycle${reset}: ${effort.lifecycle}`);
  console.log(`${bold}generation${reset}: ${effort.generation}`);
  console.log(`${bold}lease${reset}: ${effort.lease ? JSON.stringify(effort.lease) : "none"}`);
  console.log(`${bold}unmaterialised intent${reset}: ${JSON.stringify(effort.unmaterialisedIntent)}`);
  console.log(`${bold}last transition${reset}: ${effort.lastTransition}`);
  console.log(`${bold}repository projections${reset}:`);
  console.log(Object.keys(effort.projections).map(projectionLine).join("\n"));
  console.log();
  console.log(
    `${bold}last result${reset}: ${state.lastResult.kind}/${state.lastResult.code} — ${state.lastResult.message}`,
  );
  console.log();
  console.log(`${bold}Transitions${reset}`);
  console.log("[r] resume/acquire lease  [e] end/pause  [c] crash session  [v] recover lease");
  console.log("[1] publish repo-red  [2] fail repo-blue  [3] retry repo-blue  [g] stale write");
  console.log("[x] export checkpoint  [i] import on host-b  [o] old-host write  [m] complete");
  console.log("[f] focus other effort  [z] reset  [q] quit");
}

function act(action: Parameters<typeof applyManagerAction>[1]): void {
  state = applyManagerAction(state, action);
}

function writeAction(
  action: Omit<Extract<Parameters<typeof applyManagerAction>[1], { effortId: string }>, "actor" | "expectedGeneration">,
): void {
  act({ ...action, actor, expectedGeneration: generation() } as Parameters<typeof applyManagerAction>[1]);
}

function chooseRepository(name: string): boolean {
  return Boolean(focusedEffort().projections[name]);
}

async function main(): Promise<void> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      render();
      const command = (await terminal.question(`${bold}>${reset} `)).trim().toLowerCase();
      if (command === "q") break;

      switch (command) {
        case "r":
          writeAction({ type: "resume", effortId: state.focusEffortId });
          break;
        case "e":
          writeAction({ type: "end", effortId: state.focusEffortId });
          break;
        case "c":
          act({ type: "crash-session", actor });
          break;
        case "v": {
          actor = { ...actor, sessionId: "recovery-session" };
          writeAction({ type: "recover-lease", effortId: state.focusEffortId });
          break;
        }
        case "1":
          if (chooseRepository("repo-red")) {
            writeAction({
              type: "publish-map",
              effortId: state.focusEffortId,
              repository: "repo-red",
              outcome: "published",
            });
          }
          break;
        case "2":
          if (chooseRepository("repo-blue")) {
            writeAction({
              type: "publish-map",
              effortId: state.focusEffortId,
              repository: "repo-blue",
              outcome: "failed",
            });
          }
          break;
        case "3":
          if (chooseRepository("repo-blue")) {
            writeAction({
              type: "publish-map",
              effortId: state.focusEffortId,
              repository: "repo-blue",
              outcome: "published",
            });
          }
          break;
        case "g":
          act({
            type: "publish-map",
            effortId: state.focusEffortId,
            repository: Object.keys(focusedEffort().projections)[0]!,
            outcome: "published",
            actor,
            expectedGeneration: Math.max(0, generation() - 1),
          });
          break;
        case "x":
          checkpoint = exportCheckpoint(state);
          break;
        case "i":
          if (checkpoint) {
            state = importCheckpoint(checkpoint, "host-b");
            actor = { hostId: "host-b", sessionId: "imported-session" };
          }
          break;
        case "o":
          act({
            type: "resume",
            effortId: state.focusEffortId,
            actor: { hostId: "host-a", sessionId: "source-session" },
            expectedGeneration: generation(),
          });
          break;
        case "m":
          writeAction({ type: "complete", effortId: state.focusEffortId });
          break;
        case "f":
          state = {
            ...state,
            focusEffortId:
              state.focusEffortId === "effort-alpha" ? "effort-beta" : "effort-alpha",
          };
          actor = {
            hostId: state.authority.hostId,
            sessionId: state.focusEffortId === "effort-alpha" ? "session-a" : "session-b",
          };
          break;
        case "z":
          state = createPrototypePortfolio();
          actor = { hostId: "host-a", sessionId: "session-a" };
          checkpoint = null;
          break;
      }
    }
  } finally {
    terminal.close();
  }
}

await main();
