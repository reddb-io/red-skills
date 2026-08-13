import { describe, expect, it } from "vitest";
import {
  detectRedskilledHostTopology,
  evaluateRedskilledHostEventTopology,
  type RedskilledHostTopology,
} from "../src/host-topology.js";

describe("redskilled host topology", () => {
  it("detects WSL from the kernel release without consulting the environment", () => {
    const env = { WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined };

    expect(detectRedskilledHostTopology({
      platform: "linux",
      release: "5.15.153.1-microsoft-standard-WSL2",
    })).toEqual({ platform: "linux", environment: "wsl" });
    expect(env).toEqual({ WSL_DISTRO_NAME: undefined, WSL_INTEROP: undefined });
  });
});

describe("public host-event topology", () => {
  it("names both cross-boundary refusals and admits both same-side Windows topologies", () => {
    const wsl: RedskilledHostTopology = { platform: "linux", environment: "wsl" };
    const windows: RedskilledHostTopology = { platform: "win32", environment: "native" };

    expect([
      evaluateRedskilledHostEventTopology(wsl, windows),
      evaluateRedskilledHostEventTopology(windows, wsl),
      evaluateRedskilledHostEventTopology(wsl, wsl),
      evaluateRedskilledHostEventTopology(windows, windows),
    ]).toEqual([
      {
        observable: false,
        topology: "wsl-daemon/native-windows-consumer",
        detail: "WSL daemon -> native Windows consumer: file-change notification does not cross the WSL boundary",
      },
      {
        observable: false,
        topology: "native-windows-daemon/wsl-consumer",
        detail: "native Windows daemon -> WSL consumer: file-change notification does not cross the WSL boundary",
      },
      { observable: true, topology: "same-side", detail: "WSL daemon -> WSL consumer is observable" },
      {
        observable: true,
        topology: "same-side",
        detail: "native Windows daemon -> native Windows consumer is observable",
      },
    ]);
  });
});
