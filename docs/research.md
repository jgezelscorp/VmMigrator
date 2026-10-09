# Research: Azure VM size retirements and resize to v6/v7

_Compiled 2026-10-07 from Microsoft Learn. Fact-checked 2026-10-07 (see "Verification log" at the end): former **[verify]** items are now ✅ (confirmed on a fetched Learn page) or ⚠️ (still unconfirmed). Live `az vm list-skus` against the subscription could not be run (az/MCP calls were denied in the non-interactive session), so regional availability comes from the Azure Updates GA notice (Jan 2026) and must be re-checked per region at runtime._

## 1. Retirement status (as of Learn page updated 2026-09-25)

Source: [VM size series retirements, capacity growth restrictions, and modernization guidance](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/lifecycle/retirements-and-capacity-restrictions)

| Series | Status | Planned retirement |
|---|---|---|
| D, Ds (v1), Dv2, Dsv2 | Announced | 2028-05-01 |
| Ls | Announced | 2028-05-01 |
| Av2/Amv2, B (v1) | Announced | 2028-11-15 |
| F, Fs, Fsv2 | Announced | 2028-11-15 |
| G, Gs | Announced | 2028-11-15 |
| Lsv2 | Announced | 2028-11-15 |
| **Dv3, Dsv3, Ev3, Esv3** | Announced | **2029-11-15** (not Gov/21Vianet/sovereign clouds) |
| NVv3, NVv4 | Announced | 2026-09-30 (already past at time of writing — treat as retired/at-risk) |
| NP, HC, HBv2 | Announced | 2027-05-31 |
| Standard_M192i(d)(m)s_v2 | Announced | 2027-03-31 |
| DCsv2, DCas/ECas_cc_v5 | Retired | 2026-06-30 / 2026-09-01 |

- After the retirement date remaining VMs are **deallocated, stop working, stop incurring charges** and lose SLA/support. Managed disk data is preserved.
- Original **Av1** (Basic_A*/Standard_A0–A11) is already retired (Aug 2024) ⚠️ (not re-confirmed on a fetched page); the tool should still flag any remaining Standard_A* that is not Av2.
- **Capacity growth restrictions since July 2026** for F/Fs/Fsv2, D/Ds/Dv2/Dsv2/Dv3/Dsv3, B/Bs, Av2/Amv2, Ev3/Esv3, G/Gs, Ls/Lsv2: new subscriptions cannot deploy them; existing subscriptions can use only already-approved quota; no additional quota; allocation may fail even within quota. Implication: **resizing back (rollback) is not guaranteed to succeed once a VM is moved off** — snapshot + keep original VM model.

### 1a. Pricing communications (customer email "CXP" and AVD pricing-impact table)

- ~25% increase from 1 Feb 2027 on PAYGO/EA/MCA for v1 (Bv1, D, Ds, F, Fs, G, Gs, Ls, NP, HC) and v2 (Av2, Amv2, Dv2, Dsv2, Fsv2, Lsv2). v3 is not included.
- Existing RIs keep their price until term end, then PAYGO applies (even with auto-renew). Savings plans follow the new VM rates.
- Public cloud (and 21Vianet for the 25%); Sovereign Cloud and Government are exempt.
- AVD table: v1/v2 hosts get the 25% only (no regional uplift); v4/v5/v6 get a regional uplift only when the exact SKU is in scope, never the 25%.
- Not yet verified: the per-SKU regional scope and percentages (source documents are IRM-protected).

## 2. Recommended targets

Source: same page + [Modernize to v6 and v7](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/lifecycle/sizes-v6-v7-modernization-overview)

- Dv3/Dsv3 → Dv5/**Dv6**/**Dv7**; Ev3/Esv3 → Ev5/**Esv6**/**Esv7**.
- Microsoft suggests v5 as the *smoothest* path for existing workloads (still SCSI, Gen1/Gen2); v6/v7 give best performance but require Gen2 + NVMe + MANA-ready image. **Project decision: target v7, fall back to v6 (user requirement); offer v5 as an optional "safe" fallback when image is Gen1 or not NVMe-ready.**
- Families: v6 Intel (Dlsv6, Dsv6, Esv6), v6 AMD (Dalsv6, Dasv6, Easv6), v7 Intel (Dlsv7, Dsv7, Esv7; Xeon 6), v7 AMD (Dasv7, Easv7, Fasv7; EPYC Turin). AMD v7 reached GA ahead of some Intel v7 sizes → verify per region.
- **Real v7 size names (✅ Learn series pages)** — all `Standard_<X><vcpu><suffix>_v7`, vCPU 2…160 unless noted:
  - General purpose AMD: `Standard_D2as_v7`…`D160as_v7` (Dasv7, 4 GiB/vCPU, no temp disk); `Standard_D2ads_v7`…`D160ads_v7` (Dadsv7, local NVMe temp); `Standard_D2als_v7`…`D160als_v7` (Dalsv7, 2 GiB/vCPU, no temp disk). Intel: `Standard_D2s_v7`… (Dsv7, up to 372 vCPU, no temp disk).
  - Memory AMD: `Standard_E2as_v7`…`E160as_v7` (Easv7, 8 GiB/vCPU, no temp disk); `Standard_E2ads_v7`…`E160ads_v7` (Eadsv7, local NVMe temp).
  - Compute AMD (1–80 vCPU): `Standard_F1as_v7`…`F80as_v7` (Fasv7, 4 GiB/vCPU), `Standard_F1als_v7`…`F80als_v7` (Falsv7, 2 GiB/vCPU); also Famsv7, Fadsv7, Faldsv7, Famdsv7 (per Azure Updates).
  - Series facts: Dasv7 page lists **Gen 2 supported / Gen 1 not supported, Accelerated Networking supported, MANA + NetVSC, Premium SSD/SSD v2/Standard, Ephemeral OS disk NOT supported**, and says the series only works on NVMe-capable OS images.
- **Regional availability (⚠️ from Azure Updates GA notice, Jan 2026 — not verified by live `az vm list-skus`)**: Dasv7/Dalsv7/Easv7/Fasv7/Falsv7/Famsv7 GA in Australia East, Central US, Germany West Central, Japan East, North Europe, South Central US, Southeast Asia, UK South, West Europe, West US 2, West US 3; 160-vCPU Easv7/Eadsv7 only North Europe, South Central US, West Europe, West US 2 at GA. More regions were announced for 2026 — always resolve per region via the Resource SKUs API.
- **Not ADE-compatible**: Azure Disk Encryption is **not available on v6/v7** (either OS) and retires 2028-09-15; replacement is encryption at host, which cannot be enabled on a VM that has ever had ADE → rebuild (✅ Learn v6/v7 FAQ). Pre-check must BLOCK ADE VMs.
- Suffix **`d`** (e.g. Ddsv6, Dadsv7) = local NVMe temp disk; without `d` = diskless.
- Learn calls this a *planned upgrade, not a blind in-place resize*: image/driver refresh may be needed.

## 3. What changes at v6/v7 (compatibility checks)

| Area | Requirement | Check |
|---|---|---|
| Boot mode | **Generation 2 (UEFI)** only; Trusted Launch supported/default but optional | `hyperVGeneration == V2` on VM instance view / image |
| Disk controller | **NVMe** (v6/v7 are NVMe-first; many are NVMe-only). Gen1 VMs will never support NVMe | `storageProfile.diskControllerType`; target SKU capability `DiskControllerTypes` |
| OS image | Must be NVMe-capable: Win Server 2019/2022/2025, Win10/11; Ubuntu 18.04–24.04, RHEL 7.9/8.6+/9, SLES 15 SP4+, Debian 11/12, Oracle 7.9/8.5+/9, Alma 8/9, Rocky 8.10/9.6, Azure Linux 3. Older OS has no NVMe driver → not supported. Windows Server 2016 and older **not listed** → BLOCK/WARN | OS publisher/offer/sku or in-guest check |
| Networking | MANA adapter requires current OS + driver; accelerated networking | NIC `enableAcceleratedNetworking`, target SKU capability |
| Temp disk | Only on `d` sizes, presented as NVMe | see §5 |
| Region/zone/quota | Per-family vCPU quota (e.g. `standardDasv7Family`), zone restrictions | Resource SKUs + Usages APIs |
| NVMe IO timeout | Default now 240 s (`nvme_core.io_timeout`; Windows `IoTimeoutValue`); old images use 30 s | warn on old images |
| Shared disks on NVMe | not supported on Windows Server 2019 | block when shared disks + WS2019 |
| Disk assignment | v6 (e.g. Ebsv6): all disks on one controller; v7: multiple controllers (cached incl. OS vs uncached) → device names change; use UUID/GUID | Linux fstab warning |

## 4. SCSI → NVMe resize procedure

Sources: [Resize a VM](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/resize-vm), [Remote NVMe FAQ](https://learn.microsoft.com/en-us/azure/virtual-machines/enable-nvme-remote-faqs), [NVMe FAQ](https://learn.microsoft.com/en-us/azure/virtual-machines/enable-nvme-faqs)

- **You can't resize directly from a SCSI-based VM size to a remote-NVMe VM size** with a plain resize (Learn "Limitations"). The documented path: **stop/deallocate the VM, set `diskControllerType` to `NVMe` and the new size in the same update**, then start. The script is a **community utility, not an officially supported Microsoft tool** (✅ Learn "Convert a VM from SCSI to NVMe in place"): `Azure-NVMe-Conversion.ps1` in `Azure/SAP-on-Azure-Scripts-and-Utilities` → `Azure-NVMe-Utils`, parameters `-ResourceGroupName -VMName -NewControllerType NVMe|SCSI -VMSize -StartVM -FixOperatingSystemSettings -WriteLogfile` (the older `azure-nvme-VM-update.ps1` / `-disk_controller_change_to` / `-vm_size_change_to` names in `NVMe-Preflight-Check` are outdated). Learn says it is for **no-temp-disk source VMs only** (no `d` in the size, e.g. `Standard_D4s_v5`); sources with a temp disk need preview feature `VMTempDiskResizePreview` or the redeploy-from-image path. It does not detect ADE on Linux. Our engine should implement the same ARM operation itself (deallocate → PATCH `diskControllerType` + `hardwareProfile.vmSize` → start). Microsoft's primary recommendation is deploying new v6/v7 VMs in parallel; in-place is the higher-risk option. VM must be deallocated and the target size must support NVMe.
- Image tag check: `az vm image show --urn <URN>` (look for `DiskControllerTypes` including NVMe); Compute Gallery definitions need `--feature DiskControllerTypes=SCSI,NVMe`. Untagged images can still be resized this way if the OS supports NVMe, but not *created* NVMe.
- Data disks detached from SCSI VMs and attached to NVMe VMs convert automatically. Premium SSD v1/v2, Standard SSD/HDD, Ultra are supported on NVMe sizes.
- **Linux guest prep before the switch**: NVMe driver in initramfs (`nvme`, `nvme_core`; dracut/initramfs regenerate), `/etc/fstab` using UUID/LABEL not `/dev/sdX`, no udev rules depending on SCSI names, waagent current (see [SCSI to NVMe for Linux VMs](https://learn.microsoft.com/en-us/azure/virtual-machines/nvme-linux)).
- **Windows guest prep**: NVMe (stornvme) driver present (WS2019+), recent updates, no drive-letter dependence on disk numbers, pagefile off D:.
- Resizing a running VM restarts it; if the new size isn't on the host cluster, deallocation is required. After a failed resize the VM *model* shows the requested size while the VM keeps running on the old one — **post-check must read the actual state, not only the model.** Deallocation releases dynamic IPs (static public IPs/Standard SKU preserve).

## 5. Temp disk vs diskless

Source: [FAQ: sizes with no local temp disk](https://learn.microsoft.com/en-us/azure/virtual-machines/azure-vms-no-temp-disk)

- Traditional sizes (Dv2, Dsv3, Ev3 …) have a local temp disk (D:/`/mnt`); Dasv6/Dasv7 etc. (no `d`) have none; `d` sizes have a local **NVMe** disk.
- Resize between disk ↔ diskless: **supported for Linux; for Windows only disk→disk or diskless→diskless.** Workaround for Windows: move pagefile to C:, snapshot, create new VM from snapshot disk. Error otherwise: *"Unable to resize the VM since changing from resource disk to non-resource disk VM size and vice-versa is not allowed."*
- Anything depending on the resource disk (pagefile, swapfile, scratch data, `/mnt` mounts, waagent `ResourceDisk.Format`) breaks on diskless sizes. **Mapping rule: if the source has a temp disk and the workload uses it (or is Windows), prefer a `d` target (e.g. Ddsv7 / Dadsv7); otherwise diskless.** Contents of temp disk are lost on deallocate anyway.
- Premium Storage requires an "s" size (e.g. Dsv3 not Dv3). All v6/v7 targets named with `s` support Premium SSD.

## 6. Other pre-checks required by resize (best practice)

- **Availability set**: VMs in an AvSet are pinned to a hardware cluster; resizing to a family not on that cluster requires deallocating *all* VMs in the set. Zonal VMs: target must be offered in that zone.
- **Ephemeral OS disk**: ✅ **Dasv7 (diskless) lists Ephemeral OS Disk as Not Supported** → BLOCK ephemeral-OS VMs for diskless v7 targets; for `d` sizes check the target series' Feature support table. ⚠️ `CacheDisk`/`ResourceDisk` placement specifics are not confirmed.
- **Extensions**: re-check provisioning after resize; monitoring agents etc. may have OS/NVMe constraints. ✅ **ADE is not supported on v6/v7** (and ADE for Linux isn't supported with NVMe) → BLOCK.
- **Backup**: confirm a recent recovery point (Azure Backup) or take our own snapshots. ✅ Gen1→Gen2 in place is possible *only* via the Gen1→Trusted Launch upgrade (MBR2GPT in-guest first, then security-type change); constraints: no rollback except restore from backup, Windows Server 2016 unsupported, Azure Backup Enhanced policy required, OS volume must not be encrypted; Dv2/Dv3 Gen1 VMs cannot be converted (not Trusted Launch-capable families).
- **Spot / capacity reservations / PPG / dedicated hosts**: target family must be allowed on host/reservation.
- **Reserved Instances & Savings Plans**: instance-size-flexibility is per family; moving families may strand RIs (commercial note, not a blocker).

## 7. Proposed SKU mapping rules (v1/v2/v3 → v7, fallback v6)

Default vendor: **AMD (`a`)** targets first (lower cost, Gen2/NVMe, GA earliest) unless the source series is Intel-only by workload need; Intel as alternative. Keep vCPU count; memory ratio from the series (D = 4 GB/vCPU, E = 8 GB/vCPU, F = 2 GB/vCPU, A = 2 GB/vCPU, G = 7.5–8 GB/vCPU, L = 8 GB/vCPU). Premium storage "s" retained (all v6/v7 targets named with `s`).

| Source series | Primary (v7) | Fallback (v6) | Notes |
|---|---|---|---|
| Av2 / Amv2 (A2_v2…) | **Dalsv7** for A*_v2 (2 GB/vCPU); Amv2 is 8 GB/vCPU → **Easv7** (not Dasv7, which is 4 GB/vCPU) | Dalsv6 / Easv6 | Av2 has temp disk; use `Dadsv7` / `Eadsv7` if disk used (a `Daldsv7` is not confirmed — resolve via SKU API) |
| B (v1) | Dasv7 (✅ Basv2 exists on Learn, but v6/v7 NVMe support not confirmed → use Dasv7) | Dasv6 | Different performance model — WARN |
| D, Ds (v1), Dv2, Dsv2 | Dasv7 (D=4 GB/vCPU), `Dadsv7` for temp disk | Dasv6 / Dadsv6 | Dv2/DSv2 are SCSI + may be Gen1 |
| Dv3 / Dsv3 | Dasv7 / Dadsv7 (or Dsv7 Intel) | Dasv6 / Dsv6 | Learn also lists Dv5 as smooth path |
| Ev3 / Esv3 | Easv7 / Eadsv7 (or Esv7) | Easv6 / Esv6 | Learn names Ev5/Esv6/Esv7 |
| F, Fs, Fsv2 | **Falsv7** (2 GB/vCPU, matches F/Fs/Fsv2; ✅ exists, F1–F80) / Fasv7 (4 GB/vCPU, ✅) | Dalsv6 / Dlsv6 | Falsv6 not confirmed → use Dalsv6/Dlsv6 (✅ in Learn v6 table) |
| G, Gs | Easv7 / Esv7 (check memory ratio: G ≈ 7 GB/vCPU, may need M-series or larger E) | Easv6 / Esv6 | Often needs larger vCPU to match memory |
| Ls, Lsv2 | Lasv4 (✅ exists, AMD Genoa; v6-class) / Lasv3 / Lsv3 — **no v7 L-series confirmed** | — | Lasv4 is not GA-verified as NVMe-only; check SKU capabilities |
| NV/NC/H/M | out of scope for v1 (flag only) | | GPU/HPC need specific guides |

**Algorithm:** 1) build the candidate list from the Resource SKUs API (`GET /subscriptions/{id}/providers/Microsoft.Compute/skus?$filter=location eq '{region}'`) rather than hard-coding names; 2) filter family prefix by mapping rule (v7 then v6), same vCPU (±), memory ≥ source; 3) require capabilities `HyperVGenerations` contains V2, `DiskControllerTypes` contains NVMe, accelerated networking, premium IO if needed, temp-disk preference (`d`); 4) drop restricted in region/zone (`restrictions`) and where `Usages` leave < vCPU headroom; 5) rank v7 > v6, AMD > Intel (configurable), lower price; 6) fall back down the list. Names above are guidance, the API is authoritative. Hard-coded names should live in a data file for easy updates.

## 8. Operational recommendations

1. Snapshot all disks (or confirm Backup recovery point) → capture full VM model JSON (rollback source).
2. Deallocate (needed for controller change); record IP config; run migration; start; validate.
3. Wave approach: demo/dev → non-prod → prod; one VM per AvSet/zone at a time.
4. Keep original VM model + snapshots until post-checks pass and owner signs off; remember **capacity restriction means original size may not be re-allocatable** later, so rollback window is realistic only soon after migration.
5. Gen1 VMs: cannot go to v6/v7 in place → options: rebuild from Gen2 image; convert disk via snapshot to Gen2 (Linux/Windows with UEFI-compatible partitioning, `MBR2GPT` on Windows — ✅ this is the documented Gen1→Trusted Launch path); or fall back to v5 Gen1-capable size. Tool flags BLOCK + guidance in v1.

## Verification log (Fact Checker, 2026-10-07)

- ✅ v7 names `D*as_v7`, `D*ads_v7`, `D*als_v7`, `D*s_v7`, `E*as_v7`, `E*ads_v7`, `F*as_v7`, `F*als_v7` exist (Learn series pages).
- ✅ v6/v7 are Gen2-only, NVMe-required, MANA + NetVSC listed, no temp disk unless `d`.
- ✅ ADE unsupported on v6/v7; Gen1→TL upgrade path and its constraints; conversion script is community-supported only.
- ❌ Old script name/params corrected; Fasv7 as F-series primary corrected to Falsv7 (memory ratio); Amv2 → Easv7; "Lasv3/Lsv3 only, v4 verify" → Lasv4 exists.
- ⚠️ Live `az vm list-skus` per region not run (access denied in session); regions above are from Jan 2026 GA notice. Av1 retirement date, Basv2 NVMe support, Intel v7 (Dsv7/Esv7) regions, ephemeral OS placement details remain unconfirmed.

## Sources
- https://learn.microsoft.com/en-us/azure/virtual-machines/migration/scsi-to-nvme-migration
- https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/lifecycle/sizes-v6-v7-modernization-faq
- https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dasv7-series
- https://www.microsoft.com/releasecommunications/api/v2/azure/552318
- https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/lifecycle/retirements-and-capacity-restrictions
- https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/lifecycle/sizes-v6-v7-modernization-overview
- https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/resize-vm
- https://learn.microsoft.com/en-us/azure/virtual-machines/enable-nvme-faqs
- https://learn.microsoft.com/en-us/azure/virtual-machines/enable-nvme-remote-faqs
- https://learn.microsoft.com/en-us/azure/virtual-machines/enable-nvme-interface
- https://learn.microsoft.com/en-us/azure/virtual-machines/azure-vms-no-temp-disk
- https://github.com/Azure/SAP-on-Azure-Scripts-and-Utilities/tree/main/NVMe-Preflight-Check
