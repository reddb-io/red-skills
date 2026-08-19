/**
 * plugin-discovery.ts — list every plugin directory under the
 * `plugins/` source tree. A "plugin" is a direct subdirectory of
 * `plugins/` that has a `.claude-plugin/plugin.json` (or, for newer
 * plugins, a `.codex-plugin/plugin.json`); the directory name is the
 * plugin's identity (`dev`, `memory`, `brain`, …).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredPlugin {
  name: string;
  /** Absolute path to the plugin's source root. */
  source: string;
}

/** Return every plugin under `pluginsRoot`, in name-sorted order. */
export function listPluginDirs(pluginsRoot: string): DiscoveredPlugin[] {
  if (!existsSync(pluginsRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(pluginsRoot);
  } catch {
    return [];
  }
  const out: DiscoveredPlugin[] = [];
  for (const name of entries) {
    const abs = join(pluginsRoot, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const hasClaude = existsSync(join(abs, ".claude-plugin", "plugin.json"));
    const hasCodex = existsSync(join(abs, ".codex-plugin", "plugin.json"));
    if (hasClaude || hasCodex) out.push({ name, source: abs });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
