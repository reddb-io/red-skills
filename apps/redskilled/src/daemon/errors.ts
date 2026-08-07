import type { RedskilledLease } from "../session-lease.js";

/** Raised when another daemon already serves this user session. */
export class RedskilledAlreadyRunningError extends Error {
  constructor(
    readonly socketPath: string,
    readonly lease?: RedskilledLease,
  ) {
    super(`a redskilled daemon already owns ${JSON.stringify(socketPath)}`);
    this.name = "RedskilledAlreadyRunningError";
  }
}
