# 0163 — Mobile devices pair with each Host

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0144 (capability-scoped clients); ADR 0158 (Remote-link boundary); ADR 0161 (transport-only self-hosted relay)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q29–Q30

## Context

One mobile app must control several personal Hosts that may share one Link relay. Pairing once with that relay would make transport infrastructure an authorization authority, contrary to ADR 0161, and compromise of the relay could silently widen access to every enrolled machine. A shared fleet password would have the same blast radius while making individual-device revocation impossible.

## Decision

Every mobile device performs **Host pairing** independently with every Host it may control. `/redskilled` asks the Host-side Remote link to create a single-use, short-lived invitation rendered as a QR code with a manual short-code alternative. Redeeming it establishes an end-to-end device identity and explicit capability-scoped Client authority on that Host. The Host stores its own paired-device and revocation state; removing a device from one Host does not affect another.

The invitation is bootstrap material, not a durable bearer credential. It cannot be reused after redemption or expiry, contains no daemon-local GitHub credential, and does not grant access to another Host merely because both use the same Link relay. The relay routes the encrypted exchange but cannot mint, redeem, widen, or revoke a pairing.

## Considered options

- Pair once with the Link relay and inherit access to every registered Host. Rejected because it promotes transport into an authorization control plane and creates a fleet-wide compromise boundary.
- Configure one password or shared key across every Host and device. Rejected because it cannot express per-device revocation or per-Host capability scope and encourages reusable secret distribution.
