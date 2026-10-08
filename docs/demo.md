# Demo fleet (issue #2)

Bicep that deploys a small fleet of cheap VMs on retiring series (Fsv1, DSv2, Dsv3) with graded OS ages so the migration engine has realistic inputs.

> **Status: DEPLOYED** (redeployed 2026-10-08) to subscription `ME-MngEnvMCAP578105-jangezels-1` (`306af555-a7da-440e-9b89-31b913b02384`), region `swedencentral`, resource group `rg-vmmigrator-demo`. The fleet is 6 VMs (3 Linux + 3 Windows) on v1/v2/v3 sizes, verified with `az vm list`.

Scripts default to this subscription; override with `-Subscription`.

## Fleet (defaults in `demo/vms.default.json`, prefix `vmmig-`)

| VM | Size (series) | OS image | Gen | Security |
|---|---|---|---|---|
| vmmig-lnx-v1-ubuntu1604-g1 | Standard_F2s (Fsv1) | Ubuntu 16.04 LTS | 1 | Standard |
| vmmig-lnx-v2-ubuntu1804-g2 | Standard_DS2_v2 (DSv2) | Ubuntu 18.04 LTS | 2 | Standard |
| vmmig-lnx-v3-ubuntu2004-tl | Standard_D2s_v3 (Dsv3) | Ubuntu 20.04 LTS | 2 | Trusted Launch |
| vmmig-win-v1-ws2016-g1 | Standard_F2s (Fsv1) | Windows Server 2016 (10.0.14393) | 1 | Standard |
| vmmig-win-v2-ws2019-g2 | Standard_DS2_v2 (DSv2) | Windows Server 2019 (10.0.17763) | 2 | Standard |
| vmmig-win-v3-ws2022-tl | Standard_D2s_v3 (Dsv3) | Windows Server 2022 (10.0.20348) | 2 | Trusted Launch |

Ubuntu 16.04 is the oldest image the Marketplace still offers in swedencentral (14.04 is only available as Ubuntu Pro). Older guest OSes are deliberate: they show how OS age affects the migration (NVMe/driver support, Gen1, security type).
Default region `swedencentral`, resource group `rg-vmmigrator-demo`. Every resource is tagged `purpose=vm-migrator-demo`.

Access: `deploy.ps1` also runs `bastion.ps1`, creating an idempotent Azure Bastion (Basic, `AzureBastionSubnet` 10.50.2.0/26) so you can connect via portal > VM > Connect > Bastion (user `demoadmin`). Use `-NoBastion` to skip, or `.\demo\bastion.ps1 [-Sku Standard] [-Remove]` directly. Bastion adds roughly €0.15-0.20/hour (estimate) until cleanup.

Cost/safety: StandardSSD_LRS disks, **no public IPs**, NSG denies Internet inbound (optional `-OperatorIp` adds SSH/RDP from that CIDR to the VNet), auto-shutdown at 19:00 UTC daily (`-NoAutoShutdown` to keep them running for the engine). Rough running cost for the full fleet is on the order of €0.7–0.9/hour (≈ €500–650/month if left on 24x7); deallocated cost is ~€0.5/day for disks. Estimates only; verify with the pricing calculator.

## Deploy

```powershell
az login
.\demo\deploy.ps1 -WhatIf                         # what-if only
.\demo\deploy.ps1 -Location swedencentral         # real deploy; password: -AdminPassword > $env:VMMIG_ADMIN_PASSWORD > generated
.\demo\deploy.ps1 -AdminUser myadmin -AdminPassword 'S0me-Str0ng-Pw!'   # logon info is printed at the end
.\demo\deploy.ps1 -Series Dsv3,DS2_v2 -Location westeurope   # subset
az vm list -g rg-vmmigrator-demo -d -o table
```

## Quota / availability

Since July 2026 new quota for D/Dsv2/Dv3/Dsv3/Ev3/Av2/Fsv2 is restricted (see `docs/research.md` §1). Check before deploying:

```powershell
az vm list-usage -l <region> -o table | Select-String "Dsv3|DSv2|FSv1|Total Regional"
az vm list-skus -l <region> --size Standard_D2s_v3 --resource-type virtualMachines -o table   # look for NotAvailableForSubscription
```

Fallbacks: try `westeurope`, `northeurope`, `eastus2`; use `-Series` to drop series that fail (e.g. Fsv1); Dv3/Dsv3 are the most likely to have quota left. If a Gen2 image is rejected for a size, deploy it Gen1.

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
