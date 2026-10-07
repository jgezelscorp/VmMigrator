# Architecture & Plan

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Node.js 20+ / TypeScript** backend (Fastify), single package, `npm start` | One-command local run; strong typing for ARM models; easy UI hosting |
| D2 | Azure access via **ARM REST** with `@azure/identity` `AzureCliCredential` behind a `CredentialProvider` interface | Uses existing `az login` now; swap to Entra/MSAL (phase 2, #11) without engine changes |
| D3 | UI: static TypeScript SPA (Vite + Preact or vanilla) served by the backend from `/web` | "Simple UI", no separate hosting |
| D4 | **PowerShell scripts in `/scripts`** are thin wrappers (demo deploy/destroy, CLI migrate, wrap NVMe preflight) that call the same API/engine | Ops-friendly, scriptable |
| D5 | **Bicep in `/demo`** with deploy/destroy scripts | Native IaC, `what-if` |
| D6 | **Data-driven catalog** (`data/retirement-series.json`, `data/sku-mapping.json`) + live Resource SKUs API for authority | Retirement dates and v7 names change; avoid hard-coding |
| D7 | Target v7 first, fall back to v6, optional v5 for Gen1/non-NVMe images | User requirement + Learn guidance (see research.md) |
| D8 | Checks are pluggable; engines never mutate in pre-check; migration requires dry-run-capable plan | Safety |
| D9 | Job state persisted locally (JSON files / SQLite) for resumability and audit; server binds to 127.0.0.1 | Local-only phase 1 |

## Component view

```
 Web UI (/web)  ─┐
 PowerShell CLI ─┼─►  API (Fastify, /src/api)  ─►  Job orchestrator
 (/scripts)      ┘                                   │
                         ┌───────────────┬───────────┴──────┬───────────────┐
                    Discovery        Pre-check          Migration        Post-check
                    engine           engine             engine           engine
                         └───────────────┴──────┬───────────┴───────────────┘
                                         Azure client (ARM REST, retry/429, LRO polling)
                                                │  CredentialProvider (az CLI now, Entra later)
                                          Azure Resource Manager
```

## Repo layout

```
src/{api,discovery,prechecks,migration,postchecks,azure,catalog}
web/            UI
scripts/        PowerShell wrappers
demo/           Bicep + deploy/destroy
data/           retirement + SKU mapping catalogs
docs/           research.md, architecture.md, runbook
tests/          unit + e2e
```

## Core flow

1. **Discover**: Resource Graph (`Resources | where type =~ 'microsoft.compute/virtualmachines'`) → per-VM enrichment (instance view, NICs, disks, extensions, Backup items). Match size against the retirement catalog → `retiringSeries`, `retirementDate`.
2. **Select**: auto-detected list or manual pick (VM + optional forced target SKU).
3. **Target resolution**: candidates from `Microsoft.Compute/skus` filtered per research §7; ranked v7 > v6 (> v5 optional).
4. **Pre-checks** → `PASS | WARN | BLOCK` with remediation. BLOCK prevents migration.
   Checks: sku-availability(region/zone), quota, disk-controller/NVMe image, generation (Gen2), temp-disk(Windows rules, `d` preference), accelerated-networking/MANA, availability-set/zone/PPG, ephemeral-os-disk, extensions, backup/snapshot, shared-disks, spot/capacity-reservation/dedicated-host, premium-storage, deallocation-required, power-state, locks/policy.
5. **Migrate** (state machine, each step persisted): `Validated → SnapshotTaken → Deallocated → Updated(size+controller) → Started → PostChecked → Done`; failure → `RollingBack → Restored`. Rollback restores the saved VM model (size + controller); if VM is broken, recreate from snapshots. Dry-run emits the planned ARM calls only.
6. **Post-checks**: provisioning/power state, *actual* size vs model, controller, agent, extensions, NIC/AN, disks/LUN, optional run-command guest probe.
7. **Report**: JSON + markdown per VM.

## Safety principles

- No mutation without explicit confirmation + dry-run option; serial by default (concurrency configurable); one VM per AvSet at a time.
- Snapshot/backup before change; original VM model kept until sign-off.
- Capacity-restricted source series mean rollback is time-limited — surfaced in UI.
- Idempotent steps; resumable after crash.
- Demo resources tagged `purpose=vmmigrator-demo`; tool never touches untagged VMs unless selected by user.

## Auth

Phase 1: local `az login` (subscription `0832b3b6-22b3-4c47-8d8b-572054b97257`). Phase 2 (#11): Entra ID (MSAL, auth code + PKCE, delegated ARM), per-user audit log.

## Plan (issues)

| Issue | Area | Depends on |
|---|---|---|
| #1 Bootstrap & CI | Infra | — |
| #2 Demo Bicep | Infra | #1 |
| #3 Discovery | Backend | #1 |
| #4 Pre-checks | Backend | #3 |
| #5 Migration | Backend | #4 |
| #6 Post-checks | Backend | #5 |
| #7 API | Backend | #3–#6 |
| #8 Web UI | Frontend | #7 (mock API initially) |
| #9 Tests/E2E | Tester | #2–#8 |
| #10 Docs | Lead | continuous |
| #11 Entra epic (phase 2) | Lead | phase 1 |

Parallel tracks: Infra (#2) ∥ Backend (#3→#6) ∥ Frontend (#8 with mocked API) ∥ Tester (test matrix from research §7).

## Risks

- Quota/capacity for demo VMs on retired series in new subscriptions (the demo sub may be unable to deploy Dv2/Av2 → fall back to Dsv3 / document).
- v7 availability varies by region/zone → target resolution must be live.
- Guest OS readiness (NVMe driver, fstab) can't be fully verified via ARM → optional run-command probe + clear warnings.
- Gen1 VMs are blockers for v6/v7.
