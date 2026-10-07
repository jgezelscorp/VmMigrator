# VM-Migrator factory

Detect Azure VMs running on retiring **v1/v2/v3** size series (Av2, Dv2/Dsv2, Dv3/Dsv3, Ev3/Esv3, F/Fs/Fsv2, G/Gs, Ls/Lsv2 …) and migrate them to **v7** (fallback **v6**) SKUs — with every pre-check run first, a controlled resize, post-checks, and a rollback path.

## Vision

1. **Discover** — scan subscriptions/regions for VMs on retiring series (auto-detect) or pick VMs manually.
2. **Pre-check** — SKU availability per region/zone, quota, NVMe vs SCSI controller, Gen1/Gen2 image, temp-disk vs diskless, accelerated networking/MANA, availability sets/zones, ephemeral OS disk, extensions, backups, deallocation requirement.
3. **Migrate** — snapshot/backup, deallocate, switch disk controller & resize, start; automatic rollback on failure.
4. **Post-check** — VM running, agent healthy, disks/NICs/extensions OK, size & controller as expected.
5. **Demo** — Bicep in `/demo` deploys v1/v2/v3 VMs to try it on.

Runs locally with one command, using your existing `az login` (Entra auth is a later phase).

## Status

Planning. See [docs/research.md](docs/research.md), [docs/architecture.md](docs/architecture.md) and the GitHub issues backlog.

## Team

AI squad configured in `.squad/` (see `.squad/team.md`). Owner: Jan G.
