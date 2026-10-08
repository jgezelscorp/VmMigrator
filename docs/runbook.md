# Migration runbook

Moving VMs off retiring series with VM-Migrator. Commands assume a running server (`npm start`); the PowerShell wrappers in `scripts/` call the same API (see [usage.md](usage.md)). Try everything first on the demo fleet.

## In-place or rebuild?

| Situation | Approach | Why |
|---|---|---|
| Linux, Gen2, NVMe-capable image | **In place** -> v7 (or v6) | One PATCH changes size and controller to NVMe (tested: D2as_v7, F2als_v7). |
| Linux, Gen1 | **In place** -> v5 (tool fallback), later rebuild | v6/v7 are Gen2 only. Long-term: Gen2/Trusted Launch image, then v7. |
| Windows with temp disk (D:) | **In place** -> v5 `d` size (Dadsv5/Ddsv5/Eadsv5) | Azure rejects resource-disk <-> diskless resizes on Windows. |
| Windows with temp disk, v7 wanted | **Rebuild**: pagefile to C:, snapshot OS disk, new VM on v7 | Not automated. |
| Image without NVMe tag / old OS without NVMe driver | Rebuild from NVMe-capable image, or SCSI-capable target | `nvme-image` WARN/BLOCK. |
| Azure Disk Encryption (ADE) | **Rebuild** (encryption at host) | ADE is unsupported on v6/v7. |
| Ephemeral OS disk on diskless v7 target | Rebuild or pick a `d` target | Dasv7 lists ephemeral OS as unsupported. |
| VM Scale Set instance | Migrate via the scale set model | `placement-constraints` BLOCK. |

Microsoft's primary recommendation is deploying new v6/v7 VMs in parallel; in place is the higher-risk option (see [research.md](research.md) §4).

## Downtime

Every migration deallocates the VM. In the live test a whole job took about 2.5 min per VM (range 2m15s-4m52s, including snapshots and start; one run included 2 min of queueing). Expect:

- Full outage from deallocate until the guest and agent are back (roughly the 2-3 minutes above, not a guarantee).
- Temp-disk content, dynamic public IPs, device names (`/dev/sdX` -> `/dev/nvme*`) change. Static/Standard-SKU public IPs are kept.
- Availability set VMs: migrate one at a time (the live test did avs1, then avs2).
- Use `options.maintenanceWindow {start,end}` to record the window.
- Capacity restrictions on the old series mean rolling back later may fail to allocate; the rollback window is realistic only soon after migration.

## Steps

### 1. Discover
```powershell
./scripts/Invoke-VmDiscovery.ps1 -RetiringOnly [-SubscriptionId <id>]
```
or `GET /api/vms?retiring=true`, or the web UI. Output lists series, retirement date and (per VM) generation, controller, temp disk. Non-retiring VMs are not flagged.

### 2. Pre-check
```powershell
./scripts/Invoke-VmPreCheck.ps1 -VmName vm1 [-TargetSku Standard_D2as_v7]   # exit code 2 on BLOCK
```
Checks: `vm-state`, `sku-availability`, `quota`, `generation`, `disk-controller`, `nvme-image`, `temp-disk`, `accelerated-networking`, `azure-disk-encryption`, `ephemeral-os-disk`, `availability-set`, `proximity-placement-group`, `reserved-ip`, `backup`, `resource-locks`, `placement-constraints`, `premium-storage`, `disk-limits`, `shared-disks`, `extensions`, `security-type`, `deallocation-required`. Fix every `BLOCK`; read every `WARN` (for example the missing-accelerated-networking WARN is expected on VMs that never enabled it). The tool never mutates during pre-check. Guest prep that ARM cannot verify: Linux needs the NVMe driver in the initramfs, `/etc/fstab` by UUID/LABEL, current waagent; Windows needs the stornvme driver (WS2019+), updates, pagefile off D:.

### 3. Dry run
```powershell
./scripts/Invoke-VmMigration.ps1 -VmName vm1 -DryRun
```
Prints the exact snapshot / deallocate / PATCH / start operations and changes nothing. Override the target with `-TargetSku` (API: `targetOverrides`).

### 4. Migrate
```powershell
./scripts/Invoke-VmMigration.ps1 -VmName vm1 -Wait [-GuestProbe] [-CleanupSnapshots]
```
Flow: Validated (pre-checks re-run, BLOCK returns `409 MigrationBlocked` and nothing starts) -> SnapshotTaken -> Deallocated -> Updated -> Started -> PostChecked -> Done. Jobs are persisted under `data/jobs/` and resume after a restart. Exit codes: 0 Done, 1 Failed/Restored, 2 blocked. Start with a non-production wave.

### 5. Post-check
Run automatically; see `postCheck` on `GET /api/migrations/:id`: provisioning, power, actual size and controller, agent heartbeat, extensions, accelerated networking, disks, tags/IPs, backup, optional guest probe. A FAIL recommends rollback (set `options.autoRollbackOnPostCheckFail` to automate). Also verify the application yourself.

### 6. Rollback
Automatic when any step after the VM was changed fails (state `Restored`). On demand, also after `Done`:
```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:3000/api/migrations/<id>/rollback -ContentType application/json -Body '{"reason":"app check failed"}'
```
Tested live: `Restored` in about 1m55s, original size and SCSI controller back. If the automatic rollback fails too, the job is `Failed` and the error lists snapshot ids; recreating the VM from the snapshots is manual.

### 7. Cleanup
After sign-off delete the snapshots: `POST /api/migrations/:id/cleanup` (or set `options.cleanupSnapshots`). For the demo fleet run `.\demo\cleanup.ps1`.

See [troubleshooting.md](troubleshooting.md) for errors and [sku-mapping.md](sku-mapping.md) for how targets are chosen.
