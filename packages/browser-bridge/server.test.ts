import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifact } from "./session.js";
import { dispatchBridgeRequest, createBridgeServer } from "./server.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-srv-"));
  const artifact = join(root, "a.html");
  writeFileSync(artifact, "<html><body><h1 id=t>T</h1></body></html>", "utf8");
  openArtifact(artifact, { root, sessionId: "s1" });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("dispatchBridgeRequest", () => {
  it("health for a known session", () => {
    const r = dispatchBridgeRequest("GET", "/sessions/s1/health", undefined, { root });
    expect(r.status).toBe(200);
    expect((r.body as { ok: boolean }).ok).toBe(true);
  });

  it("health 404 for unknown session", () => {
    expect(dispatchBridgeRequest("GET", "/sessions/nope/health", undefined, { root }).status).toBe(404);
  });

  it("POST then GET annotation round-trip with cursor", () => {
    const post = dispatchBridgeRequest(
      "POST",
      "/sessions/s1/annotations",
      { selector: "#t", textRange: { start: 0, end: 1, quote: "T" }, comment: "fix" },
      { root },
    );
    expect(post.status).toBe(201);

    const get = dispatchBridgeRequest("GET", "/sessions/s1/annotations?cursor=0", undefined, { root });
    expect(get.status).toBe(200);
    const body = get.body as { annotations: unknown[]; cursor: number };
    expect(body.annotations).toHaveLength(1);
    expect(body.cursor).toBe(1);

    const empty = dispatchBridgeRequest("GET", "/sessions/s1/annotations?cursor=1", undefined, { root });
    expect((empty.body as { annotations: unknown[] }).annotations).toHaveLength(0);
  });

  it("POST a malformed annotation returns 400", () => {
    const r = dispatchBridgeRequest("POST", "/sessions/s1/annotations", { comment: "no selector" }, { root });
    expect(r.status).toBe(400);
  });

  it("POST to an unknown session returns 404", () => {
    const r = dispatchBridgeRequest("POST", "/sessions/nope/annotations", { selector: "p", comment: "x" }, { root });
    expect(r.status).toBe(404);
  });

  it("unknown route returns 404", () => {
    expect(dispatchBridgeRequest("GET", "/whatever", undefined, { root }).status).toBe(404);
  });
});

describe("createBridgeServer (live socket)", () => {
  it("serves the annotation round-trip over HTTP", async () => {
    const srv = await createBridgeServer({ root });
    try {
      const base = `http://127.0.0.1:${srv.port}`;
      const health = await fetch(`${base}/sessions/s1/health`);
      expect(health.status).toBe(200);

      const post = await fetch(`${base}/sessions/s1/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selector: "#t", comment: "make bigger" }),
      });
      expect(post.status).toBe(201);

      const get = await fetch(`${base}/sessions/s1/annotations?cursor=0`);
      const body = (await get.json()) as { annotations: { selector: string }[] };
      expect(body.annotations[0].selector).toBe("#t");
    } finally {
      await srv.close();
    }
  });
});
