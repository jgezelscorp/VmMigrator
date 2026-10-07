<#
.SYNOPSIS
Starts a VM migration (resize + NVMe when required) through the VmMigrator API.
.DESCRIPTION
-DryRun prints the exact ARM operations without changing anything. -Wait polls until the job
reaches Done, Failed or Restored. The exit code is 0 for Done, 1 for Failed/Restored, 2 when blocked by pre-checks.
.EXAMPLE
./scripts/Invoke-VmMigration.ps1 -VmName vm1 -SubscriptionId <sub> -DryRun
./scripts/Invoke-VmMigration.ps1 -VmName vm1 -SubscriptionId <sub> -TargetSku Standard_D2s_v6 -Wait
#>
[CmdletBinding()]
param(
    [string[]]$VmId,
    [string[]]$VmName,
    [string]$SubscriptionId,
    [string]$TargetSku,
    [switch]$DryRun,
    [switch]$Wait,
    [switch]$CleanupSnapshots,
    [switch]$GuestProbe,
    [int]$PollSeconds = 5,
    [int]$TimeoutMinutes = 90,
    [string]$BaseUrl
)
. (Join-Path $PSScriptRoot 'VmmCommon.ps1')

$ids = @(Resolve-VmmVmIds -BaseUrl $BaseUrl -VmId $VmId -VmName $VmName -SubscriptionId $SubscriptionId)
$overrides = @{}
if ($TargetSku) {
    if ($ids.Count -ne 1) { throw '-TargetSku can only be used with exactly one VM.' }
    $overrides[$ids[0]] = $TargetSku
}
$options = @{}
if ($CleanupSnapshots) { $options.cleanupSnapshots = $true }
if ($GuestProbe) { $options.guestProbe = $true }

try {
    $jobs = (Invoke-VmmApi -BaseUrl $BaseUrl -Method POST -Path '/api/migrations' -Body @{
            vmIds = $ids; dryRun = [bool]$DryRun; targetOverrides = $overrides; options = $options }).jobs
}
catch {
    if ($_.Exception.Message -match 'failed') { Write-Error $_.Exception.Message; $global:LASTEXITCODE = 2; return }
    throw
}

if ($DryRun) {
    foreach ($j in $jobs) {
        Write-Host "DRY RUN $($j.plan.vmName): $($j.plan.sourceSku) -> $($j.plan.targetSku)"
        $j.plan.actions | ForEach-Object { Write-Host ("  {0,-14} {1}" -f $_.step, $_.description) }
    }
    return $jobs
}

if (-not $Wait) { return $jobs }

$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$final = @()
foreach ($j in $jobs) {
    $last = ''
    do {
        $cur = Invoke-VmmApi -BaseUrl $BaseUrl -Method GET -Path "/api/migrations/$($j.id)"
        if ($cur.state -ne $last) { Write-Host "[$($j.plan.vmName)] $($cur.state)"; $last = $cur.state }
        if ($cur.state -in 'Done', 'Failed', 'Restored') { break }
        Start-Sleep -Seconds $PollSeconds
    } while ((Get-Date) -lt $deadline)
    if ($cur.PSObject.Properties['error'] -and $cur.error) { Write-Warning $cur.error }
    $final += $cur
}
$final
if (@($final | Where-Object { $_.state -ne 'Done' }).Count -gt 0) { $global:LASTEXITCODE = 1 }
