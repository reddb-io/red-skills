# 0169 — An Issue URL is the mobile dispatch input

- **Status**: accepted
- **Date**: 2026-08-23
- **Related**: ADR 0164 (Ticket-first mobile dispatch); ADR 0165 (atomic manual claim); ADR 0167 (remote Project provisioning); ADR 0168 (`personal` profile)
- **Source**: `/start` grilling session of 2026-08-23, maintainer simplification after Q42

## Context

The design had split the core mobile action into Host selection, Project selection or provisioning, Issue selection or creation, and dispatch. That exposed daemon structure before the operator's actual intent: start a Worker from any existing Issue in any repository they own. Because a GitHub Issue URL already identifies both repository and Ticket, separate Project navigation and provisioning make the common path longer without adding information.

## Decision

The V1 mobile dispatch input is one GitHub Issue URL after Host selection. redskilled parses the repository and Ticket number, authenticates through the Host's daemon-local `personal` profile, resolves the stable repository identity, idempotently creates or reuses the canonical Project workspace, validates the Issue, atomically claims it under ADR 0165, and births its Worker. The app then observes and controls that Worker while keeping Issue, comments, PR, and outcome in one traceable chain.

The app has no required Host → Project → Issue setup funnel, no repository browser, and no separate Add Project screen. Project and Ticket lists may exist as observational shortcuts later, but dispatch never depends on prior Project registration. Creating a new Issue may also arrive later; V1 proves dispatch from an existing Issue URL. Repository cloning and registration remain explicit daemon operations internally, but mobile composes them as an idempotent prerequisite rather than presenting them as user work.

This amends ADR 0164's first-slice navigation and ADR 0167's separately-invoked mobile provisioning flow while preserving their Ticket-first, daemon-owned identity, workspace, and credential boundaries.

## Considered options

- Require the operator to select or provision a Project before selecting an Issue. Rejected because the Issue URL already carries the repository and turns Project setup into accidental complexity.
- Browse repositories and Issues in the app. Deferred as a convenience view; it is not necessary to dispatch any known Issue.
- Accept free-form demand text. Rejected because the user's unit of intent is an existing durable GitHub Issue, not an anonymous prompt.
