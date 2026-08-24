# Redskilled Mobile

Android-first Expo development build for dispatching a Worker from a GitHub
Issue URL on a paired Redskilled Host.

## Current slice

- Expo SDK 57 with `expo-dev-client`
- Host + Issue URL dispatch screen
- strict GitHub Issue URL parsing and canonicalisation
- one-use invitation pairing persisted in Android SecureStore
- encrypted TOON Remote-link frames over the transport-only WSS relay
- live Worker observation, existing-Issue dispatch, and single-Worker stop

The relay cannot read operation payloads or mint a device capability. The Host
projects only the Mobile operator allowlist onto local redskilled ACP.

## Commands

Run from the repository root:

```bash
pnpm --filter @reddb-io/redskilled-mobile test
pnpm --filter @reddb-io/redskilled-mobile typecheck
pnpm --filter @reddb-io/redskilled-mobile android
```

## Signed Android APK

Run `bash scripts/setup-redskilled-android-signing.sh` once to create the
long-lived release key and install its four values as GitHub Actions secrets.
Keep an offline backup of the generated `.jks`: Android requires the same key
for every future update of `io.reddb.redskilled`.

The `Redskilled Mobile APK` workflow can be run manually for a smoke build. On
every `v*` tag it builds a signed release APK, verifies its certificate, emits
a SHA-256 sidecar, and attaches both files to the matching GitHub Release.
