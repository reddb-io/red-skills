// A dispatcher, so a test can kill one (#3027).
//
// The property under test — "killing the dispatching process leaves the worker
// running" — cannot be asserted from inside the test process, because the test
// process IS the dispatcher and cannot survive its own SIGKILL. So the dispatch
// happens here, in a process the test owns and can kill, running the REAL
// `goCommand` against the REAL birth port. Only the two effects that would need
// a network are faked: the label and the minted issue.
//
// It prints the dispatch answer and then idles, so the kill lands on a
// dispatcher that is genuinely still alive rather than on one that had already
// exited by itself.

import { goCommand, type GoRuntime } from "../../src/commands/go.js";
import { requestWorkerBirth } from "../../src/runtime/mcp-worker-birth.js";
import { armTestProcessLifetime } from "./test-process-lifetime.js";

armTestProcessLifetime();

const workspace = process.argv[2];
if (!workspace) throw new Error("go-dispatch-dispatcher: a workspace path is required");

/** A Worker that outlives the dispatcher on purpose, and dies on its own. */
const IDLE_WORKER = ["-e", "setTimeout(() => undefined, 120_000);"];

const runtime: GoRuntime = {
  ensureLabel: async () => undefined,
  createGoIssue: async () => 3027,
  createScoutIssue: async () => 3027,
  birthWorker: (args) =>
    requestWorkerBirth(workspace, args, {
      projectLabel: "acme/widgets",
      entry: [process.execPath, ...IDLE_WORKER],
    }),
  runEngineAttached: async () => {
    throw new Error("the default dispatch must not run the engine in the dispatcher");
  },
  hasHarness: false,
  // The engine floor is not what this dispatcher exercises, and a real registry
  // read here would make a survival test depend on the network (#3031).
  checkEngineFloor: async () => ({
    decision: "proceed",
    code: "disabled",
    policy: "off",
    engine_version: null,
    published_version: null,
    published_source: null,
    message: "",
  }),
  write: (text) => process.stdout.write(text),
};

const code = await goCommand(["--scout", "does the worker survive its dispatcher?"], workspace, runtime);
process.stdout.write(`exit ${code}\n`);
// Still here when the signal arrives — the point of the test.
setInterval(() => undefined, 1_000);
