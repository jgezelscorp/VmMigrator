# Live end-to-end test report (issue #9)

Run on 2026-10-07 against the real demo fleet (subscription `306af555-a7da-440e-9b89-31b913b02384`, `rg-vmmigrator-demo`, swedencentral), real server (`npm start`, no `VMM_MOCK`), `az` login credentials. All guest checks used run-command (no SSH/RDP).

## Results matrix

| VM | OS / Gen | Source | Target | Result | Duration | Notes |
|---|---|---|---|---|---|---|
| vmmig-lnx-dsv3-g2-data | Linux / 2, 1 data disk | Standard_D2s_v3 | **Standard_D2as_v7** (NVMe) | Done | 2m26s | SCSI->NVMe in one PATCH. Image `22_04-lts-gen2` reports `DiskControllerTypes: SCSI, NVMe`. Guest after: root `/dev/nvme0n1p1`, data disk `nvme0n2` (32G), fstab clean. Temp disk (`/mnt`) gone as warned. |
| vmmig-win-dsv3-g2 | Windows 2022 / 2 | Standard_D2s_v3 | **Standard_D2ads_v5** (v5 fallback) | Done | 2m32s | Azure refuses every v6/v7 target (see limitation 1). Controller stays SCSI; guest sees C: and D: (temp). |
| vmmig-win-esv3-g2 | Windows 2022 / 2 | Standard_E2s_v3 | **Standard_E2ads_v5** (v5 fallback) | Done | 2m39s | Same reason as above. |
| vmmig-lnx-dsv2-g2-avs1 | Linux / 2, availability set | Standard_DS2_v2 | **Standard_D2as_v7** (NVMe) | Done | 2m15s | Also used for the manual rollback test (below), then re-migrated: Done in 2m26s. |
| vmmig-lnx-dsv2-g2-avs2 | Linux / 2, availability set | Standard_DS2_v2 | **Standard_D2as_v7** (NVMe) | Done | 2m29s | Migrated after avs1; the availability set accepted the new family. |
| vmmig-lnx-fsv2-g2 | Linux / 2 | Standard_F2s_v2 | **Standard_F2als_v7** (NVMe) | Done | 4m41s* | *Includes about 2 min waiting in the job queue while 3 migrations ran in parallel. Guest: `nvme0n1`. |
| vmmig-lnx-dsv3-g1 | Linux / **1** | Standard_D2s_v3 | Standard_D2as_v5 (v5 fallback) | Done | 2m25s | v6/v7 are Gen2 only, so the engine picks a Gen1-capable v5 size. Controller SCSI. |
| vmmig-lnx-av2-g1 | Linux / **1** | Standard_A2_v2 | Standard_D2ls_v5 (v5 fallback) | Done | 4m52s | Same as above. |

Final state of all 8 VMs (checked independently with `az vm get-instance-view`): provisioning `Succeeded`, `VM running`, agent `Ready`, extensions `Provisioning succeeded`, `diskControllerType` NVMe on the five v7 VMs and SCSI on the three v5 VMs. All post-checks PASS except the expected `WARN` "accelerated networking not enabled on every NIC" (the demo NICs don't enable it). Snapshots were cleaned up through `POST /api/migrations/:id/cleanup`.

## Step results

1. **Discovery** (API and `Invoke-VmDiscovery.ps1`): all 8 demo VMs flagged retiring with the right series (Av2, Dsv2 x2, Dsv3 x3, Fsv2, Esv3) and dates (2028-05-01 Dsv2, 2028-11-15 Av2/Fsv2, 2029-11-15 Dsv3/Esv3). The two non-demo VMs in the subscription (`D8s_v5`, `D2ads_v6`) were correctly not flagged. Needed fix #28 first.
2. **Pre-checks**: image feature tags were cross-checked with `az vm image show` (Ubuntu gen2 and WS2022 gen2 both `SCSI, NVMe`) and SKU capabilities with the Resource SKUs API (`DiskControllerTypes=NVMe`, `MaxResourceVolumeMB`, `HyperVGenerations`). Findings matched. Gen1 VMs do **not** BLOCK: the catalog's v5 fallback gives them a valid in-place target. Windows VMs with a temp disk BLOCKed on all v6/v7 candidates (correct, see limitation 1), and now fall back to v5 (#29).
3. **Dry run**: prints the exact snapshot/deallocate/PATCH/start plan and changes nothing.
4. **Real migrations**: matrix above.
5. **Failure / rollback paths**:
   - Unavailable target (`Standard_D2as_v99`): `409 MigrationBlocked` (`sku-availability`), VM untouched.
   - Manual `POST /api/migrations/:id/rollback` on a `Done` job of avs1 (D2as_v7/NVMe): `Restored` in about 1m55s; `az` confirmed `Standard_DS2_v2`, `SCSI`, running, agent Ready.
   - Not exercised: automatic rollback after a mid-flight Azure failure. No deterministic failure was available that passes pre-checks (Azure's own rejection of Windows resource-disk -> diskless resizes is caught by the BLOCK). This path is covered by offline tests only.

## Bugs found

| Issue | Bug | Fix |
|---|---|---|
| #28 | Subscription/RG VM list with `$expand=instanceView` returns 502 on real Azure, so discovery failed completely | PR #30: fall back to plain list + per-VM instance view |
| #29 | Windows with a temp disk: only v6/v7 targets were offered, Azure always rejects them; remediation text ("choose a d size e.g. Dadsv7") was wrong | PR #30: v5 resource-disk targets offered for such VMs, message/remediation corrected |
| #31 | Malformed JSON body returned 500 | PR #32: returns 400 BadRequest |

## Limitations and workarounds

1. **Windows + temp-disk source cannot reach v6/v7 in place.** Azure error: `OperationNotAllowed ... changing from resource disk to non-resource disk VM size and vice-versa is not allowed`. v6/v7 "d" sizes expose a local NVMe disk, not a resource disk (`MaxResourceVolumeMB=0`). In-place fallback: v5 with resource disk (Dadsv5/Ddsv5/Eadsv5). To reach v7: move the pagefile to C:, snapshot the OS disk and create a new VM from it on a v7 size (not automated).
2. **Gen1 VMs cannot go to v6/v7 in place** (Gen2 only). The tool uses v5 (Gen1-capable). Long-term: Gen1 -> Trusted Launch/Gen2 upgrade or redeploy from a Gen2 image, then v7. Not implemented.
3. **Images without the NVMe tag** (`DiskControllerTypes` lacking NVMe) are warned or blocked by `nvme-image`; the workaround is an NVMe-capable image or a SCSI-capable target. The demo images are all NVMe-capable, so the BLOCK path was not hit live.
4. v7 targets have no SCSI option in swedencentral (`DiskControllerTypes=NVMe` only), so Linux v7 migrations always change the controller.
5. Temp-disk content, dynamic IPs and device names change; accelerated networking is not enabled by the tool.
6. Automatic rollback after a real mid-flight Azure failure was not exercised live.
