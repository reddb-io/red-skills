# 0159 — Android-first remote transport prefers WireGuard and falls back to WSS

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0158 (Remote link boundary); ADR 0130 (`redskilled` stays host-local)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q13–Q19

## Context

The mobile client must reach several heterogeneous Hosts from home, mobile, and restricted networks without requiring a second VPN application. A raw WireGuard peer supplies encryption but not discovery, key distribution, NAT traversal, or fallback; building a full peer-to-peer mesh would reproduce the hardest part of Tailscale-like systems before the remote-control product is proven.

## Decision

`apps/redskilled-mobile` is Android-first and uses Expo/React Native with a development build plus a local Kotlin native module. That module owns Android `VpnService` integration and the embedded WireGuard peer. The first topology is a central WireGuard hub served by `apps/redskilled-link`; the mobile client and every Host establish outbound tunnels to it. The same Link artifact also serves a WSS relay, and the client falls back automatically when the preferred WireGuard transport cannot connect. Both paths carry one authenticated application protocol, so changing transport changes neither command semantics nor remote authority. iOS remains a planned second platform with a Swift `NEPacketTunnelProvider` implementation of the same native contract.

## Considered options

- Peer-to-peer WireGuard with NAT traversal and relay fallback. Deferred because endpoint discovery, hole punching, coordination, and recovery are a mesh control plane of their own.
- Require an external WireGuard or NetBird app. Rejected because installing and switching to a second application breaks the intended one-scan mobile onboarding.
- WSS relay only. Rejected because the product deliberately includes a private-network path that can later serve more than one application stream without changing the mobile surface.
