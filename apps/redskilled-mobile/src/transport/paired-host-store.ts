/**
 * paired-host-store — every Host this device has paired, in the secure store.
 *
 * v2 is a LIST: the whole point of the Remote link is seeing all of an
 * operator's machines, and a store that could hold one Host made "add a
 * second" silently forget the first. The value is the base64url paired-host
 * records joined by newlines — no serialization format of our own, just the
 * codec the pairing already speaks, one per line. A v1 single record migrates
 * into the list on first read and the legacy key is retired.
 *
 * The KV boundary is injectable so the store's behavior (round-trip,
 * migration, removal, corrupt-entry policy) is asserted by tests that never
 * touch a device keychain.
 */
import {
  decodePairedHost,
  encodePairedHost,
} from "@reddb-io/red-skills-link-protocol/crypto";
import type { RedskilledLinkPairedHost } from "@reddb-io/red-skills-link-protocol/protocol";

const PAIRED_HOSTS_KEY = "redskilled-link.paired-hosts.v2";
const LEGACY_PAIRED_HOST_KEY = "redskilled-link.paired-host.v1";

export interface PairedHostKV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

// Imported lazily so the store's LOGIC loads without the native module: the
// tests inject their own KV, and expo-secure-store's untranspiled source is
// only resolvable inside the Expo bundler.
const secureStore = () => import("expo-secure-store");

const secureStoreKV: PairedHostKV = {
  get: async (key) => (await secureStore()).getItemAsync(key),
  set: async (key, value) => {
    const store = await secureStore();
    await store.setItemAsync(key, value, {
      keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  },
  delete: async (key) => (await secureStore()).deleteItemAsync(key),
};

/** Every paired Host, oldest first. A corrupt line is dropped, not fatal. */
export async function loadPairedHosts(
  kv: PairedHostKV = secureStoreKV,
): Promise<readonly RedskilledLinkPairedHost[]> {
  const encoded = await kv.get(PAIRED_HOSTS_KEY);
  if (encoded != null) return decodeLines(encoded);

  // One-time migration: a device paired before the list existed keeps its Host.
  const legacy = await kv.get(LEGACY_PAIRED_HOST_KEY);
  if (legacy == null) return [];
  const migrated = decodeLines(legacy);
  await persist(kv, migrated);
  await kv.delete(LEGACY_PAIRED_HOST_KEY);
  return migrated;
}

/** Add or replace one Host (matched by `host_id`) and return the new list. */
export async function addPairedHost(
  host: RedskilledLinkPairedHost,
  kv: PairedHostKV = secureStoreKV,
): Promise<readonly RedskilledLinkPairedHost[]> {
  const current = await loadPairedHosts(kv);
  const next = [...current.filter((entry) => entry.host_id !== host.host_id), host];
  await persist(kv, next);
  return next;
}

/** Forget one Host on this device. The Host's own registry is not touched. */
export async function removePairedHost(
  hostId: string,
  kv: PairedHostKV = secureStoreKV,
): Promise<readonly RedskilledLinkPairedHost[]> {
  const current = await loadPairedHosts(kv);
  const next = current.filter((entry) => entry.host_id !== hostId);
  await persist(kv, next);
  return next;
}

async function persist(kv: PairedHostKV, hosts: readonly RedskilledLinkPairedHost[]): Promise<void> {
  if (hosts.length === 0) {
    await kv.delete(PAIRED_HOSTS_KEY);
    return;
  }
  await kv.set(PAIRED_HOSTS_KEY, hosts.map(encodePairedHost).join("\n"));
}

function decodeLines(encoded: string): RedskilledLinkPairedHost[] {
  const hosts: RedskilledLinkPairedHost[] = [];
  for (const line of encoded.split("\n")) {
    if (line.trim() === "") continue;
    try {
      hosts.push(decodePairedHost(line));
    } catch {
      // A corrupt entry loses that entry, never the whole fleet.
    }
  }
  return hosts;
}
