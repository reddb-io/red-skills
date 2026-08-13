import { homedir } from "node:os";
import { encode } from "@reddb-io/toon";
import { parseFlags } from "@reddb-io/shared/args.js";
import { redskilledResourceIncidentRoot } from "./paths.js";
import { createResourceIncidentStore, type ResourceIncidentStore } from "./resource-incidents.js";

export const RESOURCE_INCIDENTS_USAGE = `Usage: redskilled incidents [list|show <incident-id>] [options]

Reads bounded, secret-free resource incidents from the host store without
contacting the daemon. Defaults to list.

  --worker <id>  list only incidents for this Worker
  --since <ISO>  list incidents opened at or after this instant
`;

const FLAGS = {
  worker: { kind: "value", coerce: (raw: string) => raw },
  since: { kind: "value", coerce: (raw: string) => raw },
} as const;

export async function runResourceIncidents(
  args: readonly string[],
  io: { readonly store?: ResourceIncidentStore; readonly homeDir?: string; readonly write?: (text: string) => void } = {},
): Promise<number> {
  const action = args[0]?.startsWith("-") === false ? args[0] : "list";
  const actionArgs = action === "list" && args[0] !== "list" ? args : args.slice(1);
  const store = io.store ?? createResourceIncidentStore({ root: redskilledResourceIncidentRoot(io.homeDir ?? homedir()) });
  const write = io.write ?? ((text: string) => process.stdout.write(text));
  if (action === "list") {
    const { values, positionals } = parseFlags(actionArgs, FLAGS, { unknownFlags: "error" });
    if (positionals.length > 0) throw new Error(`unexpected incidents list argument ${JSON.stringify(positionals[0])}`);
    const sinceMs = values.since === undefined ? undefined : Date.parse(values.since);
    if (values.since !== undefined && !Number.isFinite(sinceMs)) {
      throw new Error(`redskilled incidents --since must be an ISO instant; received ${JSON.stringify(values.since)}`);
    }
    const rows = await store.list({
      ...(values.worker === undefined ? {} : { workerId: values.worker }),
      ...(sinceMs === undefined ? {} : { sinceMs }),
    });
    write(`${encode(rows as never)}\n`);
    return 0;
  }
  if (action === "show") {
    const incidentId = actionArgs[0];
    if (incidentId === undefined || actionArgs.length !== 1) throw new Error("redskilled incidents show requires exactly one incident id");
    const incident = await store.read(incidentId);
    if (incident === undefined) {
      write(`${encode({ found: false, incident_id: incidentId })}\n`);
      return 1;
    }
    write(`${encode(incident as never)}\n`);
    return 0;
  }
  throw new Error(`unsupported redskilled incidents action ${JSON.stringify(action)}: expected list or show`);
}
