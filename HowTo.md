# HowTo: test-drive VM-Migrator from your own device

This guide takes you from a clean machine to migrating Azure VMs from retiring v1/v2/v3 sizes to v7 (v6 as fallback).
There are two paths:

- **Path A – Mock mode (5 minutes, free):** a fake Azure with 5 VMs. Nothing is touched in Azure.
- **Path B – Live mode (about 1 hour, costs money):** deploys a real demo fleet in *your* subscription and migrates it.

Start with Path A to learn the UI, then do Path B.

---

## 1. Prerequisites

| Need | Version / notes | Check |
|---|---|---|
| Git | any recent | `git --version` |
| Node.js | 20 or newer | `node --version` |
| PowerShell | 7+ recommended (5.1 works for the demo scripts) | `$PSVersionTable.PSVersion` |
| Azure CLI | 2.60+ (Path B only) | `az version` |
| Azure subscription | Path B only. Role **Owner**, or **Contributor** plus **User Access Administrator**, on a subscription or resource group | `az role assignment list --assignee <you>` |
| VM quota | Path B only, about 16 vCPUs across Dsv3/Dv3, DSv2, Esv3, Av2, Fsv2 in one region | see section 6 |

> The repo is private: `gh auth login` (or any Git credential) with access to `jgezelscorp/VmMigrator` is required to clone.

## 2. Get the code

```powershell
git clone https://github.com/jgezelscorp/VmMigrator.git
cd VmMigrator
npm install
npm test        # optional sanity check, all tests should pass
```

## 3. Path A – Mock mode

```powershell
$env:VMM_MOCK = '1'
npm start
```

Open <http://127.0.0.1:3000/>. The server listens on loopback only.

Try this:

1. The **Discover** view lists a 5-VM fake fleet; retiring sizes are flagged.
2. Select one or more VMs (or use *Select all retiring*).
3. Click **Pre-check**. Each VM shows PASS / WARN / BLOCK checks and a proposed v7 target SKU. You can override the target.
4. Click **Migrate** (try **Dry run** first). Watch the live step timeline:
   Validated, SnapshotTaken, Deallocated, Updated, Started, PostChecked, Done.
5. Open a finished job and try **Rollback** and **Cleanup snapshots**.

Stop with `Ctrl+C`. Remove the variable afterwards: `Remove-Item Env:VMM_MOCK`.

## 4. Path B – Live mode

### 4.1 Sign in and pick a subscription

```powershell
az login                                   # use --tenant <tenant-id> if you have several
az account set --subscription <subscription-id>
az account show -o table                   # confirm you are on the right one
```

The app uses your `az login` session (Entra sign-in in the app itself is planned for phase 2). Everything below
runs with your identity, so only use a subscription you are allowed to change.

### 4.2 Pre-flight: quota and SKU availability

Since mid-2026 new quota for v1/v2/v3 families is restricted. Check the region you plan to use:

```powershell
$loc = 'swedencentral'
az vm list-usage -l $loc -o table | Select-String "Dsv3|DSv2|Esv3|Av2|FSv2|Dasv7|Easv7|Total Regional"
az vm list-skus -l $loc --size Standard_D2s_v3 --resource-type virtualMachines -o table   # look for NotAvailableForSubscription
```

If a family has no quota, pick another region (`westeurope`, `northeurope`, `eastus2`) or drop series with `-Series`.
The **target** v7 family also needs quota (for example Dasv7/Dsv7 for the D-series). Request it in the portal
(*Subscriptions, Usage + quotas*) if it is 0.

### 4.3 Deploy the demo fleet

```powershell
.\demo\deploy.ps1 -WhatIf                                   # preview only, creates nothing
.\demo\deploy.ps1 -Location swedencentral -NoAutoShutdown   # real deploy, about 10-15 min
```

- Credentials: pass `-AdminUser <name>` (default `demoadmin`) and `-AdminPassword <pw>`. Precedence for the password is
  `-AdminPassword`, then `$env:VMMIG_ADMIN_PASSWORD`, then a generated one. At the end of the deploy a **Logon information**
  block prints the user, password, how to connect (Bastion) and the VM list. A generated password is shown only there.
  Changing `-AdminUser` on an existing deployment is not possible; run `rebuild.ps1` first.
- Use `-Series Dsv3,DS2_v2` for a subset, and `-Subscription <id>` / `-ResourceGroup <name>` to override the defaults
  (`rg-vmmigrator-demo`).
- Add `-OperatorIp <your-cidr>` to allow SSH/RDP from your address to the VNet. VMs have **no public IPs**; connect via the **Azure Bastion** (Basic) that `deploy.ps1` creates: Azure portal > VM > Connect > Bastion, user `demoadmin`. Skip it with `-NoBastion`; create/remove it separately with `.\demo\bastion.ps1` / `.\demo\bastion.ps1 -Remove` (Bastion bills hourly, roughly €0.15-0.20/h; cleanup removes it).
- Without `-NoAutoShutdown` the VMs shut down daily at 19:00 UTC. A stopped VM is fine for migration, but keep
  them running if you want the post-checks (agent heartbeat) to be meaningful.

The 8 VMs created (all tagged `purpose=vm-migrator-demo`):

| VM | Size | OS | Gen | Scenario |
|---|---|---|---|---|
| vmmig-lnx-dsv3-g2-data | D2s_v3 | Ubuntu | 2 | data disk, in-place resize |
| vmmig-win-dsv3-g2 | D2s_v3 | Windows 2022 | 2 | temp disk, needs the rebuild strategy |
| vmmig-lnx-dsv3-g1 | D2s_v3 | Ubuntu | 1 | Gen1, needs the Trusted Launch upgrade |
| vmmig-lnx-dsv2-g2-avs1 / avs2 | DS2_v2 | Ubuntu | 2 | availability set |
| vmmig-win-esv3-g2 | E2s_v3 | Windows 2022 | 2 | temp disk, rebuild strategy |
| vmmig-lnx-av2-g1 | A2_v2 | Ubuntu | 1 | Gen1 |
| vmmig-lnx-fsv2-g2 | F2s_v2 | Ubuntu | 2 | optional |

Verify:

```powershell
az vm list -g rg-vmmigrator-demo -d -o table
```

### 4.4 Start the app in live mode

Make sure `VMM_MOCK` is **not** set, then:

```powershell
Remove-Item Env:VMM_MOCK -ErrorAction SilentlyContinue
npm start
```

Open <http://127.0.0.1:3000/>. If you see `401 NotLoggedIn`, run `az login` again and refresh.

### 4.5 Migrate through the web UI

1. Choose your subscription. Use **Auto-detect** (retiring VMs only) or select VMs manually.
2. Click **Pre-check** and read the results:
   - **PASS / WARN**: ready to go.
   - **BLOCK**: cannot be done in place. For Windows VMs with a temp disk and for Gen1 VMs the card offers
     **Use rebuild strategy**; ticking it turns those blocks into warnings (this recreates the VM or upgrades it to
     Trusted Launch; expect extra downtime, and read the confirmation text).
3. Optionally override the target SKU (default is the matching v7 size, with v6 as fallback).
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

### 4.6 Same thing from PowerShell or REST

With the server running (`npm start` in another window):

```powershell
.\scripts\Invoke-VmDiscovery.ps1 -RetiringOnly
.\scripts\Invoke-VmPreCheck.ps1  -VmName vmmig-lnx-dsv3-g2-data          # exit code 2 if BLOCK
.\scripts\Invoke-VmMigration.ps1 -VmName vmmig-lnx-dsv3-g2-data -DryRun
.\scripts\Invoke-VmMigration.ps1 -VmName vmmig-lnx-dsv3-g2-data
# rebuild strategy (Windows temp disk / Gen1): add  -Strategy Rebuild -ConfirmRebuild
```

See `docs/usage.md` for all parameters and the REST API (`/api/vms`, `/api/migrations`, ...).

### 4.7 Run it again (reset)

```powershell
.\demo\rebuild.ps1               # delete the resource group, wait, redeploy the original v1/v2/v3 fleet
.\demo\rebuild.ps1 -ClearJobs    # also wipe local migration history (data\jobs)
```

Takes 10-20 minutes and prints a **new** admin password.

### 4.8 Clean up (important, stops the billing)

```powershell
.\demo\cleanup.ps1               # deletes rg-vmmigrator-demo, only if tagged purpose=vm-migrator-demo
```

Also delete leftovers outside the group if you pointed the tool at your own VMs (snapshots, old OS disks kept by the
rebuild strategy; use **Cleanup snapshots** in the UI first).

## 5. Cost

Rough estimates, verify with the Azure pricing calculator:

- Full fleet running: about 0.7-0.9 EUR per hour (about 500-650 EUR per month if left on 24x7).
- Deallocated: about 0.5 EUR per day for disks.
- Snapshots add a little until cleaned up.

Do the test in an afternoon and run `cleanup.ps1` when you are done.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `401 NotLoggedIn` in the UI/API | `az login`, then retry. Check `az account show`. |
| `az` login blocked by your corporate tenant policy | Use `az login --use-device-code --tenant <tenant-id>` with an account in a tenant you control. |
| Deploy fails with `QuotaExceeded` or `NotAvailableForSubscription` | Change `-Location`, use `-Series` to drop the failing series, or request quota (section 4.2). |
| Pre-check BLOCK on target SKU unavailable | Pick another target via the override, another region's quota, or request v7 quota. |
| Migration fails on a Windows temp-disk VM | Expected for in-place. Re-run pre-check and tick **Use rebuild strategy**. |
| Gen1 VM blocked | Use the rebuild strategy (Linux Gen1 with Canonical/RedHat/SUSE images only). |
| `Port 3000 in use` | `$env:PORT = '3100'; npm start` |
| Job stuck after closing the app | Restart `npm start`: incomplete jobs resume automatically (steps are idempotent). |
| Want a fresh job list | Delete `data\jobs\*.json` or run `rebuild.ps1 -ClearJobs`. |

More detail: `docs/troubleshooting.md`, `docs/runbook.md`, `docs/sku-mapping.md`, `docs/architecture.md`.

## 7. Limits to know

- Rebuild strategy: system-assigned identities get a new principal id, extensions with protected settings and
  Azure Disk Encryption are not restored, and temp-disk (D:) content is lost.
- Not supported: VMSS, confidential VMs, ephemeral or unmanaged OS disks, Windows Gen1, Debian/Azure Linux Gen1 upgrade.
- The app binds to `127.0.0.1` and has no authentication of its own yet (Entra sign-in is phase 2, issue #11). Do not
  expose it to a network.
