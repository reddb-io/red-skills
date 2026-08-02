import { describe, expect, it } from "vitest";
import {
  adoptEngineNodeOnPath,
  describeSearchedPath,
  engineNodeDir,
  pathWithEngineNode,
  splitSearchPath,
} from "./engine-node.js";

const MISE = "/home/posed/.local/share/mise/installs/node/lts/bin/node";
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin";

describe("splitSearchPath", () => {
  it("drops empty and blank entries", () => {
    expect(splitSearchPath("/usr/bin::  :/bin", ":")).toEqual(["/usr/bin", "/bin"]);
  });

  it("reads an absent PATH as no directories", () => {
    expect(splitSearchPath(undefined, ":")).toEqual([]);
  });
});

describe("engineNodeDir", () => {
  it("is the directory holding the running interpreter", () => {
    expect(engineNodeDir(MISE)).toBe("/home/posed/.local/share/mise/installs/node/lts/bin");
  });

  it("is null when the interpreter path cannot become a PATH entry", () => {
    expect(engineNodeDir("")).toBeNull();
    expect(engineNodeDir("node")).toBeNull();
  });
});

describe("pathWithEngineNode", () => {
  it("puts the engine's own node directory first", () => {
    expect(pathWithEngineNode(SYSTEM_PATH, MISE, ":")).toBe(
      `/home/posed/.local/share/mise/installs/node/lts/bin:${SYSTEM_PATH}`,
    );
  });

  it("moves rather than duplicates a directory already on PATH", () => {
    const path = `/usr/bin:/opt/node/bin:/bin`;
    expect(pathWithEngineNode(path, "/opt/node/bin/node", ":")).toBe("/opt/node/bin:/usr/bin:/bin");
  });

  it("leaves the PATH alone when the interpreter path is unusable", () => {
    expect(pathWithEngineNode(SYSTEM_PATH, "", ":")).toBe(SYSTEM_PATH);
  });
});

describe("adoptEngineNodeOnPath", () => {
  it("mutates the environment so descendants inherit the engine's node", () => {
    const env: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH };
    const next = adoptEngineNodeOnPath(env, MISE, ":");
    expect(env.PATH).toBe(next);
    expect(splitSearchPath(env.PATH, ":")[0]).toBe("/home/posed/.local/share/mise/installs/node/lts/bin");
  });

  it("is idempotent across repeated front doors", () => {
    const env: NodeJS.ProcessEnv = { PATH: SYSTEM_PATH };
    adoptEngineNodeOnPath(env, MISE, ":");
    const twice = adoptEngineNodeOnPath(env, MISE, ":");
    expect(twice).toBe(`/home/posed/.local/share/mise/installs/node/lts/bin:${SYSTEM_PATH}`);
  });
});

describe("describeSearchedPath", () => {
  it("names every directory the lookup searched", () => {
    expect(describeSearchedPath(SYSTEM_PATH, ":")).toBe("searched PATH: /usr/local/bin, /usr/bin, /bin");
  });

  it("says so when there was nowhere to search", () => {
    expect(describeSearchedPath("", ":")).toBe("PATH was empty");
  });
});
