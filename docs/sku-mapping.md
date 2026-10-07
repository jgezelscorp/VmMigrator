# SKU mapping reference

Source of truth: `data/sku-mapping.json` (mapping rules) and `data/retirement-series.json` (dates); background in [research.md](research.md). Names are guidance only: the Resource SKUs API is authoritative and the `sku-availability`/`quota` pre-checks verify the chosen target per region/zone.

## How a target is chosen

1. The source series maps to a **group** (table below). Templates use `{vcpu}`, so the vCPU count is kept (`Standard_D2s_v3` -> `Standard_D2as_v7`).
2. Candidates are ordered by generation (v7, then v6, then v5) and, within a generation, by vendor preference (AMD first, then Intel).
3. Entries marked `optional` (v5) are only offered as safe fallbacks for Gen1 or non-NVMe workloads, and for Windows VMs with a temp disk.
4. `tempDisk=true` entries are the `d` sizes; a source that uses a temp disk prefers them. Windows with a temp disk can only move to a temp-disk size, which in practice means v5 (see below).

## Suffix cheat sheet

`a` AMD, no `a` Intel; `s` premium storage; `d` local temp disk (NVMe on v6/v7); `l` low memory (2 GiB/vCPU). No `d` = diskless. v6/v7 are Gen2-only and NVMe-first.

## Source series to group

| Source series | Group | Memory per vCPU |
|---|---|---|
| Dv1, Dsv1, Dv2, Dsv2, Dv3, Dsv3, Bv1 | general-purpose | 4 GiB |
| DSv2-memory, Ev3, Esv3, Amv2, Gv1, Gsv1 | memory-optimized | 8 GiB |
| Fv1, Fsv1, Fsv2 | compute-optimized | 2 GiB |
| Av1, Av2 | basic-av2 | 2 GiB |
| Ls, Lsv2 | storage-optimized | 8 GiB |

## Targets per group (priority order)

| Group | v7 | v6 | v5 (optional fallback) |
|---|---|---|---|
| general-purpose | `D{n}as_v7`, `D{n}ads_v7` (temp), `D{n}s_v7`, `D{n}ds_v7` (temp) | `D{n}as_v6`, `D{n}ads_v6`, `D{n}s_v6`, `D{n}ds_v6` | `D{n}as_v5`, `D{n}ads_v5`, `D{n}s_v5`, `D{n}ds_v5` |
| memory-optimized | `E{n}as_v7`, `E{n}ads_v7`, `E{n}s_v7`, `E{n}ds_v7` | `E{n}as_v6`, `E{n}ads_v6`, `E{n}s_v6`, `E{n}ds_v6` | `E{n}as_v5`, `E{n}ads_v5`, `E{n}s_v5`, `E{n}ds_v5` |
| compute-optimized | `F{n}als_v7`, `F{n}alds_v7` (temp), `F{n}as_v7` (4 GiB), `F{n}ads_v7` (temp, 4 GiB) | `D{n}als_v6`, `D{n}alds_v6`, `D{n}ls_v6`, `D{n}lds_v6` | `D{n}ls_v5`, `D{n}lds_v5` |
| basic-av2 | `D{n}als_v7`, `D{n}ads_v7` | `D{n}als_v6`, `D{n}alds_v6` | `D{n}ls_v5`, `D{n}lds_v5` |
| storage-optimized | `L{n}as_v4` (Lasv4, v6-class), `L{n}s_v3` (Lsv3) | - | - |

All names are `Standard_<name>`. No v7 L-series was confirmed in research; Lasv4/Lsv3 are verified at runtime only.

## Real v7 names (verified on Microsoft Learn, see research.md)

- General purpose AMD: `Standard_D2as_v7` ... `D160as_v7` (Dasv7, 4 GiB/vCPU, no temp disk); `D2ads_v7` ... `D160ads_v7` (Dadsv7, local NVMe temp disk); `D2als_v7` ... `D160als_v7` (Dalsv7, 2 GiB/vCPU). Intel: `Standard_D2s_v7` ... (Dsv7).
- Memory AMD: `Standard_E2as_v7` ... `E160as_v7` (Easv7, 8 GiB/vCPU); `E2ads_v7` ... `E160ads_v7` (Eadsv7).
- Compute AMD (1-80 vCPU): `Standard_F1as_v7` ... `F80as_v7` (Fasv7, 4 GiB/vCPU); `F1als_v7` ... `F80als_v7` (Falsv7, 2 GiB/vCPU).
- Dasv7: Gen2 only, accelerated networking, MANA + NetVSC, NVMe-capable OS images only, **no ephemeral OS disk**.
- Live-verified in swedencentral: `Standard_D2as_v7` and `Standard_F2als_v7` migrations succeeded (NVMe-only controller).

## Rules that override the table

- **Gen1 VM** (or non-NVMe image): v6/v7 are not possible; a v5 size is used (live: `Standard_D2as_v5`, `Standard_D2ls_v5`).
- **Windows with temp disk**: Azure refuses resource-disk <-> diskless resizes, so v6/v7 are BLOCKed and a v5 `d` size is offered (live: `Standard_D2ads_v5`, `Standard_E2ads_v5`).
- **Memory fit**: group ratios keep vCPUs and approximate memory; G/Gs and Amv2 can need a larger E size to match memory. Review the target before migrating (use `targetOverrides`).
- **ADE VMs, ephemeral OS disk on diskless v7**: BLOCK (rebuild).
- Region availability varies (v7 GA started in a limited set of regions in Jan 2026); the SKU API decides.
- Reserved Instance / Savings Plan flexibility is per family: changing families can strand reservations.

## Updating the catalog

Edit `data/sku-mapping.json` (new generation, vendor order, group) and `data/retirement-series.json` (dates). `VMM_DATA_DIR` points the server at another catalog directory. Run `npm test` (catalog tests) afterwards.
