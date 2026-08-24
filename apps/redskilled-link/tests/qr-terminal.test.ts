import { describe, expect, it, vi } from "vitest";

import { renderInvitationQr, showInvitationQr, type QrTerminalDependencies } from "../src/qr-terminal.js";

describe("pairing QR terminal surface", () => {
  it("renders the pairing URI only as a QR matrix", () => {
    const uri = "redskilled://pair/private-one-use-invitation";
    const rendered = renderInvitationQr(uri, { columns: 120, rows: 60 });
    expect(rendered).toContain("\u001b[30;");
    expect(rendered).toContain("\u2580");
    expect(rendered).not.toContain(uri);
  });

  it("falls back to printable URI output when there is no TTY", async () => {
    const write = vi.fn();
    const dependencies = {
      input: { isTTY: false },
      output: { isTTY: false, write },
    } as unknown as QrTerminalDependencies;
    await expect(showInvitationQr("redskilled://pair/private", "2026-08-24T12:10:00.000Z", dependencies))
      .resolves.toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
});
