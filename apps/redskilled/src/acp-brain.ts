// acp-brain — the `brain` `_redskills/*` domain: one method, every brain tool.
//
// The domain is deliberately thin, because everything worth deciding was
// already decided elsewhere: WHERE the store is belongs to the host resolution
// (ADR 0152), WHICH tools exist belongs to the shared wire, and HOLDING the
// handle belongs to `brain-store.ts`. What is left here is binding one method
// onto a holder the daemon created once.
//
// Every connection's domain closes over the SAME holder, which is what makes
// "two sessions share one store handle" a structural fact rather than a habit:
// a connection is given no way to open one of its own.
import {
  parseRedskilledBrainCall,
  REDSKILLED_BRAIN_TOOLS,
  REDSKILLS_ACP_METHODS,
  type RedskilledBrainAnswer,
  type RedskilledBrainCall,
} from "@reddb-io/protocol-acp";

import {
  redskillsAcpMethod,
  type RedskillsAcpMethodDomain,
} from "./acp-method-registry.js";
import type { HostBrainStore } from "./brain-store.js";

export const REDSKILLED_BRAIN_CALL_METHOD = REDSKILLS_ACP_METHODS.brainCall;

export interface AcpBrainDeps {
  /** The host's one holder. Never constructed per connection. */
  readonly store: HostBrainStore;
}

/**
 * Bind the brain surface for one connection.
 *
 * The capability is advertised unconditionally: unlike the GitHub gateway or
 * the host counters, a brain store needs no registration and no authority to
 * answer — it is the operator's own notes, and every session of theirs on this
 * machine is entitled to the same one.
 */
export function brainMethodDomain(deps: AcpBrainDeps): RedskillsAcpMethodDomain {
  return {
    domain: "brain",
    bindings: [
      redskillsAcpMethod(
        REDSKILLS_ACP_METHODS.brainCall,
        parseRedskilledBrainCall,
        ({ params }: { params: RedskilledBrainCall }): Promise<RedskilledBrainAnswer> =>
          deps.store.call(params),
      ),
    ],
    capability: {
      brain: {
        version: 1,
        methods: [REDSKILLS_ACP_METHODS.brainCall],
        tools: REDSKILLED_BRAIN_TOOLS,
      },
    },
  };
}
