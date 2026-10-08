# HowTo: test-drive VM-Migrator from your own device

This guide takes you from a clean machine to migrating Azure VMs from retiring v1/v2/v3 sizes to v7 (v6 as fallback).
It deploys a real demo fleet in *your* subscription (about 1 hour, costs money) and migrates it. The app always works against real Azure.

---

## 1. Prerequisites

| Need | Version / notes | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Node.js | 20 or newer | `node --version` |
| PowerShell | 7+ recommended (5.1 works for the demo scripts) | `$PSVersionTable.PSVersion` |
| Azure CLI | 2.60+ (demo deploy only) | `az version` |
| Azure subscription | demo deploy only. Role **Owner**, or **Contributor** plus **User Access Administrator**, on a subscription or resource group | `az role assignment list --assignee <you>` |
| VM quota | demo deploy only, about 12 vCPUs across Fsv1, DSv2, Dsv3 in one region | see section 3.2 |

> The repo is private: `gh auth login` (or any Git credential) with access to `jgezelscorp/VmMigrator` is required to clone.

## 2. Get the code

```powershell
git clone https://github.com/jgezelscorp/VmMigrator.git
cd VmMigrator
npm install
npm test        # optional sanity check, all tests should pass
```

## 3. Deploy the demo and migrate

### 3.1 Sign in and pick a subscription

```powershell
az login                                   # use --tenant <tenant-id> if you have several
az account set --subscription <subscription-id>
az account show -o table                   # confirm you are on the right one
```

The app uses your `az login` session (Entra sign-in in the app itself is planned for phase 2). Everything below
runs with your identity, so only use a subscription you are allowed to change.

### 3.2 Pre-flight: quota and SKU availability

Since mid-2026 new quota for v1/v2/v3 families is restricted. Check the region you plan to use:

```powershell
$loc = 'swedencentral'
az vm list-usage -l $loc -o table | Select-String "Dsv3|DSv2|FSv1|Dasv7|Easv7|Total Regional"
az vm list-skus -l $loc --size Standard_D2s_v3 --resource-type virtualMachines -o table   # look for NotAvailableForSubscription
```

If a family has no quota, pick another region (`westeurope`, `northeurope`, `eastus2`) or drop series with `-Series`.
The **target** v7 family also needs quota (for example Dasv7/Dsv7 for the D-series). Request it in the portal
(*Subscriptions, Usage + quotas*) if it is 0.

### 3.3 Deploy the demo fleet

```powershell
.\demo\deploy.ps1 -WhatIf                                   # preview only, creates nothing
.\demo\deploy.ps1 -Location swedencentral -NoAutoShutdown   # real deploy, about 10-15 min
```

- Credentials: pass `-AdminUser <name>` (default `demoadmin`) and `-AdminPassword <pw>`. Precedence for the password is
  `-AdminPassword`, then `$env:VMMIG_ADMIN_PASSWORD`, then a generated one. At the end of the deploy a **Logon information**
  block prints the user, password, how to connect (Bastion) and the VM list. A generated password is shown only there.
  Changing `-AdminUser` on an existing deployment is not possible; run `rebuild.ps1` first.
- Use `-Series Dsv3,DS2_v2,F2s` for a subset, and `-Subscription <id>` / `-ResourceGroup <name>` to override the defaults
  (`rg-vmmigrator-demo`).
- Add `-OperatorIp <your-cidr>` to allow SSH/RDP from your address to the VNet. VMs have **no public IPs**; connect via the **Azure Bastion** (Basic) that `deploy.ps1` creates: Azure portal > VM > Connect > Bastion, user `demoadmin`. Skip it with `-NoBastion`; create/remove it separately with `.\demo\bastion.ps1` / `.\demo\bastion.ps1 -Remove` (Bastion bills hourly, roughly €0.15-0.20/h; cleanup removes it).
- Without `-NoAutoShutdown` the VMs shut down daily at 19:00 UTC. A stopped VM is fine for migration, but keep
  them running if you want the post-checks (agent heartbeat) to be meaningful.

The 6 VMs created (all tagged `purpose=vm-migrator-demo`): 3 Linux + 3 Windows, one per retiring generation (v1/v2/v3).

| VM | Size (series) | OS image | Gen | Security |
|---|---|---|---|---|
| vmmig-lnx-v1-ubuntu1604-g1 | Standard_F2s (Fsv1) | Ubuntu 16.04 LTS | 1 | Standard |
| vmmig-lnx-v2-ubuntu1804-g2 | Standard_DS2_v2 (DSv2) | Ubuntu 18.04 LTS | 2 | Standard |
| vmmig-lnx-v3-ubuntu2004-tl | Standard_D2s_v3 (Dsv3) | Ubuntu 20.04 LTS | 2 | Trusted Launch |
| vmmig-win-v1-ws2016-g1 | Standard_F2s (Fsv1) | Windows Server 2016 (10.0.14393) | 1 | Standard |
| vmmig-win-v2-ws2019-g2 | Standard_DS2_v2 (DSv2) | Windows Server 2019 (10.0.17763) | 2 | Standard |
| vmmig-win-v3-ws2022-tl | Standard_D2s_v3 (Dsv3) | Windows Server 2022 (10.0.20348) | 2 | Trusted Launch |

Ubuntu 16.04 is the oldest image the Marketplace still offers in swedencentral (14.04 is only available as Ubuntu Pro). Older guest OSes are deliberate: they show how OS age affects the migration (NVMe/driver support, Gen1, security type).
Verify:

```powershell
az vm list -g rg-vmmigrator-demo -d -o table
```

### 3.4 Start the app

```powershell
npm start
```

Open <http://127.0.0.1:3000/>. If you see `401 NotLoggedIn`, run `az login` again and refresh.

### 3.5 Migrate through the web UI

1. Choose your subscription(s): Ctrl/Shift-click several in the list, use **Select all**, or paste comma-separated ids. With none selected, all subscriptions are scanned. Use **Auto-detect** (retiring VMs only) or select VMs manually.
   At any time, **Download HTML report** saves a standalone report of the discovered estate (KPIs, per-VM details,
   pre-check results and migration jobs) as `vm-migrator-report-<date>.html`.
2. Click **Pre-check** and read the results:
   - **PASS / WARN**: ready to go.
   - **Migration path**: every pre-checked VM card has a **Use rebuild strategy (opt-in)** checkbox. Leave it off for an
     in-place resize. Tick it to delete and recreate the VM from its disks (longer downtime); it also turns in-place
     blocks (Windows temp disk, Gen1) into warnings. It is marked *Recommended* when an in-place resize is blocked.
   - **BLOCK**: cannot be done in place; tick the rebuild checkbox if offered.
3. Optionally override the target SKU (default is the matching v7 size, with v6 as fallback).
   Click **Auto-SKU selection** to pick the best SKU for every VM and put it first in each dropdown. The **ℹ** button
   beside a dropdown opens a side-by-side comparison of the current and proposed SKU, with quota check, zone
   constraints, monthly cost impact and reservation advice. Pricing follows the changes effective 1 Feb 2027:
   older VM families (Bv1, D, Ds, F, Fs, G, Gs, L, NP, HC, Av2, Amv2, Dv2, Dsv2, Fsv2, Lsv2) get +25% globally;
   other sizes get the regional increase (North Europe +17%, France Central/South +11%, West Europe/Norway +9%,
   Southeast Asia +8%). The two are never stacked. Reservation advice notes that since 1 Jul 2026 reservations for
   the older series can no longer be purchased or renewed, and recommends a reservation or savings plan on the new size.
4. Start with **Dry run**, then run the real **Migrate**. For each VM the engine:
   re-validates, snapshots the disks, deallocates, resizes (and switches the disk controller to NVMe when needed),
   starts the VM, then runs post-checks (provisioning, power, size, agent heartbeat, extensions, disks, networking).
5. If anything fails after the VM was changed, the engine rolls back automatically to the original size
   (state `Restored`). You can also roll back manually from the job page.
6. When satisfied, **Cleanup snapshots** to delete the safety snapshots (they cost money).

Confirm in Azure:

```powershell
az vm list -g rg-vmmigrator-demo --query '[].{name:name,size:hardwareProfile.vmSize}' -o table
```

### 3.6 Same thing from PowerShell or REST

With the server running (`npm start` in another window):

```powershell
.\scripts\Invoke-VmDiscovery.ps1 -RetiringOnly
.\scripts\Invoke-VmPreCheck.ps1  -VmName vmmig-lnx-v3-ubuntu2004-tl          # exit code 2 if BLOCK
.\scripts\Invoke-VmMigration.ps1 -VmName vmmig-lnx-v3-ubuntu2004-tl -DryRun
.\scripts\Invoke-VmMigration.ps1 -VmName vmmig-lnx-v3-ubuntu2004-tl
# rebuild strategy (Windows temp disk / Gen1): add  -Strategy Rebuild -ConfirmRebuild
```

See `docs/usage.md` for all parameters and the REST API (`/api/vms`, `/api/migrations`, ...).

### 3.7 Run it again (reset)

```powershell
.\demo\rebuild.ps1               # delete the resource group, wait, redeploy the original v1/v2/v3 fleet
.\demo\rebuild.ps1 -ClearJobs    # also wipe local migration history (data\jobs)
```

Takes 10-20 minutes and prints a **new** admin password.

### 3.8 Clean up (important, stops the billing)

```powershell
.\demo\cleanup.ps1               # deletes rg-vmmigrator-demo, only if tagged purpose=vm-migrator-demo
```

Also delete leftovers outside the group if you pointed the tool at your own VMs (snapshots, old OS disks kept by the
rebuild strategy; use **Cleanup snapshots** in the UI first).

## 4. Cost

Rough estimates, verify with the Azure pricing calculator:

- Full fleet running: about 0.7-0.9 EUR per hour (about 500-650 EUR per month if left on 24x7).
- Deallocated: about 0.5 EUR per day for disks.
- Snapshots add a little until cleaned up.

Do the test in an afternoon and run `cleanup.ps1` when you are done.

## 5. Troubleshooting

| Symptom | Fix |
|---|---|
| `401 NotLoggedIn` in the UI/API | `az login`, then retry. Check `az account show`. |
| `az` login blocked by your corporate tenant policy | Use `az login --use-device-code --tenant <tenant-id>` with an account in a tenant you control. |
| Deploy fails with `QuotaExceeded` or `NotAvailableForSubscription` | Change `-Location`, use `-Series` to drop the failing series, or request quota (section 3.2). |
| Pre-check BLOCK on target SKU unavailable | Pick another target via the override, another region's quota, or request v7 quota. |
| Migration fails on a Windows temp-disk VM | Expected for in-place. Re-run pre-check and tick **Use rebuild strategy**. |
| Gen1 VM blocked | Use the rebuild strategy (Linux Gen1 with Canonical/RedHat/SUSE images only). |
| `Port 3000 in use` | `$env:PORT = '3100'; npm start` |
| Job stuck after closing the app | Restart `npm start`: incomplete jobs resume automatically (steps are idempotent). |
| Want a fresh job list | Delete `data\jobs\*.json` or run `rebuild.ps1 -ClearJobs`. |

More detail: `docs/troubleshooting.md`, `docs/runbook.md`, `docs/sku-mapping.md`, `docs/architecture.md`.

## 6. Limits to know

- Rebuild strategy: system-assigned identities get a new principal id, extensions with protected settings and
  Azure Disk Encryption are not restored, and temp-disk (D:) content is lost.
- Not supported: VMSS, confidential VMs, ephemeral or unmanaged OS disks, Windows Gen1, Debian/Azure Linux Gen1 upgrade.
- The app binds to `127.0.0.1` and has no authentication of its own yet (Entra sign-in is phase 2, issue #11). Do not
  expose it to a network.
