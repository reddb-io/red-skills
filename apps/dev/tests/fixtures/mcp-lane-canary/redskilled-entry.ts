// Harness stand-in for the installed `redskilled` binary.
//
// It is the REAL daemon entry, bundled so a child process can run it: the
// canary's socket-boundary step is only worth its name when the thing on the
// other side of the socket is the daemon operators run, not a mock that answers
// whatever the assertion wants to hear.

// A bare import, deliberately: the CLI runs itself when it IS the entry, which
// is what this bundle is. Calling `runRedskilledCli` on top of that would start
// two daemons in one process, and the second would refuse the socket the first
// just bound.
import "@reddb-io/redskilled/cli";
