// statusline-native-source — the native front's TypeScript, as a constant.
//
// Embedded rather than staged beside the bundle, because the STABILIZED bundle
// (`~/.red/redskilled/bundles/…`) has no package tree beside it — a compile
// that resolved the source relative to the entry would work from an npx
// dispatch and silently never from the stabilized copy. ~1.5KB of source is
// cheaper than a second distribution channel (ADR 0157).
//
// The program deliberately lives inside scriptc's STATIC subset: file reads,
// string ops, JSON.parse — no sockets, no child processes, no `String.replace`
// (unlowered as of scriptc 0.0.35). Anything the render needs beyond that is
// the lean bundle's job; this binary only prints the last document.
export const STATUSLINE_NATIVE_SOURCE = `// statusline-fast — native statusline front (generated from
// apps/redskilled/src/statusline-native-source.ts; ADR 0157).
//
// Prints the project's last full statusline render instantly. The heavy
// renderer (the lean node bundle) runs in the BACKGROUND after every prompt
// render and writes the next document here, so the prompt pays ~2ms while the
// daemon tail stays at most one render old. The cache is PER PROJECT (the
// prompt host runs this with cwd = the repo), so one project's render never
// appears inside another project's session.
import { readFileSync, existsSync, statSync } from "node:fs";

const cachePath = ".red/state/statusline/last-render.txt";
// ADR 0157 promises "at most one render old". A render happens per prompt, so
// a cache this stale means the background renderer stopped rewriting it — and
// the one thing worse than an old line is an old line wearing a live face.
const staleAfterMs = 900000;

if (existsSync(cachePath)) {
  const cached = readFileSync(cachePath, "utf8");
  if (cached.trim() !== "") {
    let suffix = "";
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(cachePath).mtimeMs;
    } catch {
      ageMs = 0;
    }
    if (ageMs > staleAfterMs) {
      const minutes = Math.floor(ageMs / 60000);
      suffix = " !stale " + minutes + "m";
    }
    const body = cached.endsWith("\\n") ? cached.slice(0, cached.length - 1) : cached;
    process.stdout.write(body + suffix + "\\n");
    process.exit(0);
  }
}

// First render in this project: no cached document yet. Say something true
// from the payload rather than nothing — the background renderer fills the
// cache for the next render.
let model = "…";
try {
  const raw = readFileSync(0, "utf8");
  const payload = JSON.parse(raw === "" ? "{}" : raw) as { model?: { display_name?: string } };
  model = payload.model?.display_name ?? "…";
} catch {
  model = "…";
}
console.log(model + " — statusline warming up");
process.exit(0);
`;
