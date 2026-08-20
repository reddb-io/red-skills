import { RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import { redskillsAcpMethod } from "../src/acp-method-registry.js";
import { REDSKILLS_ACP_METHODS } from "@reddb-io/protocol-acp";

/**
 * An error that crosses the wire keeps its words. A handler that threw a plain
 * Error reached the Worker as bare "Internal error" — two Workers ground one
 * Ticket on `refused at publish: Internal error` while the daemon held the
 * real sentence and swallowed it.
 */
describe("wire errors carry their words", () => {
  it("re-throws a plain Error as a RequestError carrying the original sentence", async () => {
    const binding = redskillsAcpMethod(
      REDSKILLS_ACP_METHODS.publish,
      (value) => value,
      () => {
        throw new Error("redskilled could not deliver the Worker's publication: fetch refused");
      },
    );

    await expect(binding.handle({ params: {} } as never)).rejects.toMatchObject({
      code: -32603,
      message: expect.stringContaining("fetch refused"),
    });
  });

  it("passes a RequestError through untouched", async () => {
    const authRequired = RequestError.authRequired({ version: 1 }, "no credential profile");
    const binding = redskillsAcpMethod(
      REDSKILLS_ACP_METHODS.publish,
      (value) => value,
      () => {
        throw authRequired;
      },
    );

    await expect(binding.handle({ params: {} } as never)).rejects.toBe(authRequired);
  });

  it("answers a healthy handler exactly as before", async () => {
    const binding = redskillsAcpMethod(REDSKILLS_ACP_METHODS.publish, (value) => value, () => ({ ok: true }));
    await expect(binding.handle({ params: {} } as never)).resolves.toEqual({ ok: true });
  });
});
