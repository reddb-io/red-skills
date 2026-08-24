import * as SecureStore from "expo-secure-store";
import {
  decodePairedHost,
  encodePairedHost,
} from "@reddb-io/red-skills-link-protocol/crypto";
import type { RedskilledLinkPairedHost } from "@reddb-io/red-skills-link-protocol/protocol";

const PAIRED_HOST_KEY = "redskilled-link.paired-host.v1";

export async function loadPairedHost(): Promise<RedskilledLinkPairedHost | null> {
  const encoded = await SecureStore.getItemAsync(PAIRED_HOST_KEY);
  if (encoded == null) return null;
  try {
    return decodePairedHost(encoded);
  } catch {
    await SecureStore.deleteItemAsync(PAIRED_HOST_KEY);
    return null;
  }
}

export async function savePairedHost(host: RedskilledLinkPairedHost): Promise<void> {
  await SecureStore.setItemAsync(PAIRED_HOST_KEY, encodePairedHost(host), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}
