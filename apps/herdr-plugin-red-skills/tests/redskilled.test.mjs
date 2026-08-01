import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isHostEvent, parseEventLane, readEventLane, splitRow } from "../src/redskilled/event-lane.mjs";
import { REDSKILLED_SOCKET_FILE, resolveRedskilledPaths, resolveSessionKey, runtimeSocketDir } from "../src/redskilled/paths.mjs";
import { repositoryFromRemote } from "../src/redskilled/project-identity.mjs";
import { DEFAULT_CONFIG, configDir, mergeConfig, stateDir } from "../src/config.mjs";

test("the session key follows the daemon's own precedence", () => {
  assert.equal(resolveSessionKey({ REDSKILLED_SESSION: " pinned ", XDG_RUNTIME_DIR: "/run/user/1000" }), "pinned");
  assert.equal(resolveSessionKey({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000");
  assert.match(resolveSessionKey({}), /^uid:/);
});

test("the runtime dir is the daemon's derivation, hash for hash", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  const hash = createHash("sha256").update("redskilled:/run/user/1000").digest("hex").slice(0, 20);
  const dir = runtimeSocketDir({ key: "redskilled:/run/user/1000", socketFileName: REDSKILLED_SOCKET_FILE, env });
  assert.equal(dir, join("/run/user/1000", "red-skills", hash));
});

test("a long XDG path falls back to tmpdir so the socket still fits sun_path", () => {
  const env = { XDG_RUNTIME_DIR: `/run/user/${"x".repeat(90)}` };
  const dir = runtimeSocketDir({ key: "redskilled:long", socketFileName: REDSKILLED_SOCKET_FILE, env });
  assert.ok(!dir.startsWith(env.XDG_RUNTIME_DIR), "a path the kernel refuses to bind is not an option");
});

test("an explicit socket wins over every derivation, and says so", () => {
  const pinned = resolveRedskilledPaths({ env: { REDSKILLED_SOCKET: "/tmp/rs.sock", XDG_RUNTIME_DIR: "/run/user/1000" } });
  assert.equal(pinned.socketPath, "/tmp/rs.sock");
  assert.equal(pinned.source, "REDSKILLED_SOCKET");

  const configured = resolveRedskilledPaths({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, socketPath: "/tmp/other.sock" });
  assert.equal(configured.socketPath, "/tmp/other.sock");
  assert.equal(configured.source, "config.socketPath");

  // The lane lives beside the socket, so pinning one moves the other. Without
  // this the event view would read one daemon's directory while every socket
  // read reached another's.
  assert.equal(pinned.eventLanePath, "/tmp/redskilled.events.toonl");
  assert.equal(pinned.runtimeDir, "/tmp");
  assert.ok(pinned.derivedRuntimeDir.includes("red-skills"), "the derivation is still reported, for the doctor");

  const derived = resolveRedskilledPaths({ env: { XDG_RUNTIME_DIR: "/run/user/1000" } });
  assert.equal(derived.socketPath, derived.derivedSocketPath);
  assert.equal(derived.source, "derived from XDG_RUNTIME_DIR");
  assert.ok(derived.eventLanePath.endsWith("redskilled.events.toonl"));
});

test("splitRow honours quoted cells and their escapes", () => {
  assert.deepEqual(splitRow("1,ada,x"), ["1", "ada", "x"]);
  assert.deepEqual(splitRow('1,"a,b",c'), ["1", "a,b", "c"]);
  assert.deepEqual(splitRow('1,"say \\"hi\\"",c'), ["1", 'say "hi"', "c"]);
});

test("the event lane decodes a TOONL segment and follows a rotation", () => {
  const lane = [
    "{version,ts,event,worker_id,project_label,pid,exit_code}:",
    "  1,2026-07-31T10:00:00.000Z,worker-birth,w-1,reddb-io/red-skills,4242,",
    "[=1]",
    "{version,ts,event,worker_id,project_label,pid,exit_code}:",
    "  1,2026-07-31T10:05:00.000Z,worker-death,w-1,reddb-io/red-skills,4242,0",
    "",
  ].join("\n");
  const records = parseEventLane(lane);
  assert.equal(records.length, 2);
  assert.equal(records[0].event, "worker-birth");
  assert.equal(records[0].pid, 4242);
  assert.equal(records[0].exit_code, null, "an empty cell is an absence, never a zero");
  assert.equal(records[1].exit_code, 0);
  assert.ok(records.every(isHostEvent));
});

test("a line the reader cannot decode is kept as raw text, never dropped", () => {
  const records = parseEventLane("  1,2026-07-31T10:00:00.000Z,worker-birth,w-1\n");
  assert.equal(records.length, 1);
  assert.equal(records[0]._undecoded, true);
  assert.ok(records[0]._raw.includes("worker-birth"));
});

test("the event lane also accepts JSON lines, as the daemon's decoder does", () => {
  const records = parseEventLane('{"version":1,"ts":"2026-07-31T10:00:00.000Z","event":"worker-death","worker_id":"w-9"}\n');
  assert.equal(records.length, 1);
  assert.ok(isHostEvent(records[0]));
  assert.equal(records[0].worker_id, "w-9");
});

test("an absent lane is an empty history, not a failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "red-skills-test-"));
  const missing = await readEventLane(join(dir, "nope.toonl"));
  assert.equal(missing.exists, false);
  assert.deepEqual(missing.records, []);

  const path = join(dir, "redskilled.events.toonl");
  await writeFile(path, "{version,ts,event,worker_id}:\n  1,2026-07-31T10:00:00.000Z,worker-birth,w-1\n");
  const present = await readEventLane(path);
  assert.equal(present.exists, true);
  assert.equal(present.records.length, 1);
});

test("a project label is read off a remote in every URL form", () => {
  assert.equal(repositoryFromRemote("git@github.com:reddb-io/red-skills.git"), "reddb-io/red-skills");
  assert.equal(repositoryFromRemote("https://github.com/reddb-io/red-skills"), "reddb-io/red-skills");
  assert.equal(repositoryFromRemote("ssh://git@github.com/reddb-io/red-skills.git\n"), "reddb-io/red-skills");
  assert.equal(repositoryFromRemote(""), null);
});

test("a hand-run command finds the same config directory the pane is handed", () => {
  const inPane = { HERDR_PLUGIN_CONFIG_DIR: "/given/by/herdr", HERDR_PLUGIN_STATE_DIR: "/given/state" };
  assert.equal(configDir(inPane), "/given/by/herdr");
  assert.equal(stateDir(inPane), "/given/state");

  // Run by hand — which is exactly when someone is checking what the pane reads
  // — the env vars are absent and the fallback must be herdr's own layout.
  const byHand = { XDG_CONFIG_HOME: "/home/op/.config" };
  assert.equal(configDir(byHand), "/home/op/.config/herdr/plugins/config/reddb-io.red-skills");
  assert.equal(stateDir(byHand), "/home/op/.config/herdr/plugins/state/reddb-io.red-skills");
});

test("config merges one level deep and keeps the defaults underneath", () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { refreshMs: 500, notifications: { pullRequests: false } });
  assert.equal(merged.refreshMs, 500);
  assert.equal(merged.notifications.pullRequests, false);
  assert.equal(merged.notifications.workerDeath, DEFAULT_CONFIG.notifications.workerDeath);
  assert.equal(merged.mode, DEFAULT_CONFIG.mode);
});
