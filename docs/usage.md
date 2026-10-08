# Usage

## Start the app

```powershell
npm install
npm start                      # http://127.0.0.1:3000 (loopback only); PORT overrides the port
```

The app always talks to real Azure and uses your `az login` session (read access to VMs/disks/networks, write on the VMs and snapshot
rights in the VM resource group). Without a login the API answers `401 NotLoggedIn` with instructions.
Open `http://127.0.0.1:3000/` for the web UI (served from `/web`).

Environment: `PORT`, `VMM_DATA_DIR` (catalog + `jobs/` state), `VMM_JOBS_DIR` (job state only).
Job state is one JSON file per migration under `data/jobs/`; incomplete jobs resume on restart (steps are idempotent).

## Migration flow

Validated (pre-checks re-run, BLOCK refuses) -> SnapshotTaken (incremental OS + data disks) -> Deallocated ->
Updated (one PATCH: `hardwareProfile.vmSize` plus `storageProfile.diskControllerType=NVMe` when the target needs it) ->
Started -> PostChecked -> Done. Any failure after the VM was changed triggers an automatic rollback to the original
size/controller (state `Restored`). If that fails too the job is `Failed` and the error lists the snapshot ids for a
manual restore. `POST /api/migrations/:id/rollback` rolls back on demand (also after `Done`, e.g. a failed post-check).
Snapshots are kept until `options.cleanupSnapshots` or `POST /api/migrations/:id/cleanup`.
Post-checks: provisioning, power, size, controller, VM agent heartbeat, extensions, accelerated networking, disks, tags/IPs,
backup, and an optional run-command guest probe (`options.guestProbe`). A FAIL recommends rollback; set
`options.autoRollbackOnPostCheckFail` to do it automatically.

## Rebuild strategy (opt-in)

In-place resize is impossible for (a) Windows VMs with a temp disk -> diskless v6/v7 sizes and (b) Gen1 VMs -> Gen2-only
v7. When that is the case the pre-check still BLOCKs by default but offers `rebuildAvailable`/`rebuildKind`; with
`strategy: 'rebuild'` (pre-check body `strategy`, migration `options.strategy`) those checks become WARN.

- **recreate** (Windows temp disk): optional pagefile move to C: (run-command, `options.movePagefile=false` skips) ->
  incremental snapshots -> deallocate -> new disks from the snapshots -> `deleteOption` flipped to Detach where it was Delete ->
  VM definition deleted (NICs, IPs, disks kept) -> VM created again with the same name, NICs (same private IP), tags,
  zone, availability set, identity, plan and extensions, `Attach` on the new disks, target size and `diskControllerType`.
  The original disks are kept (rollback recreates the original VM from them); `cleanupSnapshots`/`/cleanup` deletes them after a successful job.
- **gen1-upgrade** (Gen1 Linux with a Canonical/RedHat/SUSE image): the supported Trusted launch upgrade
  (`securityProfile` PATCH on the deallocated VM) and then size + NVMe. Not reversible in place, so rollback recreates the
  Gen1 VM from the snapshots. Windows Gen1 (needs MBR2GPT in the guest), Debian/Azure Linux, ADE, ephemeral/unmanaged OS
  disks, VMSS and confidential VMs are not offered.
- The real run needs `options.confirmRebuild=true` and snapshots (`skipSnapshots` is refused). The UI shows a
  "Use rebuild strategy" checkbox on the pre-check card and a confirmation text about downtime and recreation;
  PowerShell: `-Strategy Rebuild -ConfirmRebuild` (`-SkipPagefileMove`).
- Steps: Validated, Prepared (Windows pagefile), SnapshotTaken, Deallocated, Rebuilt, Started, PostChecked, Done.
- Caveats: a system-assigned identity gets a new principal id; extensions with protected settings cannot be read back and
  Azure Disk Encryption is not restored (a warning is logged); the temp disk (D:) content is gone.

## REST API

| Method + path | Body / query | Response |
|---|---|---|
| `GET /api/health` | | `{status:'ok'}` |
| `GET /api/openapi.json` | | OpenAPI summary |
| `GET /api/subscriptions` | | `{subscriptions:[{id,name}]}` |
| `GET /api/vms` | `subscriptionId` (comma list), `retiring=true` | `{vms: VmInfo[]}` |
| `POST /api/vms/precheck` | `{vmIds[], targetOverrides?{vmId:sku}}` | `{results: PreCheckResult[]}` |
| `POST /api/migrations` | `{vmIds[], dryRun?, targetOverrides?, options?}` | `202 {jobs}` (`200` for dry-run); `409 MigrationBlocked` if a pre-check BLOCKs (nothing is started) |
| `GET /api/migrations` | | `{jobs}` newest first |
| `GET /api/migrations/:id` | | job: `plan`, `state`, `completedSteps`, `snapshots`, `events`, `error`, `postCheck`, `rollback` |
| `GET /api/migrations/:id/events` | | Server-sent events (`event: job`) until terminal; polling the job works too |
| `POST /api/migrations/:id/rollback` | `{reason?}` | job (`409` while running) |
| `POST /api/migrations/:id/cleanup` | | job with snapshots deleted |

`options`: `cleanupSnapshots`, `skipSnapshots`, `guestProbe`, `autoRollbackOnPostCheckFail`, `confirmRebuild`, `movePagefile` (booleans),
`strategy` (`inPlace` default, `rebuild`) and
`maintenanceWindow {start,end}` (ISO). Errors are `{error, message}` with 400/401/404/409/502/500.
Job states: `Queued, Validated, Prepared, SnapshotTaken, Deallocated, Updated, Rebuilt, Started, PostChecked, Done, RollingBack, Restored, Failed`.

## PowerShell wrappers (`scripts/`)

All talk to a running server (`-BaseUrl` or `$env:VMM_URL`, default `http://127.0.0.1:3000`).
VMs are given by `-VmId` (ARM ids) or `-VmName` (+ `-SubscriptionId` if ambiguous).

```powershell
./scripts/Invoke-VmDiscovery.ps1 -RetiringOnly [-SubscriptionId <id>]
./scripts/Invoke-VmPreCheck.ps1  -VmName vm1 [-TargetSku Standard_D2s_v6]        # exit code 2 if BLOCK
./scripts/Invoke-VmMigration.ps1 -VmName vm1 -DryRun                             # prints the exact ARM operations
./scripts/Invoke-VmMigration.ps1 -VmName vm1 -TargetSku Standard_D2s_v6 -Wait    # exit 0 Done, 1 Failed/Restored, 2 blocked
```

Extra migration switches: `-CleanupSnapshots`, `-GuestProbe`, `-PollSeconds`, `-TimeoutMinutes`.

## Known limits

- Live Azure validation was run on the demo fleet; see `docs/test-report.md`. In-place resize still cannot take Windows temp-disk VMs to v6/v7 or Gen1 VMs to v7; use the opt-in rebuild strategy above.
- If an automatic rollback cannot restore the VM, recreating it from the snapshots is manual (ids are in the job error).
