#!/usr/bin/env bash
# Deliberately violating fixture for scripts/audit-hook-hardening-contract.sh.

raw="$(cat)"
sh -c "echo $raw"
exit 2
