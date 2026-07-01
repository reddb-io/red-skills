// @reddb-io/browser-bridge — CLI<->browser annotation bridge + layout-audit gate.
//
// The artifact-annotation half of the browser-collaboration capability (PRD #928): open a
// generated HTML artifact, inject a portable feedback SDK, long-poll for human
// annotations (element + character range), and block "done" on a broken render.
// No cloud — all state under .red/browser-bridge/.

export * from "./annotation.js";
export * from "./inject.js";
export * from "./layout-audit.js";
export * from "./session.js";
export * from "./server.js";
