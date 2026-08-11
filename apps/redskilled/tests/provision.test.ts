// Provisioning: the one route from a machine with no prior state to a daemon a
// client can reach — and the one owner of the host-scoped home it lives in.
//
// Two properties carry the whole slice. The home has ONE creator, so no other
// path may bring it into being by accident; and provisioning is IDEMPOTENT, so
// the second run is a no-op rather than a second opinion about permissions.
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redskilledHomeDir, REDSKILLED_HOME_MODE } from "@reddb-io/shared/redskilled-home.js";
import { runProvision } from "../src/cli.js";
import { socketAnswers } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import {
  auditRedskilledProvisioning,
  installRedskilledUserUnit,
  provisionRedskilledHome,
  readRedskilledHomeNeed,
  redskilledUserUnitPath,
  renderRedskilledUserUnit,
  type RedskilledProvisionFacts,
} from "../src/provision.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");

const roots: string[] = [];
const started: string[] = [];

afterEach(async () => {
  for (const socketPath of started.splice(0)) {
    await sendRedskilledRequest({ socketPath }, { id: `shutdown-${socketPath.length}`, op: "shutdown" }).catch(
      () => undefined,
    );
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fakeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-home-"));
  roots.push(root);
  return root;
}

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** Healthy facts; each test spoils exactly the one thing it is about. */
function facts(overrides: Partial<RedskilledProvisionFacts> = {}): RedskilledProvisionFacts {
  return {
    homePath: "/home/dev/.red/redskilled",
    homePresent: true,
    homeMode: REDSKILLED_HOME_MODE,
    homeNeed: { needed: true, declaredBy: "plugins.dev.workspace.target: host (/repo/.red/config.yaml)" },
    entry: { command: "/usr/bin/node", args: ["/bundles/redskilled.bundle.min.mjs"], source: "bundle-cache" },
    socketPath: "/run/user/1000/red-skills/redskilled.sock",
    reachable: true,
    supervisorUnit: "absent",
    ...overrides,
  };
}

describe("redskilled home ownership", () => {
  it("names the home in exactly one place, under the operator's `~/.red`", () => {
    expect(redskilledHomeDir("/home/dev")).toBe("/home/dev/.red/redskilled");
  });

  it("creates the home owner-only, and the second run changes nothing", async () => {
    const home = await fakeHome();

    const first = await provisionRedskilledHome(home);
    expect(first.path).toBe(redskilledHomeDir(home));
    expect(first.created).toBe(true);
    expect(first.tightened).toBe(false);
    expect(await modeOf(first.path)).toBe(REDSKILLED_HOME_MODE);

    const second = await provisionRedskilledHome(home);
    expect(second.path).toBe(first.path);
    expect(second.created).toBe(false);
    expect(second.tightened).toBe(false);
    expect(await modeOf(second.path)).toBe(REDSKILLED_HOME_MODE);
  });

  it("keeps what the home already holds, and only tightens a world-readable home", async () => {
    const home = await fakeHome();
    const path = redskilledHomeDir(home);
    await mkdir(path, { recursive: true, mode: 0o755 });
    await writeFile(join(path, "keep.txt"), "worker state", "utf8");

    const receipt = await provisionRedskilledHome(home);

    expect(receipt.created).toBe(false);
    expect(receipt.tightened).toBe(true);
    expect(await modeOf(path)).toBe(REDSKILLED_HOME_MODE);
    await expect(stat(join(path, "keep.txt"))).resolves.toBeTruthy();

    // Idempotent from the tightened state too: nothing left to do.
    expect((await provisionRedskilledHome(home)).tightened).toBe(false);
  });
});

describe("who needs the home", () => {
  async function project(target?: string): Promise<string> {
    const root = await fakeHome();
    await mkdir(join(root, ".red"), { recursive: true });
    if (target !== undefined) {
      await writeFile(join(root, ".red", "config.yaml"), `plugins:\n  dev:\n    workspace:\n      target: ${target}\n`, "utf8");
    }
    return root;
  }

  it("needs the home only for a target rooted inside it", async () => {
    const homeDir = "/home/dev";
    for (const target of ["host", "~/.red/redskilled/scratch"]) {
      expect((await readRedskilledHomeNeed({ homeDir, declaredTarget: target })).needed, target).toBe(true);
    }
    for (const target of ["local", "tmp", "/mnt/fast/workers", "~/other"]) {
      expect((await readRedskilledHomeNeed({ homeDir, declaredTarget: target })).needed, target).toBe(false);
    }
  });

  it("reads the repository's declaration, and names it", async () => {
    const need = await readRedskilledHomeNeed({ homeDir: "/home/dev", projectRoot: await project("host") });

    expect(need.needed).toBe(true);
    expect(need.declaredBy).toContain("plugins.dev.workspace.target: host");
    expect(need.declaredBy).toContain("config.yaml");
  });

  it("treats an undeclared, an absent and an off-contract target as no need at all", async () => {
    // None of the three can be the `host` preset, and a provisioning run is the
    // wrong place to re-raise a config error the workspace layer refuses at use.
    expect((await readRedskilledHomeNeed({ projectRoot: await project() })).needed).toBe(false);
    expect((await readRedskilledHomeNeed({ projectRoot: await fakeHome() })).needed).toBe(false);
    const bogus = await readRedskilledHomeNeed({ projectRoot: await project("hosty") });
    expect(bogus.needed).toBe(false);
    expect(bogus.declaredBy).toContain("off-contract");
  });

  it("lets a stated target win over the repository in view", async () => {
    const projectRoot = await project("local");
    expect((await readRedskilledHomeNeed({ projectRoot, declaredTarget: "host" })).needed).toBe(true);
    expect((await readRedskilledHomeNeed({ projectRoot })).needed).toBe(false);
  });
});

describe("redskilled provisioning audit", () => {
  it("reports a provisioned host as ok, with the optional unit staying ok while absent", () => {
    const report = auditRedskilledProvisioning(facts());

    expect(report.verdict).toBe("ok");
    expect(report.findings).toEqual([]);
    expect(report.rows.map((row) => row.check)).toEqual(["home", "daemon-entry", "reach", "supervisor-unit"]);
    expect(report.rows.every((row) => row.verdict === "ok")).toBe(true);
    // Optional means optional: an absent unit never reads as a defect.
    expect(report.rows.at(-1)?.evidence).toContain("optional");
  });

  it("says what to run when a NEEDED home was never provisioned", () => {
    const report = auditRedskilledProvisioning(facts({ homePresent: false, homeMode: undefined, reachable: false }));

    expect(report.verdict).toBe("missing");
    const home = report.findings.find((finding) => finding.check === "home");
    expect(home?.verdict).toBe("missing");
    expect(home?.evidence).toContain("/home/dev/.red/redskilled");
    // The declaration that needs it, so the row is actionable rather than bare.
    expect(home?.evidence).toContain("plugins.dev.workspace.target: host");
    expect(home?.fix).toContain("/red-setup");
    expect(home?.fix).toContain("redskilled provision");
  });

  it("reads an absent home as ok when no declared target reads it", () => {
    const report = auditRedskilledProvisioning(
      facts({
        homePresent: false,
        homeMode: undefined,
        homeNeed: { needed: false, declaredBy: "/repo/.red/config.yaml declares no workspace target (default local)" },
      }),
    );

    // Absent and unneeded is not a defect: the daemon never reads the home, so a
    // red row here would send an operator to cure a machine that already works.
    expect(report.verdict).toBe("ok");
    expect(report.findings).toEqual([]);
    const home = report.rows.find((row) => row.check === "home");
    expect(home?.evidence).toContain("absent and unneeded");
    expect(home?.evidence).toContain("default local");
    expect(home?.fix).toBe("");
  });

  it("degrades a home the machine can read, naming the exact chmod", () => {
    const report = auditRedskilledProvisioning(facts({ homeMode: 0o755 }));

    expect(report.verdict).toBe("degraded");
    const home = report.findings.find((finding) => finding.check === "home");
    expect(home?.verdict).toBe("degraded");
    expect(home?.evidence).toContain("755");
    expect(home?.fix).toContain("redskilled provision");
  });

  it("names every probed path when no published bundle answers", () => {
    const report = auditRedskilledProvisioning(
      facts({
        entry: { diagnostic: "redskilled-daemon-entry-unresolved", searched: ["/dist/redskilled.bundle.min.mjs"] },
        reachable: false,
      }),
    );

    expect(report.verdict).toBe("missing");
    const entry = report.findings.find((finding) => finding.check === "daemon-entry");
    expect(entry?.evidence).toContain("/dist/redskilled.bundle.min.mjs");
    // Reach cannot be cured before the bundle is, so the entry finding leads.
    expect(report.findings[0]?.check).toBe("daemon-entry");
  });

  it("reports an unreachable daemon against the socket it probed", () => {
    const report = auditRedskilledProvisioning(facts({ reachable: false }));

    const reach = report.findings.find((finding) => finding.check === "reach");
    expect(reach?.verdict).toBe("missing");
    expect(reach?.evidence).toContain("/run/user/1000/red-skills/redskilled.sock");
    expect(reach?.fix).toContain("redskilled provision");
  });
});

describe("provisioning a machine with no prior state", () => {
  it("yields a reachable daemon with the host preset, and the second run changes nothing", async () => {
    const home = await fakeHome();
    const runtimeDir = await fakeHome();
    const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${runtimeDir}`, REDSKILLED_MACHINE_DIR: runtimeDir }, runtimeDir });
    // The daemon runs from a stated command rather than a resolved bundle, so
    // the test exercises provisioning without shipping an artifact first.
    const client = { serverCommand: process.execPath, serverArgs: ["--import", tsxLoader, cliEntry] };
    const io = { paths, homeDir: home, configHome: join(home, ".config"), client, write: () => undefined };

    expect(await socketAnswers(paths.socketPath)).toBe(false);

    const first = await runProvision(["--workspace", "host"], io);
    started.push(paths.socketPath);

    expect(first).toBe(0);
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(await modeOf(redskilledHomeDir(home))).toBe(REDSKILLED_HOME_MODE);

    const lines: string[] = [];
    const second = await runProvision(["--workspace", "host"], { ...io, write: (text) => lines.push(text) });

    expect(second).toBe(0);
    expect(lines.join("")).toContain("verdict: ok");
    // Nothing created, nothing tightened, nothing restarted: a no-op second run.
    expect(lines.join("")).toContain("created: false");
    expect(lines.join("")).toContain("tightened: false");
  }, 30_000);

  // The whole point of #2958: the home is a workspace lane's root, not a daemon
  // precondition, so a default machine reaches a daemon without one — and
  // `/red-setup` leaves the critical path of "have a daemon" entirely.
  it("reaches a daemon on the default preset without ever creating the home", async () => {
    const home = await fakeHome();
    const runtimeDir = await fakeHome();
    const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `local:${runtimeDir}`, REDSKILLED_MACHINE_DIR: runtimeDir }, runtimeDir });
    const client = { serverCommand: process.execPath, serverArgs: ["--import", tsxLoader, cliEntry] };
    const lines: string[] = [];

    const code = await runProvision([], {
      paths,
      homeDir: home,
      configHome: join(home, ".config"),
      // A repository that declares nothing: the default `local` preset.
      projectRoot: await fakeHome(),
      client,
      write: (text) => lines.push(text),
    });
    started.push(paths.socketPath);

    expect(code).toBe(0);
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    await expect(stat(redskilledHomeDir(home)), "the home was created for a preset that never reads it").rejects.toThrow();
    expect(lines.join("")).toContain("verdict: ok");
    expect(lines.join("")).toContain("needed: false");
  }, 30_000);

  it("provisions the home the moment the host preset is selected, and says so", async () => {
    const home = await fakeHome();
    const runtimeDir = await fakeHome();
    const projectRoot = await fakeHome();
    await mkdir(join(projectRoot, ".red"), { recursive: true });
    await writeFile(
      join(projectRoot, ".red", "config.yaml"),
      "plugins:\n  dev:\n    workspace:\n      target: host\n",
      "utf8",
    );
    const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `host:${runtimeDir}`, REDSKILLED_MACHINE_DIR: runtimeDir }, runtimeDir });
    const lines: string[] = [];

    const code = await runProvision(["--no-start"], {
      paths,
      homeDir: home,
      configHome: join(home, ".config"),
      projectRoot,
      write: (text) => lines.push(text),
    });

    expect(await modeOf(redskilledHomeDir(home))).toBe(REDSKILLED_HOME_MODE);
    expect(lines.join("")).toContain("created: true");
    expect(lines.join("")).toContain("needed: true");
    // The receipt names the declaration, not just the fact — an operator asking
    // "why is this here?" gets the config key back.
    expect(lines.join("")).toContain("plugins.dev.workspace.target");
    // The daemon was never started, so reach is the only thing outstanding.
    expect(code).toBe(1);
    expect(lines.join("")).toContain("reach,missing");
  }, 30_000);

  it("reports without creating or starting anything under --check", async () => {
    const home = await fakeHome();
    const runtimeDir = await fakeHome();
    const paths = resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `check:${runtimeDir}`, REDSKILLED_MACHINE_DIR: runtimeDir }, runtimeDir });
    const lines: string[] = [];

    const code = await runProvision(["--check"], {
      paths,
      homeDir: home,
      configHome: join(home, ".config"),
      write: (text) => lines.push(text),
    });

    expect(code).toBe(1);
    expect(lines.join("")).toContain("verdict: missing");
    expect(await socketAnswers(paths.socketPath)).toBe(false);
    await expect(stat(redskilledHomeDir(home))).rejects.toThrow();
  });
});

describe("the optional supervising unit", () => {
  it("renders a user unit that restarts after every exit and serves the session socket", () => {
    const unit = renderRedskilledUserUnit({
      command: "/usr/bin/node /bundles/redskilled.bundle.min.mjs",
      socketPath: "/run/user/1000/red-skills/redskilled.sock",
    });

    expect(unit).toContain("Restart=always");
    expect(unit).toContain("LimitCORE=0");
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("ExecStart=/usr/bin/node /bundles/redskilled.bundle.min.mjs serve");
    expect(unit).toContain("--socket /run/user/1000/red-skills/redskilled.sock");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("installs the unit once and never clobbers an operator's own copy", async () => {
    const home = await fakeHome();
    const unit = renderRedskilledUserUnit({ command: "node /bundles/redskilled.bundle.min.mjs" });

    const first = await installRedskilledUserUnit({ configHome: join(home, ".config"), unit });
    expect(first.status).toBe("installed");
    expect(first.path).toBe(redskilledUserUnitPath(join(home, ".config")));

    const second = await installRedskilledUserUnit({ configHome: join(home, ".config"), unit });
    expect(second.status).toBe("already-present");

    const edited = await installRedskilledUserUnit({
      configHome: join(home, ".config"),
      unit: `${unit}\n# operator edit\n`,
    });
    expect(edited.status).toBe("already-present");
  });
});
