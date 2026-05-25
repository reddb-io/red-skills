---
title: Auth Guide
tags:
  - auth
  - security
---

# Auth Guide

How tokens are issued and rotated. See [[TokenStore]] for the storage side.
Read the [incident runbook](../runbooks/incidents.md) before rotating secrets.

## Token Rotation

Tokens rotate every 90 days. Related to [[Session]] handling.

## Threat Model

What we defend against. Rotate `JWT_SECRET` after incident response.
