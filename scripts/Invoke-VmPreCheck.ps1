<#
.SYNOPSIS
Runs migration pre-checks for VMs and returns the results (PASS/WARN/BLOCK per check).
.EXAMPLE
./scripts/Invoke-VmPreCheck.ps1 -VmName vm1 -SubscriptionId <sub> -TargetSku Standard_D2s_v6
#>
[CmdletBinding()]
param(
    [string[]]$VmId,
    [string[]]$VmName,
    [string]$SubscriptionId,
    # Explicit target for a single VM; otherwise the best viable target is selected
    [string]$TargetSku,
    [ValidateSet('InPlace', 'Rebuild')][string]$Strategy = 'InPlace',
    [string]$BaseUrl
)
. (Join-Path $PSScriptRoot 'VmmCommon.ps1')

$ids = @(Resolve-VmmVmIds -BaseUrl $BaseUrl -VmId $VmId -VmName $VmName -SubscriptionId $SubscriptionId)
$overrides = @{}
if ($TargetSku) {
    if ($ids.Count -ne 1) { throw '-TargetSku can only be used with exactly one VM.' }
    $overrides[$ids[0]] = $TargetSku
}
$body = @{ vmIds = $ids; targetOverrides = $overrides }
if ($Strategy -eq 'Rebuild') { $body.strategy = 'rebuild' }
$res = (Invoke-VmmApi -BaseUrl $BaseUrl -Method POST -Path '/api/vms/precheck' -Body $body).results
$res
if (@($res | Where-Object { $_.overall -eq 'BLOCK' }).Count -gt 0) { $global:LASTEXITCODE = 2 }
