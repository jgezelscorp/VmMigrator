# VM-Migrator

Detect Azure VMs running on retiring **v1/v2/v3** size series (Av2, Dv2/Dsv2, Dv3/Dsv3, Ev3/Esv3, F/Fs/Fsv2, G/Gs, Ls/Lsv2 …) and migrate them to **v7** (fallback **v6**, then **v5** for Gen1 or temp-disk Windows VMs) — with every pre-check run first, a controlled in-place resize, post-checks, and a rollback path.

## Vision

1. **Discover** — scan subscriptions for VMs on retiring series (auto-detect) or pick VMs manually.
2. **Pre-check** — SKU availability, quota, Gen1/Gen2, NVMe image support, temp disk, accelerated networking, ADE, ephemeral OS disk, availability sets/PPG, backup, locks, extensions, security type, deallocation requirement. Results are `PASS`, `WARN` or `BLOCK`; a BLOCK refuses the migration.
3. **Migrate** — snapshot, deallocate, one PATCH (size + disk controller), start; automatic rollback on failure.
4. **Post-check** — VM running, agent healthy, extensions/disks/NICs OK, size and controller as expected.
5. **Demo** — Bicep in `demo/` deploys retiring-series VMs to try it on.

It runs locally with one command and uses your existing `az login` (Entra sign-in is phase 2, see [docs/entra-roadmap.md](docs/entra-roadmap.md)).

## Quickstart

Prerequisites: Node.js >= 20, the Azure CLI (`az`), PowerShell 7 (only for `scripts/` and `demo/`), and for live mode an account with read access to VMs/disks/NICs, write on the VMs, and snapshot rights in the VM resource group.

```powershell
az login
npm install
npm start          # http://127.0.0.1:3000 (loopback only); PORT overrides the port
```

Open <http://127.0.0.1:3000/> for the web UI. Without a login the API answers `401 NotLoggedIn`.

### Mock mode (no Azure needed)

```powershell
$env:VMM_MOCK = '1'; npm start
```

Serves a stateful fake ARM with a 5-VM fleet; nothing leaves your machine.

### Demo fleet: deploy and clean up

```powershell
.\demo\deploy.ps1 -WhatIf                    # preview
.\demo\deploy.ps1 -Location swedencentral    # 8 cheap VMs on retiring series (billable!)
.\demo\cleanup.ps1                           # deletes rg-vmmigrator-demo (only if tagged purpose=vm-migrator-demo)
```

Details, quota notes and fallback regions: [docs/demo.md](docs/demo.md).

### Develop

```powershell
npm run lint; npm run typecheck; npm test; npm run build
```

## Documentation

| Doc | Content |
|---|---|
| [HowTo.md](HowTo.md) | Step-by-step guide to test-drive the solution from your own device |
| [docs/runbook.md](docs/runbook.md) | Step-by-step migration runbook, in-place vs rebuild, downtime |
| [docs/sku-mapping.md](docs/sku-mapping.md) | Source series to v7/v6/v5 target reference |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Known bugs, limitations, errors and workarounds |
| [docs/usage.md](docs/usage.md) | App start, flow, REST API, PowerShell wrappers |
| [docs/architecture.md](docs/architecture.md) | Design decisions and components |
| [docs/research.md](docs/research.md) | Microsoft Learn research and verification log |
| [docs/test-report.md](docs/test-report.md) | Live end-to-end test results |
| [docs/demo.md](docs/demo.md) | Demo fleet |
| [docs/entra-roadmap.md](docs/entra-roadmap.md) | Phase 2: Entra ID sign-in |

## Status

Phase 1 is implemented and validated live on the demo fleet (8 VMs, see the test report). Owner: Jan G. An AI squad is configured in `.squad/` (see `.squad/team.md`).
