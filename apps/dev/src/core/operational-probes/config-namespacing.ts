import type { OperationalProbe, OperationalProbeResult } from "./types.js";

const CANONICAL_FIX = "Move root-level dev-plugin settings under plugins.dev.* in .red/config.yaml.";

export const configNamespacingProbe: OperationalProbe = {
  id: "config.dev-root-spelling",
  name: "Config dev-plugin namespacing",
  canonicalFix: CANONICAL_FIX,
  run(context): OperationalProbeResult {
    const rootDevKeys = [...(context.configNamespacing?.rootDevKeys ?? [])].sort();
    if (rootDevKeys.length === 0) {
      return {
        id: this.id,
        name: this.name,
        verdict: "ok",
        evidence: "no root-level dev.* settings",
        canonicalFix: this.canonicalFix,
      };
    }

    const canonicalKeys = rootDevKeys.map((key) => `plugins.${key}`);
    return {
      id: this.id,
      name: this.name,
      verdict: "red",
      evidence: `root-level ${rootDevKeys.join(", ")} is off-contract; canonical ${canonicalKeys.join(", ")}`,
      canonicalFix: `${this.canonicalFix} For example, use ${canonicalKeys[0]}.`,
      data: { rootDevKeys, canonicalKeys },
    };
  },
};
