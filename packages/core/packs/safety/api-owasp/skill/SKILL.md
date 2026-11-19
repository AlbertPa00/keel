---
name: api-owasp
description: OWASP API checklist — validation, authorization, output safety, and secret hygiene for every endpoint
---

# OWASP API Checklist

Run through this before any endpoint is "done":

## Input

- [ ] Body/query/params validated by schema at the boundary — reject unknown fields
- [ ] IDs from the URL are checked for ownership/scope, never trusted
- [ ] File uploads: size limit, type sniffing, stored outside web root

## Authorization

- [ ] Every handler calls an explicit authz check — no implicit "logged in = allowed"
- [ ] List/get endpoints filter by the caller's scope, not by trusting params

## Output

- [ ] Errors use the project envelope; stack traces never reach clients
- [ ] Secrets, tokens, connection strings are never logged or returned
- [ ] Sensitive fields (passwords, hashes) omitted from serializers by default

## Secrets

- [ ] Nothing secret in code, tests, or fixtures — read from env only
- [ ] If a secret leaked into a file, rotate it; do not just delete the line
