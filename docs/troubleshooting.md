# Troubleshooting

Based on the live end-to-end run in [test-report.md](test-report.md).

## Errors and what they mean

| Symptom | Cause | Action |
|---|---|---|
| `401 NotLoggedIn` | No usable `az login` session | `az login` (right tenant), restart not needed |
| `409 MigrationBlocked` (e.g. `sku-availability`) | A pre-check returned BLOCK; nothing was started, VM untouched | Run the pre-check, apply the remediation, or pass another `targetOverrides` SKU |
| `400 BadRequest` on a POST | Malformed JSON body (used to be a 500, bug #31, fixed in PR #32) | Fix the body |
| `502` on discovery | ARM call failed. Listing with `$expand=instanceView` failed on real Azure (bug #28, fixed in PR #30: plain list plus per-VM instance view) | Update to latest main; check access to the subscription |
| `409` on rollback | Job is still running | Wait for a terminal state |
| `OperationNotAllowed ... changing from resource disk to non-resource disk VM size` | Windows with a temp disk moved to a diskless size | See limitation 1; the tool now offers v5 `d` sizes (bug #29) |
| Job `Failed` with snapshot ids in the error | Migration failed and automatic rollback also failed | Recreate the VM from the snapshots manually |
| Server restarted mid-migration | State is in `data/jobs/` | Incomplete jobs resume on restart; steps are idempotent |
| Demo deploy fails on quota/SKU restriction | Capacity restrictions on old series since July 2026 | See [demo.md](demo.md): other region, `-Series` subset |

## Limitations and workarounds

1. **Windows + temp-disk source cannot reach v6/v7 in place.** v6/v7 `d` sizes have a local NVMe disk, not a resource disk. In place: v5 with a resource disk (Dadsv5/Ddsv5/Eadsv5). To reach v7: move the pagefile to C:, snapshot the OS disk, create a new VM from it on a v7 size (manual, not automated).
2. **Gen1 VMs cannot go to v6/v7 in place.** The tool uses a Gen1-capable v5 size. Long term: Gen1 -> Trusted Launch/Gen2 upgrade (not possible for Dv2/Dv3 Gen1) or redeploy from a Gen2 image, then v7. Not implemented.
3. **Images without the NVMe tag** (`DiskControllerTypes` lacking NVMe) trigger `nvme-image` WARN/BLOCK. Use an NVMe-capable image or a SCSI-capable target. This BLOCK path was not hit live.
4. **v7 targets may have no SCSI option** (swedencentral: `DiskControllerTypes=NVMe` only), so Linux v7 migrations always change the controller: device names change (`/dev/sdX` -> `/dev/nvme*`); use UUID/LABEL in `/etc/fstab`.
5. **Temp-disk contents, dynamic IPs and device names change**; the tool does not enable accelerated networking (post-check WARN "accelerated networking not enabled on every NIC" is expected for such NICs).
6. **Automatic rollback after a real mid-flight failure was not exercised live**, only offline tests. Manual rollback of a `Done` job was (about 1m55s).
7. **Rollback may not allocate later**: capacity restrictions on the retiring series can block returning to the old size once the VM is moved.
8. **Not supported at all**: ADE (BLOCK), ephemeral OS disk on diskless v7 targets, shared disks on Windows Server 2019 with NVMe, VMSS instances (migrate via the scale set model).

## Diagnostics

- Job details: `GET /api/migrations/:id` (`events`, `error`, `postCheck`, `rollback`); live stream: `GET /api/migrations/:id/events`.
- After a failed resize Azure can show the requested size in the VM model while the VM still runs the old one; post-checks read the actual state, verify with `az vm get-instance-view`.
- Check SKU capabilities directly: `az vm list-skus -l <region> --size <sku> --resource-type virtualMachines` (look at `DiskControllerTypes`, `HyperVGenerations`, `MaxResourceVolumeMB`, restrictions) and image support with `az vm image show --urn <URN>`.
- Try `VMM_MOCK=1` to separate tool issues from Azure issues.
