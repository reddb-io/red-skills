import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The standalone `sandcastle` CLI integration tests spawn the built binary
    // (dist/main.js). This vendored fork never keeps a built binary — red-skills
    // consumes the source through the dev bundle — so the CLI surface is out of
    // scope here. See CLAUDE.md "Vendored source — never published".
    exclude: [...configDefaults.exclude, "src/cli.test.ts"],
    setupFiles: ["src/testSetup.ts"],
  },
});
