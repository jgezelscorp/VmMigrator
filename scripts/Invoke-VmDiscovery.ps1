<#
.SYNOPSIS
Lists Azure VMs and flags those on retiring VM series (via the VmMigrator API).
.EXAMPLE
./scripts/Invoke-VmDiscovery.ps1 -RetiringOnly | Format-Table name, vmSize, retiringSeries, retirementDate
#>
[CmdletBinding()]
param(
    [string]$SubscriptionId,
    [switch]$RetiringOnly,
    [string]$BaseUrl
)
. (Join-Path $PSScriptRoot 'VmmCommon.ps1')

$q = @()
if ($SubscriptionId) { $q += "subscriptionId=$SubscriptionId" }
if ($RetiringOnly) { $q += 'retiring=true' }
$path = '/api/vms' + $(if ($q) { '?' + ($q -join '&') } else { '' })
(Invoke-VmmApi -BaseUrl $BaseUrl -Method GET -Path $path).vms
