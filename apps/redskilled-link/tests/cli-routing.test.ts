// The router itself, driven end to end: unknown input answers with the usage
// instead of a guess, and a unit operation the CLI does not know is a loud
// exit 2 — the shapes an operator hits first when something else is broken.
import { describe, expect, it, vi } from "vitest";

import { REDSKILLED_LINK_USAGE, runRedskilledLinkCli } from "../src/cli.js";

describe("the redskilled-link command router", () => {
  it("no command answers with the usage and exits 0", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(runRedskilledLinkCli([])).resolves.toBe(0);
      expect(write).toHaveBeenCalledWith(REDSKILLED_LINK_USAGE);
    } finally {
      write.mockRestore();
    }
  });

  it("an unknown unit operation exits 2 and repeats the usage", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runRedskilledLinkCli(["unit", "explode"])).resolves.toBe(2);
      expect(String(write.mock.calls[0]?.[0])).toContain("unknown operation");
    } finally {
      write.mockRestore();
    }
  });

  it("revoke without a device id exits 2 before touching any store", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runRedskilledLinkCli(["revoke"])).resolves.toBe(2);
      expect(String(write.mock.calls[0]?.[0])).toContain("requires a device id");
    } finally {
      write.mockRestore();
    }
  });
});
