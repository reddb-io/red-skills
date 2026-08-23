# 0161 — The Link relay is self-hosted

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0158 (Remote-link boundary); ADR 0159 (WireGuard hub with WSS fallback); ADR 0160 (`/redskilled` owns Host setup)
- **Source**: `/start` grilling session of 2026-08-23, maintainer rounds Q25–Q26

## Context

The central topology in ADR 0159 needs a publicly reachable rendezvous point before a mobile client can reach Hosts behind NAT. An official relay would simplify first use, but it would also introduce a hosted control plane, user accounts, abuse handling, availability commitments, traffic-retention policy, and continuing infrastructure cost before the remote-control product is proven. LAN-only operation would avoid those obligations but would not satisfy remote control across ordinary home and mobile networks.

## Decision

RedSkills ships the complete open-source `redskilled-link relay`, but operates no public relay required by the product in V1. The operator must deploy a reachable **Link relay** or explicitly choose a deployment they trust before remote onboarding. Mobile clients and Host-side Remote links connect outbound to that relay. It serves the central WireGuard hub and WSS fallback from ADR 0159 while carrying the same end-to-end authenticated application protocol on both paths.

The Link relay is transport infrastructure, not a control-plane authority: it owns no Project, Worker, daemon-local GitHub credential, or mobile authorization decision. A future optional managed relay may implement the same public protocol, but V1 onboarding, documentation, and tests may not depend on one.

## Considered options

- Operate a default public relay while keeping self-hosting available. Rejected for V1 because it makes hosted-service operations and policy part of the product's critical path.
- Support only LAN or directly reachable Hosts. Rejected because the primary use case crosses NAT between heterogeneous personal machines and a mobile network.
