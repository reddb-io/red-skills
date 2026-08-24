# redskilled-link

The Remote link Host/Relay companion for Redskilled Mobile.

- `relay` routes opaque encrypted frames and owns no device, Project, credential, or Worker authority.
- `invite` creates a short-lived one-use pairing invitation in host state.
- `host` connects the relay to the local redskilled ACP Mobile-operator allowlist.

For local development:

```bash
pnpm --filter @reddb-io/redskilled-link start relay --port 8787
pnpm --filter @reddb-io/redskilled-link start invite --relay ws://127.0.0.1:8787
pnpm --filter @reddb-io/redskilled-link start host --relay ws://127.0.0.1:8787
```

Production places the transport-only relay behind TLS and uses `wss://`.
