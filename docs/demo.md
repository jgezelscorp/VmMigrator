# Demo fleet (issue #2)

Bicep that deploys a small fleet of cheap VMs on retiring series (Dsv3, DSv2, Ev3, Av2, Fsv2) so the migration engine has realistic inputs.

> **Status: NOT YET DEPLOYED.** The authoring session had `az` and Azure MCP calls denied (no interactive approval), so quota/SKU research, `what-if` and the real deployment could not run. `main.bicep` compiles cleanly with `bicep build`. Run the commands below from an interactive, logged-in shell.

## Fleet (defaults in `demo/vms.default.json`, prefix `vmmig-`)

| VM | Size | OS | Gen | Variant |
|---|---|---|---|---|
| vmmig-lnx-dsv3-g2-data | Standard_D2s_v3 | Ubuntu 22.04 | 2 | 32 GB data disk |
| vmmig-win-dsv3-g2 | Standard_D2s_v3 | WS2022 | 2 | |
| vmmig-lnx-dsv3-g1 | Standard_D2s_v3 | Ubuntu 22.04 | **1** | Gen1 blocker demo |
| vmmig-lnx-dsv2-g2-avs1 / avs2 | Standard_DS2_v2 | Ubuntu 22.04 | 2 | availability set `vmmig-avset` |
| vmmig-win-esv3-g2 | Standard_E2s_v3 | WS2022 | 2 | |
| vmmig-lnx-av2-g1 | Standard_A2_v2 | Ubuntu 22.04 | 1 | Av2 |
| vmmig-lnx-fsv2-g2 | Standard_F2s_v2 | Ubuntu 22.04 | 2 | optional |

Default region `swedencentral`, resource group `rg-vmmigrator-demo`. Every resource is tagged `purpose=vm-migrator-demo`.

Cost/safety: StandardSSD_LRS disks, **no public IPs**, NSG denies Internet inbound (optional `-OperatorIp` adds SSH/RDP from that CIDR to the VNet), auto-shutdown at 19:00 UTC daily (`-NoAutoShutdown` to keep them running for the engine). Rough running cost for the full fleet is on the order of €0.7–0.9/hour (≈ €500–650/month if left on 24x7); deallocated cost is ~€0.5/day for disks. Verify with the pricing calculator.

## Deploy

```powershell
az login
.\demo\deploy.ps1 -WhatIf                         # what-if only
.\demo\deploy.ps1 -Location swedencentral         # real deploy; password generated unless $env:VMMIG_ADMIN_PASSWORD is set
.\demo\deploy.ps1 -Series Dsv3,DS2_v2 -Location westeurope   # subset
az vm list -g rg-vmmigrator-demo -d -o table
```

## Quota / availability

Since July 2026 new quota for D/Dsv2/Dv3/Dsv3/Ev3/Av2/Fsv2 is restricted (see `docs/research.md` §1). Check before deploying:

```powershell
az vm list-usage -l <region> -o table | Select-String "Dsv3|DSv2|Esv3|Av2|FSv2|Total Regional"
az vm list-skus -l <region> --size Standard_D2s_v3 --resource-type virtualMachines -o table   # look for NotAvailableForSubscription
```

Fallbacks: try `westeurope`, `northeurope`, `eastus2`; use `-Series` to drop series that fail (e.g. Fsv2, Av2); Dv3/Dsv3 are the most likely to have quota left. Note Av2 is Gen1-only. If a Gen2 image is rejected for a size, deploy it Gen1.

## Cleanup

```powershell
.\demo\cleanup.ps1    # deletes rg-vmmigrator-demo (only if tagged purpose=vm-migrator-demo)
```
