# Phase 2 roadmap: Entra ID sign-in (issue #11)

Status: planned, not implemented.

## Today (phase 1)

The server binds to `127.0.0.1` and acquires ARM tokens through `AzureCliCredentialProvider` (`src/azure/credential.ts`), i.e. whatever identity `az login` has. There is no per-user identity, access control or audit log inside the tool.

## Goal

Sign in with Entra ID so actions run with the operator's own delegated permissions and are attributable.

## Plan

- Implement a second `CredentialProvider` (the interface already exists, so the engines do not change): MSAL, authorization code + PKCE, delegated ARM scope `https://management.azure.com/.default`.
- App registration with delegated `user_impersonation` on Azure Service Management; document the one-time setup.
- Token cache and refresh; select provider by configuration (az CLI stays the default for local use).
- Per-user audit log: record the signed-in user on each job and event next to `data/jobs/`.
- Authorization: respect Azure RBAC as-is; optionally restrict who can start migrations.
- Revisit the loopback-only binding and add TLS/CSRF handling before any non-local hosting.

## Out of scope

Multi-tenant hosting, service-principal automation, and changes to the migration engine.
