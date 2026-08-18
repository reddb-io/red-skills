---
"@reddb-io/red-skills": patch
---

Publish again: sign the package-set manifest in the Sigstore bundle format and verify it against an explicit trusted root, so the release's offline verification no longer reaches for the network and blocks npm publish (v3.19.0 never reached the registry, which broke every `install.sh` host).
