// The store holds a FLEET: adding a second Host must never forget the first,
// a v1 single-host record migrates on first read, and a corrupt entry loses
// that entry — never the whole fleet.
import { describe, expect, it } from "vitest";
import { encodePairedHost } from "@reddb-io/red-skills-link-protocol/crypto";
import type { RedskilledLinkPairedHost } from "@reddb-io/red-skills-link-protocol/protocol";

import {
  addPairedHost,
  loadPairedHosts,
  removePairedHost,
  type PairedHostKV,
} from "../src/transport/paired-host-store";

function host(id: string, name: string): RedskilledLinkPairedHost {
  return {
    version: 1,
    relay_url: "wss://relay.example",
    host_id: id,
    host_name: name,
    device_id: `device-for-${id}`,
    device_secret: "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0ISE",
  };
}

function memoryKV(initial: Record<string, string> = {}): PairedHostKV & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    set: async (key, value) => { data.set(key, value); },
    delete: async (key) => { data.delete(key); },
  };
}

describe("the paired-host store holds a fleet", () => {
  it("adding a second Host keeps the first", async () => {
    const kv = memoryKV();
    await addPairedHost(host("h1", "laptop"), kv);
    const after = await addPairedHost(host("h2", "desktop"), kv);

    expect(after.map((entry) => entry.host_id)).toEqual(["h1", "h2"]);
    await expect(loadPairedHosts(kv)).resolves.toHaveLength(2);
  });

  it("re-pairing the same Host replaces its record instead of duplicating it", async () => {
    const kv = memoryKV();
    await addPairedHost(host("h1", "laptop"), kv);
    const after = await addPairedHost({ ...host("h1", "laptop"), device_id: "device-2" }, kv);

    expect(after).toHaveLength(1);
    expect(after[0]?.device_id).toBe("device-2");
  });

  it("migrates the v1 single-host record into the list and retires the legacy key", async () => {
    const kv = memoryKV({
      "redskilled-link.paired-host.v1": encodePairedHost(host("h-legacy", "old-laptop")),
    });

    const loaded = await loadPairedHosts(kv);
    expect(loaded.map((entry) => entry.host_id)).toEqual(["h-legacy"]);
    expect(kv.data.has("redskilled-link.paired-host.v1")).toBe(false);
    expect(kv.data.has("redskilled-link.paired-hosts.v2")).toBe(true);
  });

  it("removing a Host forgets only that Host, and an empty fleet clears the key", async () => {
    const kv = memoryKV();
    await addPairedHost(host("h1", "laptop"), kv);
    await addPairedHost(host("h2", "desktop"), kv);

    const afterOne = await removePairedHost("h1", kv);
    expect(afterOne.map((entry) => entry.host_id)).toEqual(["h2"]);

    await removePairedHost("h2", kv);
    expect(kv.data.has("redskilled-link.paired-hosts.v2")).toBe(false);
  });

  it("a corrupt entry loses that entry, never the fleet", async () => {
    const kv = memoryKV();
    await addPairedHost(host("h1", "laptop"), kv);
    kv.data.set(
      "redskilled-link.paired-hosts.v2",
      `${kv.data.get("redskilled-link.paired-hosts.v2")}\nnot-a-record`,
    );

    const loaded = await loadPairedHosts(kv);
    expect(loaded.map((entry) => entry.host_id)).toEqual(["h1"]);
  });
});
