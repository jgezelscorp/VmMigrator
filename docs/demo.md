# Demo fleet (issue #2)

Bicep that deploys a small fleet of cheap VMs on retiring series (Dsv3, DSv2, Ev3, Av2, Fsv2) so the migration engine has realistic inputs.

> **Status: DEPLOYED** (2026-10-07) to subscription `ME-MngEnvMCAP578105-jangezels-1` (`306af555-a7da-440e-9b89-31b913b02384`), tenant `df965ea6-09d5-4066-9be6-da5094c98b6e`, region `swedencentral`, resource group `rg-vmmigrator-demo`. Quota was 0/100 in every family (Dsv3, Dv3, DSv2, Av2, Esv3, Fsv2, plus Dasv7/Easv7) with no SKU restrictions, so the full 8-VM fleet deployed first time (what-if: 19 resources). All 8 VMs are **Running**, deployed with `-NoAutoShutdown`. The admin password was generated and is not recorded here.

Verified with `az vm list -g rg-vmmigrator-demo -d -o table`:

| Name | Size | Region | OS | Gen | State |
|---|---|---|---|---|---|
| vmmig-lnx-dsv3-g2-data | Standard_D2s_v3 | swedencentral | Linux | 2 | running |
| vmmig-win-dsv3-g2 | Standard_D2s_v3 | swedencentral | Windows | 2 | running |
| vmmig-lnx-dsv3-g1 | Standard_D2s_v3 | swedencentral | Linux | 1 | running |
| vmmig-lnx-dsv2-g2-avs1 | Standard_DS2_v2 | swedencentral | Linux | 2 | running |
| vmmig-lnx-dsv2-g2-avs2 | Standard_DS2_v2 | swedencentral | Linux | 2 | running |
| vmmig-win-esv3-g2 | Standard_E2s_v3 | swedencentral | Windows | 2 | running |
| vmmig-lnx-av2-g1 | Standard_A2_v2 | swedencentral | Linux | 1 | running |
| vmmig-lnx-fsv2-g2 | Standard_F2s_v2 | swedencentral | Linux | 2 | running |

Scripts default to this subscription; override with `-Subscription`.

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

Cost/safety: StandardSSD_LRS disks, **no public IPs**, NSG denies Internet inbound (optional `-OperatorIp` adds SSH/RDP from that CIDR to the VNet), auto-shutdown at 19:00 UTC daily (`-NoAutoShutdown` to keep them running for the engine). Rough running cost for the full fleet is on the order of €0.7–0.9/hour (≈ €500–650/month if left on 24x7); deallocated cost is ~€0.5/day for disks. Estimates only; verify with the pricing calculator.

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

Fallbacks: try `westeurope`, `northeurope`, `eastus2`; use `-Series` to drop series that fail (e.g. Fsv2, Av2); Dv3/Dsv3 are the most likely to have quota left. Av2 is Gen1-only. If a Gen2 image is rejected for a size, deploy it Gen1.

## Cleanup

```powershell
.\demo\cleanup.ps1    # deletes rg-vmmigrator-demo (only if tagged purpose=vm-migrator-demo)
```

## Reset to the starting state

After migrating, restore the original v1/v2/v3 fleet (deletes the resource group, waits, redeploys):

```powershell
.\demo\rebuild.ps1                # same options as deploy.ps1 (-Series, -Location, -NoAutoShutdown)
.\demo\rebuild.ps1 -ClearJobs     # also wipes local data\jobs migration history
```
