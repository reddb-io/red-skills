---
"@reddb-io/redskilled-link": minor
---

`redskilled-link devices` and `redskilled-link revoke <device-id>`: the pairing registry is operable — list every device that ever paired (revoked kept and marked, secrets never printed) and cut one off the wire; revocation republishes the public status.json device count, and the wire-side lookups refuse the revoked device from that moment.
