# redskilled-link

The Remote link Host/Relay companion for Redskilled Mobile.

- `relay` routes opaque encrypted frames and owns no device, Project, credential, or Worker authority.
- `onboard` installs/starts the Host companion and creates a short-lived,
  one-use pairing invitation as a QR, connection URI, and manual code.
- `invite` creates another pairing invitation in host state.
- `host` connects the relay to the local redskilled ACP Mobile-operator allowlist.

For local development:

```bash
pnpm --filter @reddb-io/redskilled-link start relay --port 8787
pnpm --filter @reddb-io/redskilled-link start invite --relay ws://127.0.0.1:8787
pnpm --filter @reddb-io/redskilled-link start host --relay ws://127.0.0.1:8787
```

Production places the transport-only relay behind TLS and uses `wss://`.

The supported operator front door is:

```bash
redskilled link --relay wss://relay.example --name "My workstation"
```

The relay and Host name are stored in owner-only TOON state. Later invitations
need only `redskilled link`. A systemd user unit keeps the companion connected
after the terminal closes. The Android app scans the emitted
`redskilled://pair/<invitation>` QR; pasting the printed manual code remains
supported.

WSS is the implemented transport. `--transport wireguard` currently refuses
with an explicit explanation: embedded Android WireGuard/VPN permission remains
a future transport, and opening VPN settings on the Host would configure the
wrong device.
