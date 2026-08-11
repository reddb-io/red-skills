import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decode, type JsonValue } from "@reddb-io/toon";
import { serialize as encode } from "@reddb-io/toon/legacy";
import type { EnginePaths } from "./paths.js";
import { isRunner, runners, type Runner } from "./runner-types.js";
import { createSingletonEventLane } from "./singleton-event-lane.js";

export const GATE_WEIGHT_CLASSES = [
  "light-cone",
  "heavy-cone",
  "full-workspace",
] as const;

export type GateWeightClass = (typeof GATE_WEIGHT_CLASSES)[number];

export interface HostCapabilityProfile {
  readonly machineIdHash: string;
  readonly runners: readonly Runner[];
  readonly maxGateWeight: GateWeightClass;
  readonly defaultFleetWidth: number;
}

export interface ResolvedHostCapabilities {
  readonly runners: readonly Runner[];
  readonly maxGateWeight: GateWeightClass;
  readonly defaultFleetWidth: number;
  readonly source: "profile" | "permissive-default";
}

export interface HostGateAdmission {
  readonly admitted: boolean;
  readonly verdict: "admitted" | "refused-over-class";
  readonly required: GateWeightClass;
  readonly maximum: GateWeightClass;
}

export function evaluateHostGateAdmission(
  profile: HostCapabilityProfile | undefined,
  required: GateWeightClass,
): HostGateAdmission {
  const maximum = resolveHostCapabilities(profile).maxGateWeight;
  const admitted =
    GATE_WEIGHT_CLASSES.indexOf(required) <=
    GATE_WEIGHT_CLASSES.indexOf(maximum);
  return {
    admitted,
    verdict: admitted ? "admitted" : "refused-over-class",
    required,
    maximum,
  };
}

export function resolveHostCapabilities(
  profile: HostCapabilityProfile | undefined,
): ResolvedHostCapabilities {
  if (profile === undefined) {
    return {
      runners: [...runners],
      maxGateWeight: "full-workspace",
      defaultFleetWidth: 2,
      source: "permissive-default",
    };
  }
  const validated = validateHostCapabilityProfile(profile);
  return {
    runners: validated.runners,
    maxGateWeight: validated.maxGateWeight,
    defaultFleetWidth: validated.defaultFleetWidth,
    source: "profile",
  };
}

const MACHINE_ID_HASH_RE = /^[0-9a-f]{12}$/;

function validateHostCapabilityProfile(value: unknown): HostCapabilityProfile {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("host capability profile must be a record");
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.machineIdHash !== "string" ||
    !MACHINE_ID_HASH_RE.test(raw.machineIdHash)
  ) {
    throw new Error(
      "host capability profile machineIdHash must be a 12-character lowercase hex hash",
    );
  }
  if (
    !Array.isArray(raw.runners) ||
    raw.runners.length === 0 ||
    !raw.runners.every(
      (runner) => typeof runner === "string" && isRunner(runner),
    )
  ) {
    throw new Error(
      "host capability profile runners must contain supported runners",
    );
  }
  if (
    !(GATE_WEIGHT_CLASSES as readonly unknown[]).includes(raw.maxGateWeight)
  ) {
    throw new Error("host capability profile maxGateWeight is invalid");
  }
  if (
    !Number.isSafeInteger(raw.defaultFleetWidth) ||
    (raw.defaultFleetWidth as number) <= 0
  ) {
    throw new Error(
      "host capability profile defaultFleetWidth must be a positive integer",
    );
  }
  return {
    machineIdHash: raw.machineIdHash,
    runners: [...new Set(raw.runners as Runner[])],
    maxGateWeight: raw.maxGateWeight as GateWeightClass,
    defaultFleetWidth: raw.defaultFleetWidth as number,
  };
}

export function hostCapabilityProfilePath(paths: EnginePaths): string {
  return join(paths.castleStateRoot, "host-capability.toon");
}

export async function readHostCapabilityProfile(
  paths: EnginePaths,
): Promise<HostCapabilityProfile | undefined> {
  try {
    return validateHostCapabilityProfile(
      decode(await readFile(hostCapabilityProfilePath(paths), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeHostCapabilityProfile(
  paths: EnginePaths,
  profile: HostCapabilityProfile,
): Promise<HostCapabilityProfile> {
  const validated = validateHostCapabilityProfile(profile);
  const path = hostCapabilityProfilePath(paths);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(
    temporary,
    encode(validated as unknown as JsonValue, { keyedMapCollapse: true }),
    "utf8",
  );
  await rename(temporary, path);
  await createSingletonEventLane(paths).append({
    singleton: "host-capabilities",
    kind: "host.capability-profile.registered",
    payload: {
      machine_id_hash: validated.machineIdHash,
      runners: [...validated.runners],
      max_gate_weight: validated.maxGateWeight,
      default_fleet_width: validated.defaultFleetWidth,
    },
  });
  return validated;
}
