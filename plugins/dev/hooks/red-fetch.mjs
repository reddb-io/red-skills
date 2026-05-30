#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
import{createHash as E}from"node:crypto";import{existsSync as F}from"node:fs";import{appendFile as D,mkdir as v,readFile as I,writeFile as O}from"node:fs/promises";import{homedir as C}from"node:os";import{dirname as S,join as g}from"node:path";var c=class extends Error{kind;cause;constructor(n,t,r){super(t),this.name="BundleFetchError",this.kind=n,this.cause=r}};function $(e,n){return`${e}-${n}.bundle.min.mjs`}function d(e){let{plugin:n,version:t,cacheDir:r}=e;return A(r,$(n,t))}function f(e,n,t){return`https://github.com/${e}/releases/download/v${n}/${t}`}function b(e){return`${e}.bundle.min.mjs`}function x(e){return`${e}.manifest.json`}async function m(e,n){let{plugin:t,version:r,repo:s,cacheDir:o}=n,i=d({plugin:t,version:r,cacheDir:o}),a=await B(e,s,t,r);if(await e.exists(i))try{if(e.sha256(await e.readFile(i))===a.sha256.toLowerCase())return i}catch{}let u=b(t),l;try{l=await e.download(f(s,r,u))}catch(p){throw w(p,u)}let h=e.sha256(l);if(h!==a.sha256.toLowerCase())throw new c("checksum-mismatch",`checksum mismatch for ${u}: ${h} != ${a.sha256}`);return await e.writeFile(i,l),i}async function B(e,n,t,r){let s=x(t),o;try{o=await e.download(f(n,r,s))}catch(a){throw w(a,s)}let i;try{i=JSON.parse(new TextDecoder().decode(o))}catch(a){throw new c("manifest-invalid",`manifest ${s} is not valid JSON`,a)}if(!k(i))throw new c("manifest-invalid",`manifest ${s} missing required fields {plugin, version, sha256}`);return{...i,sha256:i.sha256.toLowerCase()}}function k(e){if(typeof e!="object"||e===null)return!1;let n=e;return typeof n.plugin=="string"&&typeof n.version=="string"&&typeof n.sha256=="string"&&/^[0-9a-f]{64}$/i.test(n.sha256)}function w(e,n){let t=e instanceof Error?e.message:String(e);return/\b404\b|not found|missing/i.test(t)?new c("asset-missing",`release asset ${n} not found: ${t}`,e):new c("network",`failed to download ${n}: ${t}`,e)}function A(e,n){return e.endsWith("/")?`${e}${n}`:`${e}/${n}`}var y="reddb-io/red-skills";function U(e){return e||(process.env.RED_SKILLS_CACHE_DIR?process.env.RED_SKILLS_CACHE_DIR:process.env.XDG_CACHE_HOME?g(process.env.XDG_CACHE_HOME,"red-skills","bundles"):g(C(),".cache","red-skills","bundles"))}var R={async download(e){let n=await fetch(e,{redirect:"follow"});if(!n.ok)throw new Error(`GET ${e} -> ${n.status}`);return new Uint8Array(await n.arrayBuffer())},async readFile(e){return new Uint8Array(await I(e))},async writeFile(e,n){await v(S(e),{recursive:!0}),await O(e,n)},async exists(e){return F(e)},sha256(e){return E("sha256").update(e).digest("hex")}};async function _(e,n){try{await v(e,{recursive:!0}),await D(g(e,"red-fetch.log"),`[${new Date().toISOString()}] ${n}
`)}catch{}process.stderr.write(`red-fetch: ${n}
`)}function P(e){let n={repo:y,help:!1},t=[];for(let r=0;r<e.length;r++){let s=e[r];s==="--help"||s==="-h"?n.help=!0:s==="--repo"?n.repo=e[++r]??n.repo:s==="--cache-dir"?n.cacheDir=e[++r]:s.startsWith("-")||t.push(s)}return n.plugin=t[0],n.version=t[1],n}var H=`red-fetch \u2014 resolve a plugin's built bundle from its GitHub Release into a local cache.

Usage:
  node red-fetch.mjs <plugin> <version> [--repo owner/name] [--cache-dir DIR]

Arguments:
  <plugin>     plugin name (e.g. dev, memory)
  <version>    plugin version without the leading v (e.g. 1.140.0)

Options:
  --repo       GitHub repo publishing the release (default: ${y})
  --cache-dir  override the bundle cache dir
  -h, --help   show this help

Best-effort: never blocks session start. On any failure it logs to
<cache-dir>/red-fetch.log and exits 0.`;async function L(){let e=P(process.argv.slice(2)),n=U(e.cacheDir);(e.help||!e.plugin||!e.version)&&(process.stdout.write(`${H}
`),!e.help&&(!e.plugin||!e.version)&&process.stdout.write(`
red-fetch: missing <plugin> and/or <version>; nothing to do.
`),process.exit(0));let{plugin:t,version:r}=e,s=d({plugin:t,version:r,cacheDir:n});try{let o=await m(R,{plugin:t,version:r,repo:e.repo,cacheDir:n});process.stdout.write(`red-fetch: bundle ready at ${o}
`)}catch(o){let i=o instanceof c?o.kind:"unknown",a=o instanceof Error?o.message:String(o);await _(n,`${i}: ${a} (plugin=${t} version=${r})`),process.stdout.write(`red-fetch: could not fetch ${t}@${r} (${i}); expected cache path ${s}. Continuing \u2014 fetch is best-effort.
`)}process.exit(0)}L();
