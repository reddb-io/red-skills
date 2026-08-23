# Redskilled Mobile

Android-first Expo development build for dispatching a Worker from a GitHub
Issue URL on a paired Redskilled Host.

## Current slice

- Expo SDK 57 with `expo-dev-client`
- Host + Issue URL dispatch screen
- strict GitHub Issue URL parsing and canonicalisation
- development-only dispatch gateway that produces a visible preview Worker
- production fails closed until the Remote-link transport is implemented

The preview is deliberately behind `__DEV__`; it is not a temporary network
protocol. The production Remote-link gateway will use TOON wire frames.

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
