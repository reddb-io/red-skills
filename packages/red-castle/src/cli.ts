import { Command, Options } from "@effect/cli";
import { FileSystem } from "@effect/platform";
import { planGithubWrite } from "@reddb-io/github";
import { resolveRepoSlugForDir } from "@reddb-io/shared/project-identity-resolve.js";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execFileSync, execSync } from "node:child_process";
import { join } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import {
  buildImage,
  checkDockerHealth,
  removeImage,
} from "./DockerLifecycle.js";
import {
  buildImage as podmanBuildImage,
  checkPodmanHealth,
  removeImage as podmanRemoveImage,
} from "./PodmanLifecycle.js";
import { formatErrorMessage } from "./ErrorHandler.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  listCodexAuthModes,
  getNextStepsLines,
  detectPackageManager,
  addDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import type {
  AgentEntry,
  IssueTrackerEntry,
  CodexAuthMode,
  SandboxProviderEntry,
} from "./InitService.js";
import { ConfigDirError, InitError, type SandboxError } from "./errors.js";
import { VERSION } from "./version.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) args.AGENT_UID = String(uid);
  if (gid !== undefined) args.AGENT_GID = String(gid);
  return args;
};

// --- Config directory check ---

const CONFIG_DIR = ".red-castle";

const requireConfigDir = (
  cwd: string,
): Effect.Effect<void, ConfigDirError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs
      .exists(join(cwd, CONFIG_DIR))
      .pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (!exists) {
      yield* Effect.fail(
        new ConfigDirError({
          message: "No .red-castle/ found. Run `sandcastle init` first.",
        }),
      );
    }
  });

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. claude-code)"),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent (e.g. claude-sonnet-4-6). Defaults to the agent's default model",
  ),
  Options.optional,
);

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription("Sandbox provider to use (e.g. docker, podman)"),
  Options.optional,
);

const issueTrackerOption = Options.text("issue-tracker").pipe(
  Options.withDescription(
    "Issue tracker to use (e.g. github-issues, beads, custom)",
  ),
  Options.optional,
);

const codexAuthOption = Options.text("codex-auth").pipe(
  Options.withDescription(
    "Codex auth mode: api-key or subscription. Defaults to api-key",
  ),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const createLabelOption = Options.choice("create-label", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    'Whether to create the "Sandcastle" GitHub label (only meaningful with --issue-tracker github-issues)',
  ),
  Options.optional,
);

const buildImageOption = Options.choice("build-image", ["true", "false"]).pipe(
  Options.withDescription(
    "Whether to build the sandbox image now (ignored when --issue-tracker custom is selected)",
  ),
  Options.optional,
);

const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)",
  ),
  Options.optional,
);

/**
 * Translate an `Options.choice("flag", ["true", "false"]).optional` value into
 * a tri-state boolean. None when the flag was absent; otherwise the parsed bool.
 */
const choiceToTriBool = (
  opt: Option.Option<"true" | "false">,
): Option.Option<boolean> =>
  opt._tag === "Some" ? Option.some(opt.value === "true") : Option.none();

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    model: initModelOption,
    sandbox: sandboxOption,
    issueTracker: issueTrackerOption,
    codexAuth: codexAuthOption,
    createLabel: createLabelOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    codexAuth,
    createLabel: createLabelFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (sandboxFlag._tag === "Some") {
        const valid = getSandboxProvider(sandboxFlag.value);
        if (!valid) {
          const names = listSandboxProviders()
            .map((p) => p.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (issueTrackerFlag._tag === "Some") {
        const valid = getIssueTracker(issueTrackerFlag.value);
        if (!valid) {
          const names = listIssueTrackers()
            .map((t) => t.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      const createLabelChoice = choiceToTriBool(createLabelFlag);
      const buildImageChoice = choiceToTriBool(buildImageFlag);
      const installTemplateDepsChoice = choiceToTriBool(
        installTemplateDepsFlag,
      );

      const isInteractive = process.stdin.isTTY === true;
      const failIfNonInteractive = (flag: string) =>
        Effect.fail(
          new InitError({
            message: `${flag} is required in non-interactive mode (no TTY detected).`,
          }),
        );

      // Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
      // fail fast in non-interactive mode naming the missing flag). Cancelling
      // the prompt is treated as abort — same shape as the select prompts above.
      const resolveConfirmFlag = (params: {
        choice: Option.Option<boolean>;
        flag: string;
        promptMessage: string;
        cancelMessage: string;
      }): Effect.Effect<boolean, InitError> =>
        Effect.gen(function* () {
          if (params.choice._tag === "Some") return params.choice.value;
          if (!isInteractive) {
            yield* failIfNonInteractive(params.flag);
          }
          const confirmed = yield* Effect.promise(() =>
            clack.confirm({
              message: params.promptMessage,
              initialValue: true,
            }),
          );
          if (clack.isCancel(confirmed)) {
            yield* Effect.fail(
              new InitError({ message: params.cancelMessage }),
            );
          }
          return confirmed === true;
        });

      // Resolve agent: CLI flag > interactive select
      const agents = listAgents();
      let selectedAgent: AgentEntry;
      if (agentFlag._tag === "Some") {
        const entry = getAgent(agentFlag.value);
        if (!entry) {
          const names = agents.map((a) => a.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
            }),
          );
        }
        selectedAgent = entry!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--agent");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an agent:",
            initialValue: "claude-code",
            options: agents.map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

      let selectedCodexAuthMode: CodexAuthMode = "api-key";
      if (selectedAgent.name === "codex") {
        const codexAuthModes = listCodexAuthModes();
        if (codexAuth._tag === "Some") {
          const valid = codexAuthModes.find((m) => m.name === codexAuth.value);
          if (!valid) {
            const names = codexAuthModes.map((m) => m.name).join(", ");
            yield* Effect.fail(
              new InitError({
                message: `Unknown Codex auth mode "${codexAuth.value}". Available: ${names}`,
              }),
            );
          }
          selectedCodexAuthMode = valid!.name;
        } else if (agentFlag._tag === "None") {
          const selected = yield* Effect.promise(() =>
            clack.select({
              message: "Select Codex auth mode:",
              initialValue: "api-key",
              options: codexAuthModes.map((m) => ({
                value: m.name,
                label: m.label,
                hint: m.description,
              })),
            }),
          );
          if (clack.isCancel(selected)) {
            yield* Effect.fail(
              new InitError({
                message: "Codex auth mode selection cancelled.",
              }),
            );
          }
          selectedCodexAuthMode = selected as CodexAuthMode;
        }
      } else if (codexAuth._tag === "Some") {
        yield* Effect.fail(
          new InitError({
            message: "--codex-auth can only be used with --agent codex",
          }),
        );
      }

      // Resolve sandbox provider: CLI flag > interactive select (no default — user must choose)
      const sandboxProviders = listSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      if (sandboxFlag._tag === "Some") {
        selectedSandboxProvider = getSandboxProvider(sandboxFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--sandbox");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Resolve issue tracker: CLI flag > interactive select (already validated above)
      const issueTrackers = listIssueTrackers();
      let selectedIssueTracker: IssueTrackerEntry;
      if (issueTrackerFlag._tag === "Some") {
        selectedIssueTracker = getIssueTracker(issueTrackerFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--issue-tracker");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an issue tracker:",
            initialValue: "github-issues",
            options: issueTrackers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Issue tracker selection cancelled.",
            }),
          );
        }
        selectedIssueTracker = getIssueTracker(selected as string)!;
      }

      // Resolve template: CLI flag > interactive select (already validated above)
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--template");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      // Offer to create the "Sandcastle" label on the repo (skip for non-GitHub issue trackers).
      // CLI flag > interactive confirm. The flag is only meaningful for the github-issues tracker.
      let shouldCreateLabel = false;
      if (selectedIssueTracker.name === "github-issues") {
        shouldCreateLabel = yield* resolveConfirmFlag({
          choice: createLabelChoice,
          flag: "--create-label",
          promptMessage:
            'Create a "Sandcastle" GitHub label? (Templates filter issues by this label)',
          cancelMessage: "Label selection cancelled.",
        });

        if (shouldCreateLabel) {
          yield* Effect.try({
            try: () => {
              const repo = resolveRepoSlugForDir(cwd);
              const plan = planGithubWrite([
                "gh",
                "label",
                "create",
                "Sandcastle",
                "--description",
                "Issues for Sandcastle to work on",
                "--color",
                "F9A825",
                ...(repo ? ["--repo", repo] : []),
              ]);
              execFileSync(plan.args[0]!, plan.args.slice(1), {
                cwd,
                stdio: "ignore",
              });
            },
            catch: () => undefined,
          }).pipe(Effect.ignore);
        }
      }

      const scaffoldResult = yield* d.spinner(
        "Scaffolding .red-castle/ config directory...",
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          createLabel: shouldCreateLabel,
          issueTracker: selectedIssueTracker,
          sandboxProvider: selectedSandboxProvider,
          codexAuthMode: selectedCodexAuthMode,
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );

      // Detect the host package manager so the zod offer below and the next
      // steps below both use the right install command.
      const packageManager = yield* detectPackageManager(cwd);

      // If the chosen template imports zod on the host (the planner templates
      // build their <plan> output schema with it) and the host doesn't already
      // declare it, offer to install it. Without this, the very first
      // `npx tsx .red-castle/main.ts` crashes with ERR_MODULE_NOT_FOUND.
      if (getTemplateDependencies(selectedTemplate).includes("zod")) {
        const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
        if (!alreadyInstalled) {
          const installCmd = addDependencyCommand(packageManager, "zod");
          const shouldInstall = yield* resolveConfirmFlag({
            choice: installTemplateDepsChoice,
            flag: "--install-template-deps",
            promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
            cancelMessage: "Install-template-deps selection cancelled.",
          });
          if (shouldInstall) {
            const installed = yield* Effect.sync(() => {
              try {
                execSync(installCmd, { cwd, stdio: "ignore" });
                return true;
              } catch {
                return false;
              }
            });
            yield* installed
              ? d.status(`Installed zod with ${packageManager}.`, "success")
              : d.status(
                  `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
                  "warn",
                );
          }
        }
      }

      // Prompt user before building image. The custom issue tracker scaffolds
      // an intentionally unfinished Dockerfile (the install block is a TODO),
      // so there is nothing valid to build yet — skip the build prompt entirely
      // (and silently ignore --build-image) and let the next steps point the
      // user at the setup doc.
      const providerLabel = selectedSandboxProvider.label;
      const providerNamespace = selectedSandboxProvider.cliNamespace;
      const skipBuildMessage = `Init complete! Run \`sandcastle ${providerNamespace} build-image\` to build the ${providerLabel} image later.`;
      if (selectedIssueTracker.name === "custom") {
        yield* d.status(
          "Init complete! Your custom issue tracker isn't configured yet — see the steps below before building.",
          "success",
        );
      } else {
        const shouldBuild = yield* resolveConfirmFlag({
          choice: buildImageChoice,
          flag: "--build-image",
          promptMessage: `Build the default ${providerLabel} image now?`,
          cancelMessage: "Build-image selection cancelled.",
        });

        if (shouldBuild) {
          const checkHealth =
            selectedSandboxProvider.name === "podman"
              ? checkPodmanHealth
              : checkDockerHealth;

          let outcome: "build" | "skip" | "not-installed" = "skip";
          let resolved = false;
          while (!resolved) {
            const health = yield* checkHealth;
            if (health === "ok") {
              outcome = "build";
              resolved = true;
            } else if (health === "not-installed") {
              outcome = "not-installed";
              resolved = true;
            } else {
              const choice = yield* Effect.promise(() =>
                clack.select({
                  message: `${providerLabel} doesn't seem to be running. Start it, then choose what to do.`,
                  options: [
                    {
                      value: "retry",
                      label: `I started ${providerLabel} — retry`,
                    },
                    {
                      value: "skip",
                      label: "Skip the build, I'll run it later",
                    },
                  ],
                }),
              );
              if (clack.isCancel(choice) || choice === "skip") {
                outcome = "skip";
                resolved = true;
              }
            }
          }

          if (outcome === "build") {
            const containerfileDir = join(cwd, CONFIG_DIR);
            const containerBuild: Effect.Effect<void, SandboxError> =
              selectedSandboxProvider.name === "podman"
                ? podmanBuildImage(imageName, containerfileDir)
                : buildImage(imageName, containerfileDir, {
                    buildArgs: defaultUidBuildArgs(),
                  });

            const buildResult = yield* d.spinner(
              `Building ${providerLabel} image '${imageName}'...`,
              Effect.either(containerBuild),
            );

            if (buildResult._tag === "Right") {
              yield* d.status(
                "Init complete! Image built successfully.",
                "success",
              );
            } else {
              yield* d.status(formatErrorMessage(buildResult.left), "error");
              yield* d.status(skipBuildMessage, "info");
            }
          } else if (outcome === "not-installed") {
            yield* d.status(
              `${providerLabel} doesn't appear to be installed. Install it, then run \`sandcastle ${providerNamespace} build-image\` to build the image.`,
              "warn",
            );
          } else {
            yield* d.status(skipBuildMessage, "success");
          }
        } else {
          yield* d.status(skipBuildMessage, "success");
        }
      }

      // Show template-specific next steps
      const nextSteps = getNextStepsLines(
        selectedTemplate,
        scaffoldResult.mainFilename,
        selectedIssueTracker,
        selectedAgent,
        packageManager,
        { codexAuthMode: selectedCodexAuthMode },
      );
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs: defaultUidBuildArgs(),
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Podman build-image command ---

const containerfileOption = Options.file("containerfile").pipe(
  Options.withDescription(
    "Path to a custom Containerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const podmanBuildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    containerfile: containerfileOption,
  },
  ({ imageName: imageNameFlag, containerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const containerfileDir = join(cwd, CONFIG_DIR);
      const containerfilePath =
        containerfile._tag === "Some" ? containerfile.value : undefined;
      yield* d.spinner(
        `Building Podman image '${imageName}'...`,
        podmanBuildImage(imageName, containerfileDir, {
          containerfile: containerfilePath,
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Podman remove-image command ---

const podmanRemoveImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Podman image '${imageName}'...`,
        podmanRemoveImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Podman namespace command ---

const podmanCommand = Command.make("podman", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Podman sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([podmanBuildImageCommand, podmanRemoveImageCommand]),
);

// --- Root command ---

const rootCommand = Command.make("sandcastle", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`Sandcastle v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const sandcastle = rootCommand.pipe(
  Command.withSubcommands([initCommand, dockerCommand, podmanCommand]),
);

export const cli = Command.run(sandcastle, {
  name: "sandcastle",
  version: VERSION,
});
