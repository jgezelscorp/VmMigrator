# scripts

PowerShell wrappers around the REST API (see [docs/usage.md](../docs/usage.md)):

- `Invoke-VmDiscovery.ps1` – list VMs, `-RetiringOnly`
- `Invoke-VmPreCheck.ps1` – pre-checks, optional `-TargetSku`
- `Invoke-VmMigration.ps1` – `-DryRun`, `-Wait`, `-CleanupSnapshots`, `-GuestProbe`
- `VmmCommon.ps1` – shared helpers (dot-sourced)

Demo deploy/destroy and NVMe preflight scripts are tracked separately.
