# Vendored reddb.io Design System

This directory is the Redskilled Mobile Product Surface's pinned Design System
input. It is copied into `red-skills`; the mobile app has no runtime, package,
workspace, symlink, or build dependency on the sibling `design-system` repo.

- Source repository: `reddb-io/design-system`
- Source ref: `latest`
- Source commit: `4dfdc7a36723f8ffef5a66d92b138bcc25d70f95`
- Design System release lineage: `2026.08.4` plus the rolling `latest` fixes
- Brand Assets input declared by the generated Tokens Layer: `2026.08.2`
- Vendored on: `2026-08-24`

## Copied contracts

- `tokens/`: generated Tokens Layer plus the compact Density stop
- `theme/`: Base Theme, Application Theme, and dark Color Scheme
- `platform/`: published platform identity assets
- `fonts/`: the TTF forms of the same pinned Space Grotesk and JetBrains Mono
  assets used to produce the browser-ready files in the Assets Contract, plus
  their OFL licenses

The Design System currently distributes its App Kit as Svelte components. A
React Native Product Surface cannot execute those components, so
`src/design-system/` is an explicit application-owned native adaptation of the
Button, Card, EmptyState, ListRow, Pill, and SectionHeading contracts. Tests
tie its native token values back to the generated files in this directory.

To refresh this copy, review the Design System diff first, replace the vendored
files from one pinned commit, update this provenance record, and run the mobile
test, typecheck, and Android release build. Never point imports at
`../design-system`.
