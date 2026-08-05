// host.ts — read-only visibility into the machine-wide redskilled daemon.
//
// A project read answers only for the checkout that called it. Host-scoped
// status deliberately crosses that boundary so an operator can diagnose the host
// that owns every project's Workers, while exposing none of the daemon's
// mutating `provision` or `reclaim` commands (ADR 0130, issue #3163).

export interface HostDependencies {
  hostState(): Promise<unknown>;
  hostDashboard(): Promise<unknown>;
  hostProvisionCheck(): Promise<unknown>;
  hostUnitStatus(): Promise<unknown>;
}
