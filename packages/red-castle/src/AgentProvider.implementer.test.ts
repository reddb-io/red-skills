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

  it("passes per-run Codex config overrides that gate plugins and skills", () => {
    const command = codex("model", {
      configOverrides: [
        'plugins."memory@red-skills".enabled=false',
        'skills.config=[{path="/runtime/dev/triage/SKILL.md",enabled=false}]',
      ],
    }).buildPrintCommand(commandInput);

    expect(command.command).toContain(
      "-c 'plugins.\"memory@red-skills\".enabled=false'",
    );
    expect(command.command).toContain(
      "-c 'skills.config=[{path=\"/runtime/dev/triage/SKILL.md\",enabled=false}]'",
    );
  });

  it("isolates OpenCode discovery through the projected config directory", () => {
    const provider = opencode("provider/model", {
      env: { OPENCODE_CONFIG_DIR: "/runtime/opencode" },
    });

    expect(provider.env).toEqual({ OPENCODE_CONFIG_DIR: "/runtime/opencode" });
  });
});
