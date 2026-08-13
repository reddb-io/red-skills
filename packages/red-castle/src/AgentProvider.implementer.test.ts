import { describe, expect, it } from "vitest";
import { claudeCode, codex, opencode } from "./AgentProvider.js";

const commandInput = {
  prompt: "implement",
  dangerouslySkipPermissions: true,
  resumeSession: undefined,
  forkSession: false,
  systemPrompt: undefined,
};

describe("implementer skill projection", () => {
  it("limits Claude settings sources and loads only projected plugin directories", () => {
    const command = claudeCode("model", {
      settingSources: ["project", "local"],
      pluginDirs: ["/runtime/dev", "/runtime/memory"],
    }).buildPrintCommand(commandInput);

    expect(command.command).toContain("--setting-sources 'project,local'");
    expect(command.command).toContain("--plugin-dir '/runtime/dev'");
    expect(command.command).toContain("--plugin-dir '/runtime/memory'");
  });

  it.each([
    ["new", commandInput],
    ["resumed", { ...commandInput, resumeSession: "session-1" }],
    ["forked", { ...commandInput, resumeSession: "session-1", forkSession: true }],
  ])("isolates user configuration and passes projected Codex constraints on %s invocations", (_kind, input) => {
    const command = codex("model", {
      ignoreUserConfig: true,
      ignoreRules: true,
      configOverrides: [
        "features.plugins=false",
        "features.apps=false",
        'mcp_servers={navigator={command="node",args=["navigator.mjs"]}}',
        'skills.config=[{path="/runtime/dev/tdd/SKILL.md",enabled=true}]',
      ],
    }).buildPrintCommand(input);

    expect(command.command).toContain("--ignore-user-config");
    expect(command.command).toContain("--ignore-rules");
    expect(command.command).toContain("-c 'features.plugins=false'");
    expect(command.command).toContain("-c 'features.apps=false'");
    expect(command.command).toContain(
      "-c 'mcp_servers={navigator={command=\"node\",args=[\"navigator.mjs\"]}}'",
    );
    expect(command.command).toContain(
      "-c 'skills.config=[{path=\"/runtime/dev/tdd/SKILL.md\",enabled=true}]'",
    );
  });

  it("isolates OpenCode discovery through the projected config directory", () => {
    const provider = opencode("provider/model", {
      env: { OPENCODE_CONFIG_DIR: "/runtime/opencode" },
    });

    expect(provider.env).toEqual({ OPENCODE_CONFIG_DIR: "/runtime/opencode" });
  });
});
