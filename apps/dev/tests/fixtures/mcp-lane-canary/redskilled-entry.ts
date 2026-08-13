// Harness stand-in for the installed `redskilled` binary.
//
// It is the REAL daemon entry, bundled so a child process can run it: the
// canary's socket-boundary step is only worth its name when the thing on the
// other side of the socket is the daemon operators run, not a mock that answers
// whatever the assertion wants to hear.

import { armTestProcessLifetime } from "../../support/test-process-lifetime.js";

armTestProcessLifetime();

// The CLI runs itself when it IS the entry. Import it only after arming the
// fixture ceiling; a static import would evaluate the long-lived daemon before
// this module's body could install the timer.
await import("@reddb-io/redskilled/cli");
