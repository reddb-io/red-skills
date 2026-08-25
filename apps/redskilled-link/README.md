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
npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled link \
  --relay wss://relay.example --name "My workstation"
```

The relay and Host name are stored in owner-only TOON state. Later invitations
need only the same command without flags. A systemd user unit keeps the companion connected
after the terminal closes. The Android app scans the emitted
`redskilled://pair/<invitation>` QR; pasting the printed manual code remains
supported.

WSS is the implemented transport. `--transport wireguard` currently refuses
with an explicit explanation: embedded Android WireGuard/VPN permission remains
a future transport, and opening VPN settings on the Host would configure the
wrong device.

### systemd unit management

The Host companion keeps running after the terminal closes through a systemd
user unit. Three subcommands manage it:

```bash
redskilled-link unit install          # install and start the systemd user unit
redskilled-link unit status           # query systemd and the published status.json
redskilled-link unit remove           # stop and remove the systemd user unit
```

### status

A read-only report that probes three authorities in one screen — the host
daemon (live ACP state), systemd (process liveness), and the published
`status.json` projection (what the link has actually done). Unreachable
exits 1 with the reason printed on the report.

```bash
redskilled-link status
```

### devices

Lists every device this Host has ever paired. Revoked devices are kept and
marked so the operator can distinguish a device that vanished from one that
was cut off. Secrets never print.

```bash
redskilled-link devices
```

### revoke

Cuts one paired device off the wire. A device id that is not currently live
is a loud miss, not a silent success.

```bash
redskilled-link revoke <device-id>
```

Pair the device again to restore access.
